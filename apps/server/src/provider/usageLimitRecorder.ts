// @effect-diagnostics nodeBuiltinImport:off -- Synchronous hashing anonymizes identifiers before they enter the archive.
import * as NodeCrypto from "node:crypto";
import {
  IsoDateTime,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

export const USAGE_LIMIT_RECORDING_MAX_BYTES = 4 * 1024 * 1024;
/**
 * A counter that has not moved is written again this often, so the archive still shows it was
 * being read. Writing every five-minute check would fill the cap in days, not the four weeks kept.
 */
export const USAGE_LIMIT_RECORDING_HEARTBEAT_MS = 30 * 60_000;
// A reset that moves less than this is the same period (rolling resets jitter by seconds).
const SAME_RESET_MS = 10 * 60_000;
const MAX_AGE_MS = 28 * 24 * 3_600_000;

interface LastReading {
  readonly at: number;
  readonly usedPercent: number;
  readonly resetsAt: number | null;
  readonly limited: boolean | undefined;
}

const lastReadingOf = (row: RecordedUsageLimitReading): LastReading => ({
  at: Date.parse(row.checkedAt),
  usedPercent: row.usedPercent,
  resetsAt: row.resetsAt === undefined ? null : Date.parse(row.resetsAt),
  limited: row.limited,
});

function worthRecording(last: LastReading | undefined, next: LastReading): boolean {
  if (last === undefined) return true;
  if (next.at <= last.at) return false;
  if (next.at - last.at >= USAGE_LIMIT_RECORDING_HEARTBEAT_MS) return true;
  if (next.usedPercent !== last.usedPercent || next.limited !== last.limited) return true;
  if (next.resetsAt === null || last.resetsAt === null) return next.resetsAt !== last.resetsAt;
  return Math.abs(next.resetsAt - last.resetsAt) > SAME_RESET_MS;
}

/** Only quota measurements and opaque instance identities belong on disk, never auth or labels. */
const RecordedReading = Schema.Struct({
  instanceId: Schema.String,
  driver: ProviderDriverKind,
  windowId: Schema.String,
  kind: ServerProviderUsageWindow.fields.kind,
  usedPercent: ServerProviderUsageWindow.fields.usedPercent,
  resetsAt: Schema.optional(IsoDateTime),
  checkedAt: IsoDateTime,
  windowDurationMins: ServerProviderUsageWindow.fields.windowDurationMins,
  limited: ServerProviderUsageWindow.fields.limited,
  recentPercentPerHour: ServerProviderUsageWindow.fields.recentPercentPerHour,
});
export type RecordedUsageLimitReading = typeof RecordedReading.Type;
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(RecordedReading));
const encodeLine = Schema.encodeSync(Schema.fromJsonString(RecordedReading));

/** A torn final append or malformed line cannot hide the complete readings before it. */
export function readUsageLimitRecordings(contents: string): RecordedUsageLimitReading[] {
  return contents.split("\n").flatMap((line) => {
    const decoded = decodeLine(line);
    return Option.isSome(decoded) ? [decoded.value] : [];
  });
}

/**
 * Extends the in-memory usage history with an append-only measurement archive.
 * Compaction leaves headroom so bursts append small lines rather than rewriting 2 MiB each time.
 * Construct once per registry; the lock also orders simultaneous provider updates.
 */
export const makeUsageLimitRecorder = Effect.fn("makeUsageLimitRecorder")(function* (input: {
  readonly filePath: string;
  readonly maxBytes?: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lock = yield* Semaphore.make(1);
  const maxBytes = Math.min(
    input.maxBytes ?? USAGE_LIMIT_RECORDING_MAX_BYTES,
    USAGE_LIMIT_RECORDING_MAX_BYTES,
  );
  const rewrite = (contents: string) =>
    writeFileStringAtomically({ filePath: input.filePath, contents }).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );
  const now = yield* Clock.currentTimeMillis;
  yield* fs.makeDirectory(path.dirname(input.filePath), { recursive: true });
  const exists = yield* fs.exists(input.filePath);
  // Read at most the cap even if an older version left a larger archive.
  const size = exists ? Number((yield* fs.stat(input.filePath)).size) : 0;
  const tail = exists
    ? yield* fs
        .stream(input.filePath, {
          offset: Math.max(0, size - maxBytes),
          bytesToRead: maxBytes,
        })
        .pipe(Stream.decodeText(), Stream.mkString)
    : "";
  const raw = size > maxBytes ? tail.slice(tail.indexOf("\n") + 1) : tail;
  let rows = readUsageLimitRecordings(raw)
    .filter((row) => Date.parse(row.checkedAt) >= now - MAX_AGE_MS)
    .map((row) => ({ text: `${encodeLine(row)}\n`, at: Date.parse(row.checkedAt) }));
  let bytes = rows.reduce((sum, row) => sum + Buffer.byteLength(row.text), 0);
  let oldestAt = rows.reduce((oldest, row) => Math.min(oldest, row.at), Number.POSITIVE_INFINITY);
  if (exists && (size > maxBytes || rows.map((row) => row.text).join("") !== raw || raw === "")) {
    yield* rewrite(rows.map((row) => row.text).join(""));
  }
  const lastReadings = new Map<string, LastReading>();
  for (const row of readUsageLimitRecordings(raw)) {
    const key = `${row.instanceId}:${row.windowId}`;
    const reading = lastReadingOf(row);
    if (reading.at >= (lastReadings.get(key)?.at ?? 0)) lastReadings.set(key, reading);
  }
  const append = Effect.fn("usageLimitRecorder.append")(function* (
    instanceId: ProviderInstanceId,
    driver: ProviderDriverKind,
    limits: ServerProviderUsageLimits,
  ) {
    if (limits.unavailable) return;
    const now = yield* Clock.currentTimeMillis;
    const checkedAt = Date.parse(limits.checkedAt);
    if (!Number.isFinite(checkedAt) || checkedAt < now - MAX_AGE_MS) return;
    // A credential change starts a separate anonymous series, including across server restarts.
    const anonymousId = NodeCrypto.createHash("sha256")
      .update(`${instanceId}\0${limits.credentialFingerprint ?? ""}`)
      .digest("hex")
      .slice(0, 24);
    const additions = limits.windows.flatMap((window) => {
      const row: RecordedUsageLimitReading = {
        instanceId: anonymousId,
        driver,
        windowId: window.id,
        kind: window.kind,
        checkedAt: limits.checkedAt,
        usedPercent: window.usedPercent,
        ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
        ...(window.windowDurationMins === undefined
          ? {}
          : { windowDurationMins: window.windowDurationMins }),
        ...(window.limited === undefined ? {} : { limited: window.limited }),
        ...(window.recentPercentPerHour === undefined
          ? {}
          : { recentPercentPerHour: window.recentPercentPerHour }),
      };
      const key = `${anonymousId}:${window.id}`;
      const reading = lastReadingOf(row);
      if (!worthRecording(lastReadings.get(key), reading)) return [];
      return [{ key, reading, text: `${encodeLine(row)}\n`, at: checkedAt }];
    });
    if (additions.length === 0) return;
    const incoming = additions.map((row) => row.text).join("");
    const incomingBytes = Buffer.byteLength(incoming);
    const expired = oldestAt < now - MAX_AGE_MS;
    if (expired || bytes + incomingBytes > maxBytes) {
      let kept = [...rows, ...additions]
        .filter((row) => row.at >= now - MAX_AGE_MS)
        .sort((left, right) => left.at - right.at);
      let keptBytes = kept.reduce((sum, row) => sum + Buffer.byteLength(row.text), 0);
      let start = 0;
      const target = Math.floor(maxBytes * 0.75);
      while (keptBytes > target) keptBytes -= Buffer.byteLength(kept[start++]!.text);
      kept = kept.slice(start);
      yield* rewrite(kept.map((row) => row.text).join(""));
      rows = kept;
      bytes = keptBytes;
      oldestAt = rows.reduce((oldest, row) => Math.min(oldest, row.at), Number.POSITIVE_INFINITY);
    } else {
      yield* fs.writeFileString(input.filePath, incoming, { flag: "a", mode: 0o600 });
      rows.push(...additions);
      bytes += incomingBytes;
      oldestAt = Math.min(oldestAt, checkedAt);
    }
    for (const row of additions) lastReadings.set(row.key, row.reading);
  });
  return {
    append: (
      instanceId: ProviderInstanceId,
      driver: ProviderDriverKind,
      limits: ServerProviderUsageLimits,
    ) =>
      append(instanceId, driver, limits).pipe(
        lock.withPermits(1),
        Effect.tapError(() => Effect.logWarning("usage limit recording failed")),
        Effect.ignore,
      ),
  };
});
