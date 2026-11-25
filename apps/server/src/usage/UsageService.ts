/**
 * UsageService - reads every driver's usage history and returns priced usage
 * buckets.
 *
 * Each built-in driver with a `usage` reader contributes its sources, including
 * work driven outside SSHCode. A `transcripts` reader names JSONL directories
 * that this service streams itself; a `scan` reader reads its own sources.
 *
 * JSONL transcripts are append-only, so parsed records are memoised per file by
 * `(size, mtime)`. A cold 30-day scan of ~1.4 GB lands around 2-3 seconds; warm
 * scans only reparse files that changed, and a file that merely grew resumes
 * from its cached parse position so only the appended bytes are read.
 *
 * A scan reader with a slow source (an account API) may answer from its own
 * cache and mark itself `refreshing` while a background refresh runs;
 * `awaitRefresh` waits for that refresh instead.
 *
 * @module UsageService
 */
import * as NodeOS from "node:os";
import { lock } from "proper-lockfile";

import {
  type ProviderInstanceConfig,
  ProviderInstanceId,
  USAGE_CONTRACT_VERSION,
  type ServerSettings as ServerSettingsValue,
  type UsageProviderKind,
  type UsageSource,
  type UsagePricing,
  type UsageSummary,
  type UsageSummaryInput,
  UsageReadError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Cache from "effect/Cache";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { HttpClient, HttpClientResponse } from "effect/http";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { BUILT_IN_USAGE_DRIVERS, type BuiltInUsageReadersEnv } from "../provider/builtInDrivers.ts";
import type { ProviderDriver } from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import type {
  ProviderUsageInstance,
  TranscriptUsageFormat,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import { claudeUsageFormat } from "../provider/Drivers/claudeUsage.ts";
import { resolveModelAliases, UsageAggregator } from "./usageAggregation.ts";
import { createUsageAttribution, type UsageAccountBinding } from "./usageAttribution.ts";
import { claudeSidechain } from "./usageSessionDetails.ts";
import {
  createOverrideRateTable,
  isUnlistedModel,
  parseRateTable,
  type RateTable,
} from "./usagePricing.ts";
import {
  isCompressedTranscript,
  listTranscriptFiles,
  readDirectoryVolumeId,
  readTranscriptRecords,
  readZstdContentSize,
} from "./usageTranscriptReader.ts";
import {
  decodeScanCache,
  dedupeWithinFile,
  LEGACY_SCAN_CACHE_FILE_NAMES,
  makeScanCacheWriter,
  pruneScanCache,
  SCAN_CACHE_FILE_NAME,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";
import type { ThreadUsageSource } from "./threadUsageAggregation.ts";

const LITELLM_RATES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

/** Rates move rarely; a day-old table keeps the page working offline. */
const RATES_TTL_MS = 24 * 60 * 60 * 1000;

/** An explicit refresh ignores the TTL, but not a table fetched this recently. */
const RATES_REFRESH_FLOOR_MS = 60 * 1000;

/**
 * Files are filtered by mtime before opening. The slack covers a session whose
 * last write lands just before local midnight on the window's first day.
 */
const MTIME_SLACK_MS = 36 * 60 * 60 * 1000;
const MAX_HOURLY_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The longest window the UI offers, 90 days, plus its `MTIME_SLACK_MS`, rounded
 * up. Older entries are pruned.
 */
const CACHE_RETENTION_DAYS = 92;
/** How long a chat-usage corpus answers without a new scan. */
export const THREAD_RECORDS_FRESH_MS = 3 * 60_000;
/** Past this age a corpus is not shown while its refresh runs. */
export const THREAD_RECORDS_MAX_STALE_MS = 30 * 60_000;

/** Transcripts parsed at once. More gains little once the disk stays busy. */
const TRANSCRIPT_READ_CONCURRENCY = 4;
/** Transcript directories walked at once; file parses still share `TRANSCRIPT_READ_CONCURRENCY`. */
const TRANSCRIPT_DIR_CONCURRENCY = 4;
/**
 * Kimi stores transcripts only in `<workspace>/<session>/wire.jsonl` and
 * `<workspace>/<session>/agents/<agent>/wire.jsonl`. Skipping its auxiliary
 * session subdirectories avoids thousands of empty `readdir` calls per scan.
 */
const KIMI_SKIP_DIR_NAMES: ReadonlySet<string> = new Set([
  ".index-cache",
  ".index-dirty",
  "blobs",
  "file-history",
  "logs",
  "notifications",
  "notify",
  "tasks",
  "tool-results",
]);

/** The transcript readers, in driver order. */
const transcriptReaders = BUILT_IN_USAGE_DRIVERS.flatMap((driver) =>
  driver.usage?.kind === "transcripts" ? [{ driver, reader: driver.usage }] : [],
);

/** The scan readers, in driver order. */
const scanReaders = BUILT_IN_USAGE_DRIVERS.flatMap((driver) =>
  driver.usage?.kind === "scan" ? [{ driver, reader: driver.usage }] : [],
);

/** Transcript formats by provider, for decoding the persisted scan cache. */
const transcriptFormats = new Map(
  transcriptReaders.map(({ reader }) => [reader.provider, reader.format] as const),
);

/** One transcript directory to scan. */
interface TranscriptSource {
  readonly instanceIds: ProviderInstanceId[];
  readonly instanceId?: string;
  readonly displayName?: string;
  readonly provider: UsageProviderKind;
  readonly format: TranscriptUsageFormat<unknown>;
  readonly dir: string;
  readonly volumeId: string;
  readonly fileName?: string;
}

/** On-disk shape of the rate snapshot. */
const RatesCacheFile = Schema.Struct({
  fetchedAtMs: Schema.Number,
  document: Schema.Unknown,
});
const decodeRatesCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);
const encodeRatesCache = Schema.encodeEffect(
  Schema.fromJsonString(RatesCacheFile as unknown as Schema.Codec<typeof RatesCacheFile.Type>),
);

/** The scan cache is narrowed by hand in `usageScanCache`, so JSON is enough here. */
const ScanCacheJson = Schema.fromJsonString(Schema.Unknown as unknown as Schema.Codec<unknown>);
const decodeScanCacheFile = Schema.decodeUnknownEffect(ScanCacheJson);
const encodeUsageRecordKey = Schema.encodeSync(ScanCacheJson);
const CachedSource = Schema.Struct({ dir: Schema.String, volumeId: Schema.String });

/** Whether `a` read a later state of its file than `b`. Transcripts only grow. */
function isLaterRead(a: CachedFile, b: CachedFile): boolean {
  return a.mtimeMs > b.mtimeMs || (a.mtimeMs === b.mtimeMs && a.size > b.size);
}

function missingUsageRecords(previous: readonly UsageRecord[], fresh: readonly UsageRecord[]) {
  const keys = new Set(
    fresh.flatMap((record) => (record.dedupeKey === null ? [] : [record.dedupeKey])),
  );
  return previous.filter((record) => record.dedupeKey !== null && !keys.has(record.dedupeKey));
}

/**
 * Cached paths by the file identity their provider's format names, keyed with
 * the provider so two formats' identities cannot collide.
 */
function cachedPathsByIdentity(cache: ScanCache): Map<string, string[]> {
  const paths = new Map<string, string[]>();
  for (const [filePath, entry] of cache) {
    const identity = transcriptFormats.get(entry.provider)?.fileIdentity?.(filePath);
    if (identity === undefined) continue;
    const key = entry.provider + "\0" + identity;
    const existing = paths.get(key);
    if (existing === undefined) paths.set(key, [filePath]);
    else existing.push(filePath);
  }
  return paths;
}

/** Providers whose format lets one session's records appear in several files. */
const sharedSessionProviders: ReadonlySet<UsageProviderKind> = new Set(
  transcriptReaders.flatMap(({ reader }) =>
    reader.format.sharedSessionsAcrossFiles ? [reader.provider] : [],
  ),
);

/**
 * Sessions of `sharedSessionProviders` with records in more than one file,
 * such as a rollout that moved after it was read. Only these need cross-file
 * dedupe keys: within one file the occurrence count already keeps every key
 * unique, so keying the rest would only build and hash a string for each of
 * their records.
 */
function sharedSessions(
  files: readonly { readonly records: readonly UsageRecord[] }[],
): ReadonlySet<string> {
  const firstFile = new Map<string, number>();
  const shared = new Set<string>();
  for (const [index, file] of files.entries()) {
    let previous = "";
    for (const { provider, sessionId } of file.records) {
      if (!sharedSessionProviders.has(provider) || sessionId === previous || sessionId.length === 0)
        continue;
      previous = sessionId;
      const first = firstFile.get(sessionId);
      if (first === undefined) firstFile.set(sessionId, index);
      else if (first !== index) shared.add(sessionId);
    }
  }
  return shared;
}
const decodeCachedSources = Schema.decodeUnknownOption(
  Schema.Struct({ sources: Schema.Record(Schema.String, CachedSource) }),
);

export class UsageService extends Context.Service<
  UsageService,
  {
    readonly readSummary: (input: UsageSummaryInput) => Effect.Effect<UsageSummary, UsageReadError>;
    readonly readThreadRecords: Effect.Effect<
      {
        readonly sources: readonly ThreadUsageSource[];
        readonly rates: RateTable;
        readonly priceOverrides: RateTable;
        readonly modelAliases: ReadonlyMap<string, string>;
        readonly partial: boolean;
      },
      UsageReadError
    >;
    /** Refetches the rate table ahead of its TTL. See `ensureRates`. */
    readonly refreshRates: Effect.Effect<UsagePricing>;
  }
>()("t3/usage/UsageService") {}

const EMPTY_PRICING: UsagePricing = {
  status: "unavailable",
  source: LITELLM_RATES_URL,
  fetchedAt: null,
  knownModels: 0,
};

/** Empty summary, for suites that only need the RPC surface to resolve. */
const layerTest = Layer.succeed(
  UsageService,
  UsageService.of({
    readSummary: (input) =>
      Effect.succeed({
        contractVersion: USAGE_CONTRACT_VERSION,
        readAt: "1970-01-01T00:00:00.000Z",
        timeZone: input.timeZone,
        sinceDay: input.sinceDay,
        untilDay: input.untilDay,
        buckets: [],
        sources: [],
        pricing: EMPTY_PRICING,
        scanDurationMs: 0,
      }),
    refreshRates: Effect.succeed(EMPTY_PRICING),
    readThreadRecords: Effect.succeed({
      sources: [],
      rates: new Map(),
      priceOverrides: new Map(),
      modelAliases: new Map(),
      partial: false,
    }),
  }),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const httpClient = yield* HttpClient.HttpClient;
  const sql = yield* SqlClient.SqlClient;
  const hostEnvironment = yield* HostProcess.Environment;
  // The readers yield their own services; scans run them against this context.
  const readerContext = yield* Effect.context<BuiltInUsageReadersEnv>();

  const fileCache: ScanCache = new Map();
  const sourceCache = new Map<string, typeof CachedSource.Type>();
  let cacheDirty = false;
  const isWithinDirectory = (filePath: string, dir: string) => {
    const relative = path.relative(dir, filePath);
    return relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
  };

  const ratesCachePath = path.join(config.stateDir, "usage-model-rates.json");
  const scanCachePath = path.join(config.stateDir, SCAN_CACHE_FILE_NAME);
  const legacyScanCachePaths = LEGACY_SCAN_CACHE_FILE_NAMES.map((name) =>
    path.join(config.stateDir, name),
  );
  const writeCacheFile = (filePath: string, contents: string) =>
    writeFileStringAtomically({ filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
  let rates: RateTable = new Map();
  let ratesFetchedAtMs: number | null = null;
  let ratesStatus: UsagePricing["status"] = "unavailable";
  // One fetch at a time. A burst of refreshes from several clients waits on
  // the first fetch and then sees a table young enough to skip its own.
  const ratesLock = yield* Semaphore.make(1);

  const pricing = (): UsagePricing => ({
    status: ratesStatus,
    source: LITELLM_RATES_URL,
    fetchedAt:
      ratesFetchedAtMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(ratesFetchedAtMs)),
    knownModels: rates.size,
  });

  /**
   * Loads the LiteLLM rate table, preferring a fresh copy and falling back to
   * the on-disk snapshot. With neither, every model reports as unpriced rather
   * than the page failing. `force` refetches inside the TTL so a model that
   * LiteLLM added since the last fetch gets priced now.
   */
  const loadRates = Effect.fn("UsageService.loadRates")(function* (force: boolean) {
    const now = yield* Clock.currentTimeMillis;
    const maxAgeMs = force ? RATES_REFRESH_FLOOR_MS : RATES_TTL_MS;
    if (ratesFetchedAtMs !== null && now - ratesFetchedAtMs < maxAgeMs) return;

    if (ratesFetchedAtMs === null) {
      const fromDisk = yield* fileSystem.readFileString(ratesCachePath).pipe(
        Effect.flatMap((raw) => decodeRatesCache(raw)),
        Effect.catchCause(() => Effect.succeed(null)),
      );
      if (fromDisk !== null) {
        const parsed = parseRateTable(fromDisk.document);
        if (parsed.size > 0) {
          rates = parsed;
          ratesFetchedAtMs = fromDisk.fetchedAtMs;
          ratesStatus = "cached";
          if (now - fromDisk.fetchedAtMs < maxAgeMs) return;
        }
      }
    }

    const fetched = yield* httpClient.get(LITELLM_RATES_URL).pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap((response) => response.json),
      Effect.timeout(10_000),
      Effect.catchCause(() => Effect.succeed(null)),
    );
    if (fetched === null) {
      // The refresh failed; whatever we are serving is now past its TTL and
      // must not keep claiming to be fresh.
      if (rates.size > 0) ratesStatus = "cached";
      return;
    }

    const parsed = parseRateTable(fetched);
    if (parsed.size === 0) return;

    rates = parsed;
    ratesFetchedAtMs = now;
    ratesStatus = "fresh";

    yield* encodeRatesCache({ fetchedAtMs: now, document: fetched }).pipe(
      Effect.flatMap((contents) => writeCacheFile(ratesCachePath, contents)),
      Effect.ignoreCause,
    );
  });

  const ensureRates = (force: boolean) => ratesLock.withPermit(loadRates(force));

  // Rates are kept for RATES_TTL_MS, so a model released after the table was fetched would stay unpriced
  // that long. A scan that meets a model the table does not list refetches early: once per model against
  // a fresh table, at most once per RATES_REFRESH_FLOOR_MS so an offline server does not refetch every
  // scan. Without any table, the scan's own load already retried.
  const checkedUnlistedModels = new Set<string>();
  let unlistedRefreshAtMs: number | null = null;
  const refreshForUnlistedModels = Effect.fn("UsageService.refreshForUnlistedModels")(function* (
    models: ReadonlySet<string>,
  ) {
    if (ratesFetchedAtMs === null) return;
    const unlisted = [...models].filter(
      (model) => !checkedUnlistedModels.has(model) && isUnlistedModel(rates, model),
    );
    if (unlisted.length === 0) return;
    const startedAtMs = yield* Clock.currentTimeMillis;
    if (unlistedRefreshAtMs !== null && startedAtMs - unlistedRefreshAtMs < RATES_REFRESH_FLOOR_MS)
      return;
    unlistedRefreshAtMs = startedAtMs;
    yield* ensureRates(true);
    const now = yield* Clock.currentTimeMillis;
    // A failed fetch leaves the models unchecked, so a later scan tries again.
    if (ratesFetchedAtMs === null || now - ratesFetchedAtMs >= RATES_REFRESH_FLOOR_MS) return;
    for (const model of unlisted) checkedUnlistedModels.add(model);
  });

  const refreshRates = ensureRates(true).pipe(
    Effect.map(pricing),
    Effect.withSpan("UsageService.refreshRates"),
  );

  // A settings failure must not silently discard custom rates or transcript homes.
  const readSettings = settingsService.getSettings.pipe(
    Effect.catchCause(
      (cause) =>
        new UsageReadError({
          reason: "scanFailed",
          detail: "Server settings could not be read.",
          cause: Cause.squash(cause),
        }),
    ),
  );

  /**
   * Every instance of `driver` with its decoded config, or none when it does
   * not decode. Disabled accounts still have history. An unconfigured default
   * slot runs with default config, just as it does in the provider registry.
   */
  const usageInstances = Effect.fn("UsageService.usageInstances")(function* <Config>(
    driver: ProviderDriver<Config, unknown, unknown>,
    settings: ServerSettingsValue,
  ) {
    const entries: Array<
      readonly [ProviderInstanceId, Pick<ProviderInstanceConfig, "config" | "environment">, boolean]
    > = Object.entries(settings.providerInstances)
      .filter(([, instance]) => instance.driver === driver.driverKind)
      .map(([id, instance]) => [ProviderInstanceId.make(id), instance, true] as const);
    if (!Object.hasOwn(settings.providerInstances, driver.driverKind)) {
      entries.push([ProviderInstanceId.make(driver.driverKind), {}, false]);
    }
    const decodeConfig = Schema.decodeUnknownOption(driver.configSchema);
    return yield* Effect.forEach(
      entries,
      Effect.fnUntraced(function* ([instanceId, instance, configured]) {
        const instanceConfig: ProviderUsageInstance<Config> = {
          instanceId,
          ...(settings.providerInstances[instanceId]?.displayName
            ? { displayName: settings.providerInstances[instanceId].displayName }
            : {}),
          config: Option.getOrUndefined(decodeConfig(instance.config ?? {})),
          environment: yield* mergeProviderInstanceEnvironment(
            instance.environment,
            hostEnvironment,
          ),
          configured,
        };
        return instanceConfig;
      }),
    );
  });

  /** Resolves every transcript directory the usage readers point at. */
  const resolveTranscriptDirs = Effect.fn("UsageService.resolveTranscriptDirs")(function* (
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
  ) {
    const warmDir = path.join(config.stateDir, "claude-keep-warm");
    const dirs: Array<TranscriptSource> = [];
    if (
      (yield* fileSystem.exists(warmDir).pipe(Effect.orElseSucceed(() => false))) ||
      [...fileCache.keys()].some((file) => isWithinDirectory(file, warmDir))
    ) {
      dirs.push({
        provider: "claude",
        instanceIds: [],
        displayName: "Claude keep-warm",
        format: claudeUsageFormat,
        dir: warmDir,
        volumeId: yield* Effect.promise(() => readDirectoryVolumeId(warmDir)),
        fileName: "usage.jsonl",
      });
    }
    const seen = new Map<string, TranscriptSource>();
    for (const { driver, reader } of transcriptReaders) {
      const { provider, format } = reader;
      const directories = yield* Effect.forEach(
        yield* usageInstances(driver, settings),
        (instance) =>
          reader.directories(instance).pipe(
            Effect.map((directories) =>
              directories.map((directory) => ({
                ...directory,
                instanceId: instance.instanceId,
                displayName: instance.displayName ?? driver.metadata.displayName,
              })),
            ),
          ),
      );
      for (const { dir: directory, fileName, instanceId, displayName } of directories.flat()) {
        const sourceKey = provider + "\0" + directory;
        const previous = sourceCache.get(sourceKey);
        // Keep canonical paths and source fingerprints stable after root cleanup,
        // including aliases and clients merging pre-cleanup environment summaries.
        const dir = yield* fileSystem
          .realPath(directory)
          .pipe(Effect.orElseSucceed(() => previous?.dir ?? directory));
        const currentVolumeId = yield* Effect.promise(() => readDirectoryVolumeId(dir));
        const hasRetainedHistory = fileCache
          .entries()
          .some(
            ([filePath, entry]) =>
              entry.provider === provider &&
              entry.mtimeMs >= retentionCutoffMs &&
              entry.records.length + entry.tailRecords.length > 0 &&
              isWithinDirectory(filePath, dir),
          );
        // A recreated directory still reports the retained history under its old identity.
        const volumeId =
          previous?.dir === dir && (hasRetainedHistory || !currentVolumeId)
            ? previous.volumeId || currentVolumeId
            : currentVolumeId;
        if (previous?.dir !== dir || previous.volumeId !== volumeId) {
          sourceCache.set(sourceKey, { dir, volumeId });
          cacheDirty = true;
        }
        const key = `${provider}\0${dir}`;
        const shared = seen.get(key);
        if (shared) {
          shared.instanceIds.push(instanceId);
          continue;
        }
        const source: TranscriptSource = {
          instanceIds: [instanceId],
          instanceId,
          displayName,
          provider,
          format,
          dir,
          volumeId,
          ...(fileName === undefined ? {} : { fileName }),
        };
        seen.set(key, source);
        dirs.push(source);
      }
    }
    return dirs;
  });

  /**
   * Loads the persisted scan cache exactly once per process.
   *
   * `Effect.cached` makes concurrent first readers await the same load rather
   * than each seeing a "loaded" flag set before the read finished and cold
   * scanning against an empty cache.
   */
  const ensureScanCacheLoaded = yield* Effect.cached(
    Effect.gen(function* () {
      const readDocument = (filePath: string) =>
        fileSystem.readFileString(filePath).pipe(
          Effect.flatMap((raw) => decodeScanCacheFile(raw)),
          Effect.catchCause(() => Effect.succeed(null)),
        );
      let document = yield* readDocument(scanCachePath);
      if (document === null) {
        for (const legacyPath of legacyScanCachePaths) {
          document = yield* readDocument(legacyPath);
          if (document !== null) break;
        }
        // Write the migrated cache to its own file on the next scan.
        cacheDirty = document !== null;
      }
      if (document === null) return;
      for (const [path, entry] of decodeScanCache(document, transcriptFormats)) {
        fileCache.set(path, entry);
      }
      const sources = decodeCachedSources(document);
      if (Option.isSome(sources)) {
        for (const [key, source] of Object.entries(sources.value.sources))
          sourceCache.set(key, source);
      }
    }),
  );

  const writeScanCache = makeScanCacheWriter();
  // Scans with different windows can finish together; serializing the writes
  // keeps an older snapshot from landing after a newer one.
  const persistLock = yield* Semaphore.make(1);

  const mergePersistedCache = Effect.gen(function* () {
    // Do not overwrite saved history after a transient read failure. A corrupt
    // document can still be replaced by the current instance's valid snapshot.
    const raw = yield* fileSystem.readFileString(scanCachePath).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.succeed(null),
      ),
    );
    if (raw === null) return;
    const document = yield* decodeScanCacheFile(raw).pipe(Effect.orElseSucceed(() => null));
    const heldIdentities = cachedPathsByIdentity(fileCache);
    for (const [filePath, entry] of decodeScanCache(document, transcriptFormats)) {
      const current = fileCache.get(filePath);
      if (current === undefined) {
        // A transcript that moved continues under its new path here. The saved
        // copy at its old path must not return beside it as deleted history.
        const identity = transcriptFormats.get(entry.provider)?.fileIdentity?.(filePath);
        if (identity !== undefined && heldIdentities.has(entry.provider + "\0" + identity))
          continue;
        fileCache.set(filePath, entry);
      } else if (current.provider === entry.provider) {
        const [newer, older] = isLaterRead(entry, current) ? [entry, current] : [current, entry];
        const missing = missingUsageRecords(older.records, [
          ...newer.records,
          ...newer.tailRecords,
        ]);
        fileCache.set(
          filePath,
          missing.length === 0
            ? newer
            : {
                ...newer,
                records: [...missing, ...newer.records],
              },
        );
      }
    }
    const sources = decodeCachedSources(document);
    if (Option.isSome(sources)) {
      for (const [key, source] of Object.entries(sources.value.sources))
        if (!sourceCache.has(key)) sourceCache.set(key, source);
    }
    const now = yield* Clock.currentTimeMillis;
    pruneScanCache(fileCache, now - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  });

  // The dirty flag is cleared before encoding, so a change while the write is
  // in flight marks it dirty again. A failed write restores the flag, so the
  // next persist retries instead of leaving disk stale. A cache we cannot
  // write is a slower next start, not a failed read.
  const persistCaches = Effect.gen(function* () {
    if (cacheDirty) {
      cacheDirty = false;
      let compromised = false;
      yield* Effect.acquireUseRelease(
        Effect.tryPromise(() =>
          lock(scanCachePath, {
            realpath: false,
            retries: { retries: 40, factor: 1, minTimeout: 25, maxTimeout: 25 },
            onCompromised: () => {
              compromised = true;
            },
          }),
        ),
        () =>
          Effect.gen(function* () {
            // Servers sharing this home must merge under the same filesystem lock;
            // a process-local semaphore cannot prevent stale snapshots losing data.
            yield* mergePersistedCache;
            const contents = writeScanCache(fileCache, {
              sources: Object.fromEntries(sourceCache),
            });
            if (compromised) {
              cacheDirty = true;
              return;
            }
            yield* writeCacheFile(scanCachePath, contents);
          }),
        (release) => Effect.promise(() => release()).pipe(Effect.ignore),
      ).pipe(
        Effect.catchCause(() =>
          Effect.sync(() => {
            cacheDirty = true;
          }),
        ),
      );
    }
  }).pipe(persistLock.withPermit, Effect.withSpan("UsageService.persistCaches"));

  const pendingPersists = new Set<Fiber.Fiber<void>>();
  /** Writes dirty caches in the background, after the summary that dirtied them answers. */
  const schedulePersist = Effect.forkDetach(persistCaches).pipe(
    Effect.map((fiber) => {
      pendingPersists.add(fiber);
      fiber.addObserver(() => pendingPersists.delete(fiber));
    }),
  );
  /** Waits for every write scheduled so far, as a restart would need. */
  const awaitPersisted = Effect.suspend(() => Fiber.awaitAll([...pendingPersists])).pipe(
    Effect.asVoid,
  );
  // A write still running when the service shuts down finishes first, so the
  // next start does not lose the last scan.
  yield* Effect.addFinalizer(() => awaitPersisted);

  /**
   * Parses one transcript, reusing the cached result when it is unchanged.
   *
   * A file that only grew re-parses from the cached position, so an actively
   * written multi-hundred-megabyte rollout costs its appended bytes per scan
   * rather than a full re-read. The reader verifies the position's guard bytes
   * and silently restarts from byte 0 when they no longer match.
   *
   * A fresh parse comes back as `update` for the caller to cache, with the
   * entry it was built from. Reads run concurrently, and the caller stores
   * updates in walk order rather than completion order: saved records of
   * deleted transcripts aggregate in cache order, where the first copy of a
   * duplicate wins.
   *
   * `movedFrom` is the saved parse of this file at its previous path. It
   * stands in for this path's own entry: an unchanged move only re-keys it, a
   * grown one resumes from it, and anything else re-parses this file whole.
   * The update names it so the caller drops the old path.
   */
  const readFileRecords = (
    filePath: string,
    size: number,
    mtimeMs: number,
    provider: UsageProviderKind,
    format: TranscriptUsageFormat<unknown>,
    movedFrom?: { readonly path: string; readonly entry: CachedFile },
  ): Effect.Effect<{
    readonly records: readonly UsageRecord[];
    readonly failed?: true;
    readonly update?: {
      readonly entry: CachedFile;
      readonly replaces: CachedFile | undefined;
      readonly movedFrom?: { readonly path: string; readonly entry: CachedFile };
    };
  }> =>
    Effect.gen(function* () {
      const own = fileCache.get(filePath);
      const cached = own ?? movedFrom?.entry;
      const captureSessionDetails = provider === "claude" || provider === "codex";
      const savedRecords = (entry: CachedFile) =>
        entry.tailRecords.length === 0
          ? entry.records
          : dedupeWithinFile([...entry.records, ...entry.tailRecords]);
      const moved = own === undefined && movedFrom !== undefined ? { movedFrom } : {};
      // Provider is part of the identity: if both providers were ever pointed
      // at one directory, a hit parsed by the other parser must not be reused.
      if (
        cached &&
        cached.mtimeMs === mtimeMs &&
        cached.provider === provider &&
        (!captureSessionDetails || cached.details !== undefined)
      ) {
        if (cached.size === size) {
          return {
            records: savedRecords(cached),
            ...(own === undefined ? { update: { entry: cached, replaces: own, ...moved } } : {}),
          };
        }
        // Compression keeps the mtime, and the frame declares the plain size:
        // together they show the archive holds exactly the bytes already read.
        if (
          own === undefined &&
          movedFrom !== undefined &&
          isCompressedTranscript(filePath) &&
          !isCompressedTranscript(movedFrom.path) &&
          (yield* Effect.promise(() => readZstdContentSize(filePath))) === cached.size
        ) {
          return {
            records: savedRecords(cached),
            update: { entry: { ...cached, size }, replaces: own, ...moved },
          };
        }
      }

      // Only a strictly grown file may resume. Same size with a new mtime, or
      // a shrunken file, means rewritten content; re-parse it whole.
      const resumeFrom =
        cached !== undefined &&
        cached.provider === provider &&
        size > cached.size &&
        (!captureSessionDetails || cached.details !== undefined)
          ? cached.position
          : undefined;

      const parsed = yield* Effect.promise(() =>
        readTranscriptRecords(filePath, format, resumeFrom, { captureSessionDetails }),
      );
      // A read failure is not an empty transcript: caching it under this
      // (size, mtime) would silently drop the file's usage until it changes.
      // A moved file's saved usage still counts from its old path meanwhile.
      if (parsed === null)
        return {
          records:
            own?.provider === provider
              ? dedupeWithinFile([...own.records, ...own.tailRecords])
              : [],
          failed: true,
        };

      // Stored already de-duplicated within the file, which is 99% of all
      // duplicates. The aggregator still runs the cross-file dedupe pass. This
      // pass combines the cached base and new lines, extending split timings.
      // The unfinished tail stays separate so it cannot mutate the saved base.
      // Cleanup can rewrite a Claude transcript in place, removing old exchanges.
      // Keep already-billed records with stable ids just as we do for deleted files.
      // Fresh rows win for ids still present (including an unfinished tail). Unkeyed
      // rows cannot be merged safely: an equal row may be a distinct billed event.
      const base =
        cached?.provider !== provider
          ? []
          : parsed.resumed
            ? cached.records
            : missingUsageRecords(cached.records, [...parsed.records, ...parsed.tailRecords]);
      const records = dedupeWithinFile([...base, ...parsed.records]);
      const tailRecords = dedupeWithinFile(parsed.tailRecords);
      const detailRows = new Map<string, (typeof parsed.details)[number]>();
      for (const detail of [
        ...(cached?.provider === provider ? (cached.details ?? []) : []),
        ...parsed.details,
      ]) {
        const key = encodeUsageRecordKey([
          detail.kind,
          detail.sessionId,
          detail.kind === "compaction" ? detail.timestampMs : detail.parentSessionId,
        ]);
        detailRows.set(key, detail);
      }
      const details = [...detailRows.values()];

      return {
        records:
          tailRecords.length === 0 ? records : dedupeWithinFile([...records, ...tailRecords]),
        update: {
          entry: {
            size,
            mtimeMs,
            provider,
            records,
            tailRecords,
            details,
            tailDetails: parsed.tailDetails,
            position: parsed.position,
          },
          replaces: own,
          ...moved,
        },
      };
    });

  /** One provider directory's walk and parse, before rates are involved. */
  interface ScannedDir {
    readonly instanceIds?: readonly ProviderInstanceId[];
    readonly instanceId?: string;
    readonly displayName?: string;
    readonly provider: UsageProviderKind;
    readonly dir: string;
    readonly volumeId: string;
    readonly hostId?: string;
    readonly status?: UsageSource["status"];
    readonly message?: string;
    readonly action?: UsageSource["action"];
    /** Parsed records per file, or `null` when the directory does not exist. */
    readonly files:
      | readonly { readonly path: string; readonly records: readonly UsageRecord[] }[]
      | null;
    /** Answered from a cache while a refresh runs. */
    readonly refreshing?: true;
  }

  const scanTranscriptDir = Effect.fn("UsageService.scanTranscriptDir")(function* (
    source: TranscriptSource,
    windowStartMs: number,
    retentionCutoffMs: number,
    readSemaphore: Semaphore.Semaphore,
  ) {
    const { provider, format, dir, volumeId, fileName, instanceId, displayName } = source;
    const identity = {
      instanceIds: source.instanceIds,
      ...(instanceId ? { instanceId } : {}),
      ...(displayName ? { displayName } : {}),
    };
    const exists = yield* fileSystem
      .exists(dir)
      .pipe(Effect.catchCause(() => Effect.succeed(false)));
    if (!exists) return { ...identity, provider, dir, volumeId, files: null } satisfies ScannedDir;
    // Compressed transcripts are finished ones. Past the retention their
    // entries are pruned, so a window reaching further back (chat usage reads
    // from 0) would decompress every old archive again on each scan.
    const { files, failedPaths } = yield* Effect.promise(() =>
      listTranscriptFiles(dir, windowStartMs, {
        compressedSinceMs: retentionCutoffMs,
        ...(fileName === undefined ? {} : { fileName }),
        ...(provider === "kimi"
          ? { skipDirectory: (name, depth) => depth === 3 && KIMI_SKIP_DIR_NAMES.has(name) }
          : {}),
      }),
    );
    let identities: Map<string, string[]> | undefined;
    /**
     * The saved parse a file without its own entry continues: one of the same
     * identity whose path is gone. A copy still on disk is a live file of its
     * own, and the cross-file dedupe settles the overlap.
     */
    const findMovedFrom = Effect.fnUntraced(function* (filePath: string) {
      const identity = format.fileIdentity?.(filePath);
      if (identity === undefined || fileCache.has(filePath)) return undefined;
      identities ??= cachedPathsByIdentity(fileCache);
      let found: { readonly path: string; readonly entry: CachedFile } | undefined;
      for (const candidate of identities.get(provider + "\0" + identity) ?? []) {
        const entry = fileCache.get(candidate);
        if (candidate === filePath || entry?.provider !== provider) continue;
        if (yield* fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => true))) continue;
        if (found === undefined || isLaterRead(entry, found.entry))
          found = { path: candidate, entry };
      }
      return found;
    });
    // A cold parse waits on disk reads, so a few files in flight read
    // close to twice as fast. Results keep walk order while sharing the read
    // permit pool across concurrent transcript directories.
    const read = yield* Effect.forEach(
      files,
      (file) =>
        findMovedFrom(file.path).pipe(
          Effect.flatMap((movedFrom) =>
            readSemaphore.withPermit(
              readFileRecords(file.path, file.size, file.mtimeMs, provider, format, movedFrom),
            ),
          ),
          Effect.map((result) => ({ path: file.path, ...result })),
        ),
      { concurrency: TRANSCRIPT_READ_CONCURRENCY },
    );
    const parsedFiles = read.map(({ path, records, update }) => {
      if (update === undefined) return { path, records };
      // A scan of another window may have cached its own read of this file
      // meanwhile. Then keep whichever read saw the later file, so a slower
      // scan never replaces newer usage with older.
      const current = fileCache.get(path);
      if (
        current === update.replaces ||
        current === undefined ||
        !isLaterRead(current, update.entry)
      ) {
        fileCache.set(path, update.entry);
        cacheDirty = true;
      }
      // The saved usage moved with the file. Left at its old path it would
      // also count as a deleted transcript's history.
      const previous = update.movedFrom;
      if (previous !== undefined && fileCache.get(previous.path) === previous.entry) {
        fileCache.delete(previous.path);
        cacheDirty = true;
      }
      return { path, records };
    });
    // Unread files keep their cached usage, but the total may be short.
    const unread = failedPaths + read.filter((file) => file.failed).length;
    return {
      ...identity,
      provider,
      dir,
      volumeId,
      files: parsedFiles,
      ...(unread > 0
        ? {
            status: "partial",
            message: `${unread} transcript path(s) could not be read; usage may be incomplete.`,
          }
        : {}),
    } satisfies ScannedDir;
  });

  const collectDirs = Effect.fn("UsageService.collectDirs")(function* (
    windowStartMs: number,
    settings: ServerSettingsValue,
    retentionCutoffMs: number,
    awaitRefresh: boolean,
  ) {
    const dirs = yield* resolveTranscriptDirs(settings, retentionCutoffMs).pipe(
      Effect.provideContext(readerContext),
    );

    const scans = Effect.forEach(
      scanReaders,
      ({ driver, reader }) =>
        usageInstances(driver, settings)
          .pipe(
            Effect.flatMap((instances) =>
              reader.scan({ instances, settings, windowStartMs, retentionCutoffMs, awaitRefresh }),
            ),
          )
          .pipe(
            Effect.flatMap((sources) =>
              Effect.forEach(sources, ({ volumeId, ...source }) =>
                Effect.map(
                  volumeId === undefined
                    ? Effect.promise(() => readDirectoryVolumeId(source.dir))
                    : Effect.succeed(volumeId),
                  (resolved): ScannedDir => ({
                    ...source,
                    provider: reader.provider,
                    volumeId: resolved,
                  }),
                ),
              ),
            ),
            Effect.provideContext(readerContext),
          ),
      { concurrency: "unbounded" },
    );

    // Independent sources scan together. Transcript directories walk
    // concurrently while sharing one read semaphore so open transcript parses
    // stay at `TRANSCRIPT_READ_CONCURRENCY`. `Effect.forEach` preserves `dirs`
    // order, which aggregation relies on for first-seen deduplication.
    const readSemaphore = yield* Semaphore.make(TRANSCRIPT_READ_CONCURRENCY);
    const [transcripts, scanDirs] = yield* Effect.all(
      [
        Effect.forEach(
          dirs,
          (dir) => scanTranscriptDir(dir, windowStartMs, retentionCutoffMs, readSemaphore),
          { concurrency: TRANSCRIPT_DIR_CONCURRENCY },
        ),
        scans,
      ],
      { concurrency: "unbounded" },
    );
    const scanned: readonly ScannedDir[] = [...transcripts, ...scanDirs.flat()];
    return scanned;
  });

  const readAccountBindings = Effect.fnUntraced(function* (
    sources: readonly { readonly instanceIds?: readonly string[] | undefined }[],
  ) {
    // Read only metadata, through provider-thread/run joins. No chat
    // projections or message payloads are decoded to recover account ownership.
    const sharedInstanceIds = [
      ...new Set(
        sources.flatMap((source) =>
          (source.instanceIds?.length ?? 0) > 1 ? (source.instanceIds ?? []) : [],
        ),
      ),
    ];
    if (sharedInstanceIds.length === 0) return [];
    return yield* sql<UsageAccountBinding>`
      SELECT a.provider_instance_id AS instanceId,
        COALESCE(json_extract(a.payload_json, '$.nativeThreadId'),
          json_extract(p.payload_json, '$.nativeThreadRef.nativeId')) AS sessionId,
        json_extract(a.payload_json, '$.startedAt') AS startedAt
      FROM orchestration_v2_projection_run_attempts a
      LEFT JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = a.provider_thread_id
      WHERE a.provider_instance_id IN ${sql.in(sharedInstanceIds)}
      UNION ALL
      SELECT r.provider_instance_id,
        json_extract(p.payload_json, '$.nativeThreadRef.nativeId'),
        COALESCE(json_extract(r.payload_json, '$.startedAt'), r.requested_at)
      FROM orchestration_v2_projection_runs r
      JOIN orchestration_v2_projection_provider_threads p ON p.provider_thread_id = r.provider_thread_id
      WHERE r.provider_instance_id IN ${sql.in(sharedInstanceIds)}
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_run_attempts a WHERE a.run_id = r.run_id)
    `.pipe(
      NodeSqliteClient.readOnly,
      Effect.mapError(
        (cause) =>
          new UsageReadError({
            reason: "scanFailed",
            detail: "Could not read usage account ownership.",
            cause,
          }),
      ),
    );
  });

  const scanSummary = Effect.fn("UsageService.scanSummary")(function* (
    input: UsageSummaryInput,
    settings: ServerSettingsValue,
  ) {
    if (input.sinceDay > input.untilDay) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is after untilDay '${input.untilDay}'`,
      });
    }

    let hourlyWindow: { readonly sinceTimeMs: number; readonly untilTimeMs: number } | null = null;
    if (input.resolution === "hour") {
      const sinceTime =
        input.sinceTime === undefined ? Option.none() : DateTime.make(input.sinceTime);
      const untilTime =
        input.untilTime === undefined ? Option.none() : DateTime.make(input.untilTime);
      if (Option.isNone(sinceTime) || Option.isNone(untilTime)) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage requires valid sinceTime and untilTime instants",
        });
      }
      const sinceTimeMs = DateTime.toEpochMillis(sinceTime.value);
      const untilTimeMs = DateTime.toEpochMillis(untilTime.value);
      const durationMs = untilTimeMs - sinceTimeMs;
      if (durationMs <= 0 || durationMs > MAX_HOURLY_WINDOW_MS) {
        return yield* new UsageReadError({
          reason: "invalidWindow",
          detail: "Hourly usage window must be greater than zero and at most 24 hours",
        });
      }
      hourlyWindow = { sinceTimeMs, untilTimeMs };
    }

    const startedAtMs = yield* Clock.currentTimeMillis;
    yield* ensureScanCacheLoaded;

    const hostId = NodeOS.hostname();
    const windowStart = DateTime.make(`${input.sinceDay}T00:00:00Z`);
    if (Option.isNone(windowStart)) {
      return yield* new UsageReadError({
        reason: "invalidWindow",
        detail: `sinceDay '${input.sinceDay}' is not a valid date`,
      });
    }
    const windowStartMs =
      (hourlyWindow?.sinceTimeMs ?? DateTime.toEpochMillis(windowStart.value)) - MTIME_SLACK_MS;

    const retentionCutoffMs = startedAtMs - CACHE_RETENTION_DAYS * 24 * 60 * 60 * 1000;

    // Pricing only matters once records are aggregated, so the rate table
    // loads while transcripts stream instead of gating them: a cold rates
    // fetch on a slow network no longer delays the scan by its own timeout.
    const [, scannedDirs] = yield* Effect.all(
      [
        ensureRates(false),
        collectDirs(windowStartMs, settings, retentionCutoffMs, input.awaitRefresh === true),
      ],
      { concurrency: 2 },
    );

    const accountBindings = yield* readAccountBindings(scannedDirs);

    const priceOverrides = createOverrideRateTable(settings.usagePriceOverrides);
    const modelAliases = resolveModelAliases(settings.usageModelAliases);
    const sources: UsageSource[] = [];

    // Cleanup may remove transcripts, but the usage we already saved still
    // contributes to its source through the normal aggregation and dedupe
    // path. Like the walk, skip files last written before the window: they
    // cannot hold records inside it.
    const retainedSinceMs = Math.max(windowStartMs, retentionCutoffMs);
    const filesByDir = scannedDirs.map(({ provider, dir, files }) => {
      const retainedFiles = [...(files ?? [])];
      const livePaths = new Set(retainedFiles.map((file) => file.path));
      for (const [filePath, entry] of fileCache) {
        if (
          entry.provider !== provider ||
          entry.mtimeMs < retainedSinceMs ||
          livePaths.has(filePath) ||
          !isWithinDirectory(filePath, dir)
        )
          continue;
        retainedFiles.push({
          path: filePath,
          records:
            entry.tailRecords.length === 0
              ? entry.records
              : dedupeWithinFile([...entry.records, ...entry.tailRecords]),
        });
      }
      return retainedFiles;
    });
    // The models priced below, as UsageAggregator resolves them: an alias replaces rateModel.
    const rateModels = new Set<string>();
    for (const files of filesByDir) {
      for (const file of files) {
        for (const record of file.records) {
          const alias = modelAliases.get(record.model);
          const model = alias ?? record.model;
          if (priceOverrides.has(model.trim())) continue;
          rateModels.add(alias === undefined ? (record.rateModel ?? model) : model);
        }
      }
    }
    yield* refreshForUnlistedModels(rateModels);

    // Read once, before aggregating: a rate refresh that lands mid-aggregation would otherwise
    // pair these totals with pricing metadata they were not computed from.
    const summaryPricing = pricing();
    const aggregator = new UsageAggregator({
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      resolution: input.resolution ?? "day",
      ...hourlyWindow,
      rates,
      priceOverrides,
      modelAliases,
    });

    const crossFileSessions = sharedSessions(filesByDir.flat());
    // Clients total sessions per directory, so a session split across two,
    // such as a rollout in both Codex homes at once, counts in the first.
    const sharedSessionDirs = new Map<string, number>();

    for (const [
      index,
      {
        provider,
        dir,
        volumeId,
        files,
        status,
        message,
        action,
        refreshing,
        hostId: sourceHostId,
        instanceId,
        instanceIds,
        displayName,
      },
    ] of scannedDirs.entries()) {
      let scannedFiles = 0;
      let skippedFiles = 0;
      // Distinct per directory. Buckets carry per-cell session counts, but a
      // session spans days and models, so clients total this figure instead.
      const sessionIds = new Set<string>();
      const accountSessions = new Map<string, Set<string>>();
      const attributed = (instanceIds?.length ?? 0) > 1;
      const accountFor = attributed
        ? createUsageAttribution(
            accountBindings,
            instanceIds ?? [],
            (filesByDir[index] ?? []).map((file) => ({
              ...file,
              details: [
                ...(fileCache.get(file.path)?.details ?? []),
                ...(fileCache.get(file.path)?.tailDetails ?? []),
              ],
            })),
          )
        : undefined;

      for (const file of filesByDir[index] ?? []) {
        if (file.records.length === 0) {
          skippedFiles += 1;
          continue;
        }
        scannedFiles += 1;
        const sidechain = accountFor ? claudeSidechain(file.path, file.records) : null;
        const eventOccurrences = new Map<string, number>();
        for (const record of file.records) {
          let usageRecord = record;
          const shared =
            sharedSessionProviders.has(record.provider) && crossFileSessions.has(record.sessionId);
          if (shared) {
            // Match moved copies without collapsing repeated equal events
            // within one file (timestamps can have only second precision).
            // Only sessions seen in several files can have a copy to match.
            const key = encodeUsageRecordKey([
              record.provider,
              record.sessionId,
              record.timestampMs,
              record.model,
              record.totals,
            ]);
            const occurrence = (eventOccurrences.get(key) ?? 0) + 1;
            eventOccurrences.set(key, occurrence);
            usageRecord = { ...record, dedupeKey: key + ":" + occurrence };
          }
          // Only sessions contributing in-window count; the mtime slack can
          // admit boundary files whose records fall outside the range.
          const account =
            accountFor?.(sidechain ? { ...sidechain, timestampMs: record.timestampMs } : record) ??
            instanceId;
          if (
            aggregator.add(usageRecord, dir, attributed ? account : undefined) &&
            record.sessionId.length > 0 &&
            (!shared || (sharedSessionDirs.get(record.sessionId) ?? index) === index)
          ) {
            if (shared) sharedSessionDirs.set(record.sessionId, index);
            sessionIds.add(record.sessionId);
            if (account !== undefined) {
              const sessions = accountSessions.get(account) ?? new Set<string>();
              sessions.add(record.sessionId);
              accountSessions.set(account, sessions);
            }
          }
        }
      }

      sources.push({
        ...(instanceId ? { instanceId } : {}),
        ...(displayName ? { displayName } : {}),
        ...(attributed
          ? {
              instances: (instanceIds ?? []).map((id) => ({
                instanceId: id,
                ...(settings.providerInstances[id]?.displayName
                  ? { displayName: settings.providerInstances[id].displayName }
                  : {}),
                distinctSessions: accountSessions.get(id)?.size ?? 0,
              })),
            }
          : {}),
        fingerprint: { hostId: sourceHostId ?? hostId, provider, resolvedHomePath: dir, volumeId },
        // Clients exclude missing sources, so saved records remain an available source.
        status: files === null && scannedFiles === 0 ? "missing" : (status ?? "ok"),
        scannedFiles,
        skippedFiles,
        malformedRecords: 0,
        distinctSessions: sessionIds.size,
        message:
          message ?? (files === null ? "No transcript directory on this environment." : null),
        ...(action ? { action } : {}),
        ...(refreshing ? { refreshing } : {}),
      });
    }

    const pruned = pruneScanCache(fileCache, retentionCutoffMs);
    if (pruned > 0) cacheDirty = true;

    const aggregated = aggregator.finish();
    const readAt = yield* DateTime.now;
    const finishedAtMs = yield* Clock.currentTimeMillis;

    return {
      contractVersion: USAGE_CONTRACT_VERSION,
      readAt: DateTime.formatIso(readAt),
      timeZone: input.timeZone,
      sinceDay: input.sinceDay,
      untilDay: input.untilDay,
      buckets: aggregated.buckets,
      sources,
      pricing: summaryPricing,
      scanDurationMs: Math.max(0, finishedAtMs - startedAtMs),
    } satisfies UsageSummary;
  });

  /**
   * In-flight scans by window and settings, so concurrent identical requests (the usage
   * page open on two clients at once) share one scan instead of racing over
   * the same corpus twice. Readers read settings of their own, so a scan is
   * shared only under the same settings snapshot.
   */
  const inflightScans = new Map<string, Deferred.Deferred<UsageSummary, UsageReadError>>();

  const scanKey = (input: UsageSummaryInput, settings: ServerSettingsValue): string =>
    JSON.stringify([
      input.timeZone,
      input.sinceDay,
      input.untilDay,
      input.resolution ?? "day",
      input.sinceTime ?? null,
      input.untilTime ?? null,
      settings,
      // A waiting read must never share a scan that answers with `refreshing`.
      input.awaitRefresh === true,
    ]);

  const readSummary = Effect.fn("UsageService.readSummary")(function* (input: UsageSummaryInput) {
    const settings = yield* readSettings;
    const key = scanKey(input, settings);
    const deferred = yield* Effect.uninterruptible(
      Effect.gen(function* () {
        const existing = inflightScans.get(key);
        if (existing !== undefined) return existing;

        // Enrollment and detached-fiber creation must be atomic. Otherwise a
        // canceled first caller can leave a Deferred with no scan to finish it.
        const created = Deferred.makeUnsafe<UsageSummary, UsageReadError>();
        inflightScans.set(key, created);
        // Detached so one departing client cannot tear the scan out from under
        // the fibers awaiting it; a finished scan warms the cache either way.
        // The cache write is registered before the waiters resume, so they
        // can await it, but its fiber starts after they have the summary.
        yield* scanSummary(input, settings).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => inflightScans.delete(key)).pipe(
              Effect.andThen(Exit.isSuccess(exit) ? schedulePersist : Effect.void),
              Effect.andThen(Deferred.done(created, exit)),
            ),
          ),
          Effect.forkDetach,
        );
        return created;
      }),
    );
    // Waiting stays interruptible. The detached scan continues for other
    // callers and still warms the cache if this caller leaves.
    return yield* Deferred.await(deferred);
  });

  // `awaitPersisted` is outside the service interface: tests use it to restart
  // against what a previous instance wrote.
  // All panels share one corpus refresh, including concurrent opens on several devices.
  // A refresh re-reads every changed transcript and rebuilds the whole corpus on the
  // server's own thread: about 4 s with one 1 GB chat transcript growing. So a result
  // stays current for `THREAD_RECORDS_FRESH_MS`, and an older one still answers at once
  // while its replacement is built.
  const loadThreadRecords = Effect.gen(function* () {
    yield* ensureScanCacheLoaded;
    const settings = yield* readSettings;
    const now = yield* Clock.currentTimeMillis;
    const [, scanned] = yield* Effect.all(
      [
        ensureRates(false),
        collectDirs(0, settings, now - CACHE_RETENTION_DAYS * 86_400_000, false),
      ],
      { concurrency: 2 },
    );
    const accountBindings = yield* readAccountBindings(scanned);
    const sources = scanned.map((source) => {
      const files = [...(source.files ?? [])];
      const live = new Set(files.map((file) => file.path));
      for (const [filePath, entry] of fileCache) {
        if (
          entry.provider === source.provider &&
          !live.has(filePath) &&
          isWithinDirectory(filePath, source.dir)
        )
          files.push({
            path: filePath,
            records:
              entry.tailRecords.length === 0
                ? entry.records
                : dedupeWithinFile([...entry.records, ...entry.tailRecords]),
          });
      }
      return {
        instanceId: source.instanceId,
        instanceIds: source.instanceIds,
        files: files.map((file) => {
          const cached = fileCache.get(file.path);
          return {
            ...file,
            details: [...(cached?.details ?? []), ...(cached?.tailDetails ?? [])],
          };
        }),
      };
    });
    const shared = sharedSessions(sources.flatMap((source) => source.files));
    const normalized = sources.map((source) => ({
      ...source,
      ...((source.instanceIds?.length ?? 0) > 1
        ? {
            accountFor: createUsageAttribution(
              accountBindings,
              source.instanceIds ?? [],
              source.files,
            ),
          }
        : {}),
      files: source.files.map((file) => {
        const occurrences = new Map<string, number>();
        return {
          ...file,
          records: file.records.map((record) => {
            if (!sharedSessionProviders.has(record.provider) || !shared.has(record.sessionId))
              return record;
            const key = encodeUsageRecordKey([
              record.provider,
              record.sessionId,
              record.timestampMs,
              record.model,
              record.totals,
            ]);
            const occurrence = (occurrences.get(key) ?? 0) + 1;
            occurrences.set(key, occurrence);
            return { ...record, dedupeKey: key + ":" + occurrence };
          }),
        };
      }),
    }));
    yield* schedulePersist;
    return {
      sources: normalized,
      rates,
      priceOverrides: createOverrideRateTable(settings.usagePriceOverrides),
      modelAliases: resolveModelAliases(settings.usageModelAliases),
      partial: scanned.some(
        (source) =>
          source.status === "partial" || source.status === "failed" || source.refreshing === true,
      ),
    };
  });
  let latestThreadRecords:
    | { readonly at: number; readonly value: Effect.Success<typeof loadThreadRecords> }
    | undefined;
  const threadRecords = yield* Cache.make({
    capacity: 1,
    timeToLive: Duration.millis(THREAD_RECORDS_FRESH_MS),
    lookup: (_key: string) =>
      loadThreadRecords.pipe(
        Effect.tap((value) =>
          Effect.map(Clock.currentTimeMillis, (at) => {
            latestThreadRecords = { at, value };
          }),
        ),
      ),
  });
  const refreshThreadRecords = Cache.get(threadRecords, "all");
  const pendingThreadRecordRefreshes = new Set<Fiber.Fiber<void>>();
  const readThreadRecords = Effect.gen(function* () {
    const latest = latestThreadRecords;
    if (latest === undefined) return yield* refreshThreadRecords;
    const age = (yield* Clock.currentTimeMillis) - latest.at;
    if (age < THREAD_RECORDS_FRESH_MS) return latest.value;
    // Too old to show: wait, as on a first read.
    if (age >= THREAD_RECORDS_MAX_STALE_MS) return yield* refreshThreadRecords;
    // Detached, like the scans above: a caller that leaves must not cancel the
    // refresh the next caller is counting on. The cache keeps it to one at a time.
    const fiber = yield* refreshThreadRecords.pipe(Effect.ignore, Effect.forkDetach);
    pendingThreadRecordRefreshes.add(fiber);
    fiber.addObserver(() => pendingThreadRecordRefreshes.delete(fiber));
    return latest.value;
  });
  /** Waits for the background refreshes started so far. Tests only, like `awaitPersisted`. */
  const awaitThreadRecordsRefreshed = Effect.suspend(() =>
    Fiber.awaitAll([...pendingThreadRecordRefreshes]),
  ).pipe(Effect.asVoid);
  return {
    readSummary,
    readThreadRecords,
    refreshRates,
    awaitPersisted,
    awaitThreadRecordsRefreshed,
  } as const;
});

export const layer = Layer.effect(UsageService, make);
