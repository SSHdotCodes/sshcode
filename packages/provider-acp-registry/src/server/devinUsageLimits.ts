/**
 * Subscription usage limits for Devin (`acpRegistry_devin`), read from Devin's
 * own `user_status.<hash>.bin` cache and refreshed via a lightweight `devin acp`
 * `initialize` handshake (no session or model turn, no credential reads).
 */
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { AcpRegistrySettings } from "../settings.ts";
import type * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { stripAcpBridgeEnvironment, unscopedAcpSpawn } from "./probe.ts";

export const DEVIN_USAGE_PROBE_MIN_INTERVAL_MS = 60_000;
const DEVIN_USER_STATUS_FRESH_MS = 60_000;
// Small grace beyond Devin's 60s cache TTL so boundary clock jitter after a
// clean initialize handshake does not misreport a fresh cache as failed.
const DEVIN_USER_STATUS_AFTER_REFRESH_MAX_AGE_MS = 2 * 60_000;
const DEVIN_REFRESH_INIT_TIMEOUT = "15 seconds";
const DEVIN_REFRESH_WAIT_STEP = "150 millis";
const DEVIN_REFRESH_WAIT_ATTEMPTS = 20;
const MAX_CANDIDATE_CACHE_FILES = 6;
const DAILY_WINDOW_MINS = 24 * 60;
const WEEKLY_WINDOW_MINS = 7 * 24 * 60;
const MAX_VALID_UNIX_SECONDS = 4_102_444_800n; // 2100-01-01T00:00:00Z

export const DEVIN_USAGE_PROBE_FAILED_MESSAGE = "Devin could not read usage limits.";

const USER_STATUS_FILE_PATTERN = /^user_status\.[a-zA-Z0-9_-]+\.bin$/;

// Protobuf field numbers from Devin's `UserStatus` / `PlanStatus` messages
// (`exa.seat_management_pb.SeatManagementService/GetUserStatus`).
const USER_STATUS_PLAN_STATUS_FIELD = 13;
const PLAN_STATUS_DAILY_REMAINING_PERCENT_FIELD = 14;
const PLAN_STATUS_WEEKLY_REMAINING_PERCENT_FIELD = 15;
const PLAN_STATUS_DAILY_RESET_AT_UNIX_FIELD = 17;
const PLAN_STATUS_WEEKLY_RESET_AT_UNIX_FIELD = 18;

const DevinUserStatusEnvelope = Schema.Struct({
  version: Schema.Finite,
  fetched_at_secs: Schema.Finite,
  payload: Schema.NonEmptyString,
});
const decodeUserStatusEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(DevinUserStatusEnvelope),
);

type ProtobufField =
  | { readonly fieldNumber: number; readonly wireType: 0; readonly value: bigint }
  | { readonly fieldNumber: number; readonly wireType: 2; readonly value: Uint8Array }
  | { readonly fieldNumber: number; readonly wireType: 1 | 5 };

function readVarint(
  bytes: Uint8Array,
  start: number,
): { readonly value: bigint; readonly next: number } | undefined {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < bytes.length && shift <= 63n) {
    const byte = bytes[offset]!;
    offset += 1;
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return { value, next: offset };
    }
    shift += 7n;
  }
  return undefined;
}

function readProtobufFields(bytes: Uint8Array): ReadonlyArray<ProtobufField> | undefined {
  const fields: ProtobufField[] = [];
  let offset = 0;
  while (offset < bytes.length) {
    const tag = readVarint(bytes, offset);
    if (tag === undefined) return undefined;
    offset = tag.next;
    const wireType = Number(tag.value & 7n);
    const fieldNumber = Number(tag.value >> 3n);
    if (!Number.isSafeInteger(fieldNumber) || fieldNumber <= 0) return undefined;
    if (wireType === 0) {
      const value = readVarint(bytes, offset);
      if (value === undefined) return undefined;
      offset = value.next;
      fields.push({ fieldNumber, wireType: 0, value: value.value });
    } else if (wireType === 1) {
      if (offset + 8 > bytes.length) return undefined;
      offset += 8;
      fields.push({ fieldNumber, wireType: 1 });
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      if (length === undefined || length.value > BigInt(bytes.length - length.next)) {
        return undefined;
      }
      const byteLength = Number(length.value);
      offset = length.next;
      fields.push({
        fieldNumber,
        wireType: 2,
        value: bytes.subarray(offset, offset + byteLength),
      });
      offset += byteLength;
    } else if (wireType === 5) {
      if (offset + 4 > bytes.length) return undefined;
      offset += 4;
      fields.push({ fieldNumber, wireType: 5 });
    } else {
      return undefined;
    }
  }
  return fields;
}

function decodeBase64Strict(encoded: string): Uint8Array | undefined {
  const trimmed = encoded.trim();
  if (trimmed.length === 0 || trimmed.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) {
    return undefined;
  }
  const bytes = Buffer.from(trimmed, "base64");
  return bytes.length > 0 ? bytes : undefined;
}

function parseRemainingPercent(value: bigint | undefined): number | undefined {
  // Reject negative int32/int64 sentinels (encoded as 10-byte two's-complement
  // varints like -1 = 18446744073709551615n) and out-of-range values.
  if (value === undefined || value < 0n || value > 100n) return undefined;
  return Number(value);
}

function parseUnixSecondsIso(value: bigint | undefined): string | undefined {
  if (value === undefined || value <= 0n || value >= MAX_VALID_UNIX_SECONDS) return undefined;
  const parsed = DateTime.make(Number(value) * 1000);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

export interface DecodedDevinPlanQuotas {
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
}

/**
 * Decodes daily and weekly quota windows from a serialized protobuf `UserStatus`
 * payload. Returns `undefined` when the payload is malformed or contains no
 * daily/weekly quota fields.
 */
export function decodeDevinUserStatusPayload(
  payloadBytes: Uint8Array,
): DecodedDevinPlanQuotas | undefined {
  const topFields = readProtobufFields(payloadBytes);
  if (topFields === undefined) return undefined;

  let hasPlanStatus = false;
  let dailyRemainingRaw: bigint | undefined;
  let weeklyRemainingRaw: bigint | undefined;
  let dailyResetRaw: bigint | undefined;
  let weeklyResetRaw: bigint | undefined;

  for (const field of topFields) {
    if (field.fieldNumber !== USER_STATUS_PLAN_STATUS_FIELD || field.wireType !== 2) continue;
    const planFields = readProtobufFields(field.value);
    if (planFields === undefined) return undefined;
    hasPlanStatus = true;
    for (const planField of planFields) {
      if (planField.wireType !== 0) continue;
      switch (planField.fieldNumber) {
        case PLAN_STATUS_DAILY_REMAINING_PERCENT_FIELD:
          dailyRemainingRaw = planField.value;
          break;
        case PLAN_STATUS_WEEKLY_REMAINING_PERCENT_FIELD:
          weeklyRemainingRaw = planField.value;
          break;
        case PLAN_STATUS_DAILY_RESET_AT_UNIX_FIELD:
          dailyResetRaw = planField.value;
          break;
        case PLAN_STATUS_WEEKLY_RESET_AT_UNIX_FIELD:
          weeklyResetRaw = planField.value;
          break;
      }
    }
  }
  if (!hasPlanStatus) return undefined;

  const dailyRemaining = parseRemainingPercent(dailyRemainingRaw);
  const weeklyRemaining = parseRemainingPercent(weeklyRemainingRaw);
  const dailyResetsAt = parseUnixSecondsIso(dailyResetRaw);
  const weeklyResetsAt = parseUnixSecondsIso(weeklyResetRaw);

  const windows: ServerProviderUsageWindow[] = [];
  // In proto3, a non-optional 0% remaining value may be omitted on the wire
  // while the window's reset timestamp is still present.
  if (dailyRemaining !== undefined || dailyResetsAt !== undefined) {
    windows.push({
      id: "daily",
      kind: "session",
      label: "Daily",
      usedPercent: clampPercent(100 - (dailyRemaining ?? 0)),
      windowDurationMins: DAILY_WINDOW_MINS,
      ...(dailyResetsAt === undefined ? {} : { resetsAt: dailyResetsAt }),
    });
  }
  if (weeklyRemaining !== undefined || weeklyResetsAt !== undefined) {
    windows.push({
      id: "weekly",
      kind: "weekly",
      label: "Weekly",
      usedPercent: clampPercent(100 - (weeklyRemaining ?? 0)),
      windowDurationMins: WEEKLY_WINDOW_MINS,
      ...(weeklyResetsAt === undefined ? {} : { resetsAt: weeklyResetsAt }),
    });
  }
  return windows.length > 0 ? { windows } : undefined;
}

export interface ParsedDevinUserStatusCache {
  readonly fetchedAtSecs: number;
  readonly windows: ReadonlyArray<ServerProviderUsageWindow>;
}

/** Parses one `user_status.<hash>.bin` JSON envelope written by Devin CLI/ACP. */
export function parseDevinUserStatusCache(
  contents: string,
): ParsedDevinUserStatusCache | undefined {
  const envelope = decodeUserStatusEnvelope(contents);
  if (Option.isNone(envelope)) return undefined;
  const { version, fetched_at_secs, payload } = envelope.value;
  if (version !== 1 || !Number.isFinite(fetched_at_secs) || fetched_at_secs <= 0) {
    return undefined;
  }
  const payloadBytes = decodeBase64Strict(payload);
  if (payloadBytes === undefined) return undefined;
  const decoded = decodeDevinUserStatusPayload(payloadBytes);
  if (decoded === undefined) return undefined;
  return {
    fetchedAtSecs: Math.floor(fetched_at_secs),
    windows: decoded.windows,
  };
}

/** Converts a parsed cache reading into `ServerProviderUsageLimits`. */
export function devinUserStatusCacheToLimits(
  parsed: ParsedDevinUserStatusCache,
  nowMs: number,
): ServerProviderUsageLimits {
  const fetchedMs = Math.min(nowMs, parsed.fetchedAtSecs * 1000);
  const checkedAt = DateTime.formatIso(
    Option.getOrElse(DateTime.make(fetchedMs), () => DateTime.makeUnsafe(nowMs)),
  );
  return makeUsageLimits({ checkedAt, windows: parsed.windows });
}

/** `$XDG_CACHE_HOME/devin/cli`, else `~/.cache/devin/cli`, as the Devin CLI resolves it. */
export const resolveDevinCacheDir = Effect.fn("resolveDevinCacheDir")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const path = yield* Path.Path;
  const home =
    environment.HOME?.trim() ||
    environment.USERPROFILE?.trim() ||
    (yield* HostProcess.HomeDirectory);
  const cacheHome = environment.XDG_CACHE_HOME?.trim();
  const root = cacheHome
    ? path.join(expandHomePath(cacheHome, home), "devin")
    : path.join(home, ".cache", "devin");
  return path.join(root, "cli");
});

const readLatestDevinUserStatusCache = Effect.fn("readLatestDevinUserStatusCache")(function* (
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs
    .readDirectory(cacheDir)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const filenames = entries.filter((name) => USER_STATUS_FILE_PATTERN.test(name));
  if (filenames.length === 0) return undefined;

  const statted = yield* Effect.forEach(
    filenames,
    (name) => {
      const filePath = path.join(cacheDir, name);
      return fs.stat(filePath).pipe(
        Effect.map((info) => ({
          filePath,
          mtimeMs: Option.match(info.mtime, {
            onNone: () => 0,
            onSome: (date) => date.getTime(),
          }),
        })),
        Effect.orElseSucceed(() => ({ filePath, mtimeMs: 0 })),
      );
    },
    { concurrency: "unbounded" },
  );

  const candidates = statted
    .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, MAX_CANDIDATE_CACHE_FILES);

  let latest: ParsedDevinUserStatusCache | undefined;
  for (const candidate of candidates) {
    const raw = yield* fs
      .readFileString(candidate.filePath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (raw === undefined) continue;
    const parsed = parseDevinUserStatusCache(raw);
    if (
      parsed !== undefined &&
      (latest === undefined || parsed.fetchedAtSecs > latest.fetchedAtSecs)
    ) {
      latest = parsed;
    }
  }
  return latest;
});

const refreshDevinUserStatusCache = Effect.fn("refreshDevinUserStatusCache")(function* (input: {
  readonly settings: AcpRegistrySettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cacheDir: string;
  readonly beforeFetchedAtSecs: number;
}) {
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;

  const inspected = yield* Effect.result(catalog.inspect(input.settings, input.environment));
  if (Result.isFailure(inspected) || inspected.success.status !== "ready") {
    return undefined;
  }
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const resolved = yield* Effect.result(
        catalog.resolve(input.settings, input.cwd, stripAcpBridgeEnvironment(input.environment)),
      );
      if (Result.isFailure(resolved)) {
        return undefined;
      }
      const runtimeContext = yield* Layer.build(
        AcpSessionRuntime.layer({
          spawn: unscopedAcpSpawn(resolved.success.spawn),
          cwd: input.cwd,
          clientCapabilities: {
            auth: { terminal: false },
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: "t3-code-usage-probe", version: "0.0.0" },
          authenticateOnAuthRequired: false,
          ...(input.settings.authMethodId ? { authMethodId: input.settings.authMethodId } : {}),
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Layer.succeed(Crypto.Crypto, crypto),
            ),
          ),
        ),
      );
      const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
        Effect.provide(runtimeContext),
      );
      // `initialize` alone triggers Devin's background `GetUserStatus` refresh
      // when its 60s disk cache is stale — no session is created and no model runs.
      const initialized = yield* Effect.result(
        runtime.initialize().pipe(Effect.timeout(DEVIN_REFRESH_INIT_TIMEOUT)),
      );
      if (Result.isFailure(initialized)) {
        yield* Effect.logDebug("Devin usage probe initialize failed", initialized.failure);
        return undefined;
      }

      // Devin writes the refreshed `user_status.<hash>.bin` asynchronously right
      // after `initialize` returns; wait briefly for the updated file to land.
      for (let attempt = 0; attempt < DEVIN_REFRESH_WAIT_ATTEMPTS; attempt += 1) {
        const current = yield* readLatestDevinUserStatusCache(input.cacheDir);
        if (current !== undefined && current.fetchedAtSecs > input.beforeFetchedAtSecs) {
          return current;
        }
        yield* Effect.sleep(DEVIN_REFRESH_WAIT_STEP);
      }
      return yield* readLatestDevinUserStatusCache(input.cacheDir);
    }),
  ).pipe(
    Effect.catch((error) =>
      Effect.logDebug("Devin usage probe refresh failed", error).pipe(Effect.as(undefined)),
    ),
  );
});

export interface DevinUsageLimitsProbeInput {
  readonly settings: AcpRegistrySettings;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly runtimeCoordinator?: AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator["Service"];
  readonly refreshCache?: (input: {
    readonly cacheDir: string;
    readonly beforeFetchedAtSecs: number;
  }) => Effect.Effect<ParsedDevinUserStatusCache | undefined>;
}

/**
 * Creates a throttled (at most once per minute) Devin usage-limits probe.
 * Reads Devin's `user_status.<hash>.bin` cache when fresh, otherwise triggers a
 * lightweight `devin acp` `initialize` handshake to refresh it.
 */
export const makeDevinUsageLimitsProbe = Effect.fn("makeDevinUsageLimitsProbe")(function* (
  input: DevinUsageLimitsProbeInput,
) {
  const catalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const semaphore = yield* Semaphore.make(1);
  const lastAttemptRef = yield* Ref.make<{
    readonly at: number;
    readonly result: ServerProviderUsageLimits;
  } | null>(null);

  const probeFailure = (nowMs: number) =>
    makeUnavailableUsageLimits({
      checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      reason: "probeFailed",
      message: DEVIN_USAGE_PROBE_FAILED_MESSAGE,
    });

  const runRefresh = (cacheDir: string, beforeFetchedAtSecs: number) => {
    const refresh = input.refreshCache
      ? input.refreshCache({ cacheDir, beforeFetchedAtSecs })
      : refreshDevinUserStatusCache({
          settings: input.settings,
          cwd: input.cwd,
          environment: input.environment,
          cacheDir,
          beforeFetchedAtSecs,
        }).pipe(
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, catalog),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
    return input.runtimeCoordinator
      ? input.runtimeCoordinator.runBackgroundProbe("devin", refresh)
      : refresh.pipe(Effect.map(Option.some));
  };

  const probeOnce = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const cacheDir = yield* resolveDevinCacheDir(input.environment).pipe(
      Effect.provideService(Path.Path, path),
    );
    const existing = yield* readLatestDevinUserStatusCache(cacheDir).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
    if (
      existing !== undefined &&
      nowMs - existing.fetchedAtSecs * 1000 < DEVIN_USER_STATUS_FRESH_MS
    ) {
      return {
        limits: devinUserStatusCacheToLimits(existing, nowMs),
        cacheable: true,
      };
    }

    const outcome = yield* runRefresh(cacheDir, existing?.fetchedAtSecs ?? 0).pipe(
      Effect.catchDefect((defect) =>
        Effect.logDebug("Devin usage probe failed unexpectedly", defect).pipe(
          Effect.as(Option.some(undefined)),
        ),
      ),
    );
    const afterMs = yield* Clock.currentTimeMillis;
    if (Option.isNone(outcome)) {
      return { limits: probeFailure(afterMs), cacheable: false };
    }
    const refreshed = outcome.value;
    if (
      refreshed !== undefined &&
      (refreshed.fetchedAtSecs > (existing?.fetchedAtSecs ?? 0) ||
        afterMs - refreshed.fetchedAtSecs * 1000 <= DEVIN_USER_STATUS_AFTER_REFRESH_MAX_AGE_MS)
    ) {
      return {
        limits: devinUserStatusCacheToLimits(refreshed, afterMs),
        cacheable: true,
      };
    }
    return { limits: probeFailure(afterMs), cacheable: true };
  });

  const probe = semaphore.withPermit(
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      const last = yield* Ref.get(lastAttemptRef);
      if (last !== null && nowMs - last.at < DEVIN_USAGE_PROBE_MIN_INTERVAL_MS) {
        return last.result;
      }
      const { limits, cacheable } = yield* probeOnce;
      if (cacheable) {
        const completedAt = yield* Clock.currentTimeMillis;
        yield* Ref.set(lastAttemptRef, { at: completedAt, result: limits });
      }
      return limits;
    }),
  );

  return {
    probe,
    clear: Ref.set(lastAttemptRef, null),
  };
});
