// @effect-diagnostics nodeBuiltinImport:off
/**
 * Raw filesystem access for transcript scanning.
 *
 * Isolated here so the rest of the usage code stays on Effect's `FileSystem`.
 * The direct `node:fs` streaming is deliberate: a cold 30-day window is ~1.4 GB
 * across ~1,500 files, and buffer-level streaming is roughly an order of
 * magnitude cheaper than materialising each file. The equivalent Effect stream
 * pipeline is idiomatic but not fast enough to sit behind a page load.
 *
 * Transcripts are append-only, so a parse also reports the byte position it
 * stopped at. A later scan of the same file resumes from that position and
 * parses only the appended bytes, which is what keeps a warm scan cheap while a
 * session is actively writing a multi-hundred-megabyte rollout.
 *
 * A `.jsonl.zst` transcript is a finished one its provider compressed. It
 * never grows, so it is always read whole through a zstd stream and its parse
 * position is not resumable.
 *
 * @module usageTranscriptReader
 */
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeStringDecoder from "node:string_decoder";
import * as NodeZlib from "node:zlib";

import type {
  SelectedFields,
  TranscriptUsageFormat,
  UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { projectUsageMetadata } from "./usageJsonProjection.ts";
import { createTranscriptJsonReader } from "../project/AgentSessionJson.ts";
import {
  SESSION_DETAIL_FIELDS,
  SESSION_DETAIL_MARKERS,
  sessionDetails,
  type UsageSessionDetail,
} from "./usageSessionDetails.ts";

export interface TranscriptFile {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

/**
 * Where a parse stopped, with enough state to continue from there.
 *
 * The guard hash fingerprints the bytes immediately before `resumeOffset`. A
 * resume only proceeds when those bytes still match: transcripts are
 * append-only by design, but a rotated or rewritten file silently mis-parsed
 * from the middle would corrupt usage totals. The window is a cheap tripwire
 * for those realistic failure shapes, all of which disturb the file's tail at
 * that exact offset; it deliberately does not hash the whole prefix, which
 * would cost the full re-read the resume exists to avoid.
 */
export interface TranscriptParsePosition {
  /** Byte offset just past the last newline-terminated line consumed. */
  readonly resumeOffset: number;
  /** Length of the fingerprinted window ending at `resumeOffset`. */
  readonly guardLength: number;
  /** FNV-1a hash of that window. */
  readonly guardHash: number;
  /**
   * The format's reducer state as of `resumeOffset`, encoded by its schema;
   * `null` for stateless formats.
   */
  readonly state: unknown;
}

export interface TranscriptParseResult {
  readonly details: readonly UsageSessionDetail[];
  readonly tailDetails: readonly UsageSessionDetail[];
  /** Records from newline-terminated lines at or after the parse start. */
  readonly records: readonly UsageRecord[];
  /**
   * Records from a trailing segment the writer has not newline-terminated yet.
   * Kept out of `records` because `position` deliberately excludes that
   * segment: the next scan re-reads it once the writer finishes the line.
   */
  readonly tailRecords: readonly UsageRecord[];
  readonly position: TranscriptParsePosition;
  /** Whether the parse continued from `resumeFrom` rather than byte 0. */
  readonly resumed: boolean;
}

/** 64 bytes of JSONL tail is ample to distinguish a replaced file. */
export const GUARD_LENGTH = 64;
const COMPRESSED_SUFFIX = ".jsonl.zst";

/** Whether `path` names a zstd-compressed JSONL transcript. */
export function isCompressedTranscript(path: string): boolean {
  return path.endsWith(COMPRESSED_SUFFIX);
}
// Native parsing is faster for common 1–4 MiB context/tool records. Above
// 8 MiB, project usage without allocating the whole record. This switches
// readers; it never discards a record because of its size.
const STREAMING_THRESHOLD_BYTES = 8 * 1024 * 1024;
const NEWLINE = 0x0a;
/** `stat` calls one transcript walk keeps in flight. The libuv pool has 4 threads. */
const STAT_CONCURRENCY = 32;
const CARRIAGE_RETURN = 0x0d;

function selectUsageFields(fields: SelectedFields) {
  return (path: ReadonlyArray<string | number | null>): boolean => {
    let selected: true | SelectedFields = fields;
    for (const key of path) {
      if (selected === true) return true;
      if (typeof key !== "string" || !Object.hasOwn(selected, key)) return false;
      selected = selected[key]!;
    }
    return true;
  };
}

function fnv1a(buffer: Buffer): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < buffer.length; index += 1) {
    hash ^= buffer[index]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Lists `.jsonl` and `.jsonl.zst` transcripts under `root` last modified at or
 * after `sinceMs`, compressed ones only from `compressedSinceMs` when given.
 *
 * Unreadable directories and files are counted in `failedPaths` rather than
 * failing the page, so the source can report incomplete usage. Files that
 * vanish between `readdir` and `stat` are ordinary rotation and not counted.
 *
 * `fileName` restricts the walk to a single basename (Grok's `updates.jsonl`).
 * Grok sessions also ship multi-megabyte `chat_history` and `events` logs that
 * never carry usage, so the basename filter keeps a cold scan off those files.
 *
 * Directories are listed depth-first, one at a time, then the candidates are
 * stat'd by a fixed pool of workers: a warm scan stats thousands of files, and
 * one at a time each waits its own trip through the thread pool. Results keep
 * `readdir` order, which the aggregator's first-seen dedupe relies on.
 */
export async function listTranscriptFiles(
  root: string,
  sinceMs: number,
  options?: { readonly fileName?: string; readonly compressedSinceMs?: number },
): Promise<{ readonly files: readonly TranscriptFile[]; readonly failedPaths: number }> {
  const fileName = options?.fileName;
  const compressedSinceMs = Math.max(sinceMs, options?.compressedSinceMs ?? sinceMs);
  const candidates: string[] = [];
  let failedPaths = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      failedPaths += 1;
      return;
    }
    for (const entry of entries) {
      const child = NodePath.join(dir, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (
        fileName !== undefined
          ? entry.name === fileName
          : entry.name.endsWith(".jsonl") || isCompressedTranscript(entry.name)
      ) {
        candidates.push(child);
      }
    }
  };
  await walk(root);

  const found: Array<TranscriptFile | undefined> = Array.from({ length: candidates.length });
  // Each worker pulls the next candidate from one shared iterator.
  const queue = candidates.entries();
  const statQueued = async (): Promise<void> => {
    for (const [index, path] of queue) {
      try {
        const stats = await NodeFSP.stat(path);
        if (stats.mtimeMs >= (isCompressedTranscript(path) ? compressedSinceMs : sinceMs)) {
          found[index] = { path, size: stats.size, mtimeMs: stats.mtimeMs };
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          failedPaths += 1;
        }
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(STAT_CONCURRENCY, candidates.length) }, statQueued),
  );
  return { files: found.filter((file) => file !== undefined), failedPaths };
}

/**
 * Filesystem identity of a directory, as `device:inode`.
 *
 * Used to tell "two servers reading the same transcript directory" apart from
 * "two machines whose hostname and home path happen to match". Returns an empty
 * string when the directory cannot be stat'd.
 */
export async function readDirectoryVolumeId(path: string): Promise<string> {
  try {
    const stats = await NodeFSP.stat(path);
    return `${stats.dev}:${stats.ino}`;
  } catch {
    return "";
  }
}

/** The content size a zstd stream's first frame header declares, or `null`. */
async function zstdContentSize(handle: NodeFSP.FileHandle): Promise<number | null> {
  // Magic (4), descriptor (1), window (0-1), dictionary id (0-4), size (0-8).
  const header = Buffer.alloc(18);
  const { bytesRead } = await handle.read(header, 0, header.length, 0);
  if (bytesRead < 6 || header.readUInt32LE(0) !== 0xfd2fb528) return null;
  const descriptor = header[4]!;
  const singleSegment = (descriptor & 0x20) !== 0;
  const sizeBytes = [singleSegment ? 1 : 0, 2, 4, 8][descriptor >> 6]!;
  if (sizeBytes === 0) return null;
  const offset = 5 + (singleSegment ? 0 : 1) + [0, 1, 2, 4][descriptor & 0x03]!;
  if (bytesRead < offset + sizeBytes) return null;
  if (sizeBytes === 1) return header.readUInt8(offset);
  if (sizeBytes === 2) return header.readUInt16LE(offset) + 256;
  if (sizeBytes === 4) return header.readUInt32LE(offset);
  const size = header.readBigUInt64LE(offset);
  return size <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(size) : null;
}

/**
 * The decompressed size a zstd transcript declares, or `null` when it
 * declares none or cannot be read. Compares a compressed copy with the plain
 * file it replaced without decompressing it.
 */
export async function readZstdContentSize(path: string): Promise<number | null> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(path, "r");
    return await zstdContentSize(handle);
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function guardMatches(
  handle: NodeFSP.FileHandle,
  position: TranscriptParsePosition,
): Promise<boolean> {
  if (position.guardLength <= 0 || position.guardLength > GUARD_LENGTH) return false;
  try {
    const window = Buffer.alloc(position.guardLength);
    const { bytesRead } = await handle.read(
      window,
      0,
      position.guardLength,
      position.resumeOffset - position.guardLength,
    );
    return bytesRead === position.guardLength && fnv1a(window) === position.guardHash;
  } catch {
    return false;
  }
}

/**
 * Builds the byte-level test for a format's `usageMarkers`: whether a line
 * contains any of them.
 *
 * One marker is a single `Buffer` search. Several would be one pass over the
 * line each, so they are matched together as one alternation over the line's
 * latin1 view instead: latin1 maps every byte to one character without
 * validating it, so an ASCII marker matches exactly where its bytes do.
 */
export function transcriptLineGate(markers: readonly [string, ...string[]]) {
  if (markers.length === 1) {
    const marker = Buffer.from(markers[0]);
    return (line: Buffer) => line.includes(marker);
  }
  const pattern = new RegExp(
    markers.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  );
  return (line: Buffer) => pattern.test(line.toString("latin1"));
}

/**
 * Streams one transcript and returns the usage records it contains, or `null`
 * when the file could not be read.
 *
 * The distinction matters to the caller's cache: a genuinely empty transcript
 * is a stable fact worth memoising, while a transient read failure memoised
 * under the same `(size, mtime)` key would silently drop that file's usage
 * until the file next changes.
 *
 * With `resumeFrom`, parsing continues from that position when its guard bytes
 * still match, so only appended lines are read; otherwise the whole file is
 * re-parsed from the start and `resumed` reports `false`.
 *
 * A stateful format resumes with the state saved at that position; a saved
 * state its schema rejects re-parses the file whole. A compressed transcript
 * is decompressed and parsed whole every time.
 */
export async function readTranscriptRecords<State>(
  filePath: string,
  format: TranscriptUsageFormat<State>,
  resumeFrom?: TranscriptParsePosition,
  options?: { readonly streamingThresholdBytes?: number; readonly captureSessionDetails?: boolean },
): Promise<TranscriptParseResult | null> {
  const streamingThresholdBytes = options?.streamingThresholdBytes ?? STREAMING_THRESHOLD_BYTES;
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(filePath, "r");
  } catch {
    return null;
  }

  try {
    const codec = format.state;
    const decodeState = codec === undefined ? undefined : Schema.decodeUnknownOption(codec.schema);
    const encodeState = codec === undefined ? undefined : Schema.encodeSync(codec.schema);
    // Stateless formats never read their state argument.
    let state = codec === undefined ? (undefined as State) : codec.initial(filePath);
    let resumed = false;
    let start = 0;
    const compressed = isCompressedTranscript(filePath);
    const savedState =
      resumeFrom === undefined || decodeState === undefined || resumeFrom.state === null
        ? Option.none()
        : decodeState(resumeFrom.state);
    if (
      !compressed &&
      resumeFrom !== undefined &&
      resumeFrom.resumeOffset > 0 &&
      (codec === undefined || Option.isSome(savedState)) &&
      (await guardMatches(handle, resumeFrom))
    ) {
      if (Option.isSome(savedState)) state = savedState.value;
      start = resumeFrom.resumeOffset;
      resumed = true;
    }

    const toLineString = (lineBuffer: Buffer): string => {
      const content =
        lineBuffer.length > 0 && lineBuffer[lineBuffer.length - 1] === CARRIAGE_RETURN
          ? lineBuffer.subarray(0, -1)
          : lineBuffer;
      return content.toString("utf8");
    };

    // Gate on the raw bytes so the lines that fail it, which is most of them,
    // are never decoded.
    const details: UsageSessionDetail[] = [];
    const tailDetails: UsageSessionDetail[] = [];
    const capture = options?.captureSessionDetails === true;
    const usageMarkers = [...format.usageMarkers, ...(format.metadataMarkers ?? [])] as const;
    const markers = capture ? [...usageMarkers, ...SESSION_DETAIL_MARKERS] : usageMarkers;
    const markerPattern = new RegExp(
      markers.map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
    );
    const firstMetadataMarker =
      format.metadataMarkers === undefined ? undefined : Buffer.from(format.metadataMarkers[0]);
    const onlyMarker = markers.length === 1 ? Buffer.from(markers[0]!) : undefined;
    const fields = capture
      ? {
          ...format.selectFields,
          ...SESSION_DETAIL_FIELDS,
          payload: {
            ...(typeof format.selectFields.payload === "object" ? format.selectFields.payload : {}),
            ...SESSION_DETAIL_FIELDS.payload,
          },
        }
      : format.selectFields;
    const captureDetails = (parsed: unknown, lineState: State, out: UsageSessionDetail[]) => {
      if (!capture || typeof parsed !== "object" || parsed === null) return;
      // Ordinary requests vastly outnumber session/compaction details.
      const row = parsed as Record<string, unknown>;
      const payload = row.payload as Record<string, unknown> | null | undefined;
      if (
        row.type !== "session_meta" &&
        row.type !== "compacted" &&
        row.subtype !== "compact_boundary" &&
        payload?.type !== "context_compacted"
      )
        return;
      const stateSession =
        typeof lineState === "object" &&
        lineState !== null &&
        "sessionId" in lineState &&
        typeof lineState.sessionId === "string"
          ? lineState.sessionId
          : NodePath.basename(filePath).replace(/\.jsonl(?:\.zst)?$/, "");
      // Fork rollouts repeat ancestor metas after their own first meta.
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "type" in parsed &&
        parsed.type === "session_meta" &&
        "payload" in parsed &&
        typeof parsed.payload === "object" &&
        parsed.payload !== null &&
        "id" in parsed.payload &&
        parsed.payload.id !== stateSession
      )
        return;
      // Forks copy the parent's old boundaries in the same burst as its usage.
      // Keep the child's parent link, but apply the usage reader's one-second
      // copy window to those boundaries as well.
      if (
        typeof lineState === "object" &&
        lineState !== null &&
        "suppressingForkCopies" in lineState &&
        lineState.suppressingForkCopies === true &&
        "forkCopyAnchorMs" in lineState &&
        typeof lineState.forkCopyAnchorMs === "number" &&
        typeof parsed === "object" &&
        parsed !== null &&
        "type" in parsed &&
        parsed.type !== "session_meta" &&
        "timestamp" in parsed &&
        typeof parsed.timestamp === "string" &&
        Date.parse(parsed.timestamp) - lineState.forkCopyAnchorMs < 1000
      )
        return;
      out.push(...sessionDetails(parsed, stateSession));
    };
    const parseLine = (
      lineBuffer: Buffer,
      lineState: State,
      out: UsageRecord[],
      detailOut: UsageSessionDetail[],
    ): void => {
      // Classify once. Rechecking usage/detail markers would scan every tool
      // body two more times, which costs more than the timing reducer itself.
      const marker =
        firstMetadataMarker !== undefined &&
        lineBuffer.subarray(0, 512).includes(firstMetadataMarker)
          ? format.metadataMarkers![0]
          : onlyMarker !== undefined
            ? lineBuffer.includes(onlyMarker)
              ? markers[0]
              : undefined
            : markerPattern.exec(lineBuffer.toString("latin1"))?.[0];
      if (marker === undefined) return;
      try {
        const parsed: unknown =
          format.metadataMarkers !== undefined && lineBuffer.length >= 4 * 1024
            ? projectUsageMetadata(lineBuffer, fields)
            : JSON.parse(toLineString(lineBuffer));
        for (const record of format.parseProjected(parsed, lineState)) out.push(record);
        captureDetails(parsed, lineState, detailOut);
      } catch {
        /* Ignore incomplete records, including their timing boundaries. */
      }
    };

    const records: UsageRecord[] = [];
    // Byte offsets remain independent of UTF-8 decoding. Only complete lines
    // commit the resume point; an unfinished tail is replayed on the next scan.
    let resumeOffset = start;
    let scanOffset = start;
    let pendingChunks: Buffer[] = [];
    let pendingBytes = 0;
    let streaming: ReturnType<typeof createTranscriptJsonReader> | undefined;
    let decoder: NodeStringDecoder.StringDecoder | undefined;
    const selectPath = selectUsageFields(fields);

    const append = (segment: Buffer) => {
      if (!streaming && pendingBytes + segment.length <= streamingThresholdBytes) {
        if (segment.length > 0) pendingChunks.push(segment);
        pendingBytes += segment.length;
        return;
      }
      if (!streaming) {
        // Usage has no import-history budget: retain all selected usage fields,
        // regardless of the size of the surrounding unselected tool content.
        streaming = createTranscriptJsonReader(() => {}, selectPath, { maxDepth: Infinity });
        decoder = new NodeStringDecoder.StringDecoder("utf8");
        for (const pending of pendingChunks) streaming.write(decoder.write(pending));
        pendingChunks = [];
        pendingBytes = 0;
      }
      streaming.write(decoder!.write(segment));
    };
    const finish = (lineState: State, out: UsageRecord[], detailOut: UsageSessionDetail[]) => {
      if (streaming) {
        streaming.write(decoder!.end());
        const projected = streaming.finish();
        for (const record of format.parseProjected(projected, lineState)) out.push(record);
        captureDetails(projected, lineState, detailOut);
      } else if (pendingBytes > 0) {
        const line =
          pendingChunks.length === 1
            ? pendingChunks[0]!
            : Buffer.concat(pendingChunks, pendingBytes);
        parseLine(line, lineState, out, detailOut);
      }
      pendingChunks = [];
      pendingBytes = 0;
      streaming = undefined;
      decoder = undefined;
    };
    // A truncated zstd stream ends quietly, so an archive still being written
    // is caught by its declared size instead; see the check after the loop.
    const declaredSize = compressed ? await zstdContentSize(handle) : null;
    const fileStream = handle.createReadStream({
      start,
      autoClose: false,
      highWaterMark: 256 * 1024,
    });
    // `pipeline` fails the decompressor when the file read fails, which ends
    // the loop below with that error.
    const stream = (
      compressed
        ? NodeStream.pipeline(
            fileStream,
            NodeZlib.createZstdDecompress({ chunkSize: 256 * 1024 }),
            () => {},
          )
        : fileStream
    ) as AsyncIterable<Buffer>;
    for await (const chunk of stream) {
      let lineStart = 0;
      while (lineStart < chunk.length) {
        const newlineIndex = chunk.indexOf(NEWLINE, lineStart);
        if (newlineIndex === -1) {
          append(chunk.subarray(lineStart));
          break;
        }
        // Most lines fit in the current chunk. Avoid buffering/streaming
        // machinery on this hot path.
        if (!streaming && pendingBytes === 0) {
          parseLine(chunk.subarray(lineStart, newlineIndex), state, records, details);
        } else {
          append(chunk.subarray(lineStart, newlineIndex));
          finish(state, records, details);
        }
        lineStart = newlineIndex + 1;
        resumeOffset = scanOffset + lineStart;
      }
      scanOffset += chunk.length;
    }
    if (declaredSize !== null && scanOffset < declaredSize) return null;

    // The unfinished tail parses against a copy, so the saved state stays at
    // `resumeOffset` and the next scan replays the tail from it.
    const encodedState = encodeState === undefined ? null : encodeState(state);
    const tailRecords: UsageRecord[] = [];
    finish(
      decodeState === undefined ? state : Option.getOrThrow(decodeState(encodedState)),
      tailRecords,
      tailDetails,
    );

    // Offsets in a compressed file are positions in its decompressed bytes,
    // which a guard read cannot check. A zero guard never resumes.
    const guardLength = compressed ? 0 : Math.min(GUARD_LENGTH, resumeOffset);
    let guardHash = 0;
    if (guardLength > 0) {
      const window = Buffer.alloc(guardLength);
      await handle.read(window, 0, guardLength, resumeOffset - guardLength);
      guardHash = fnv1a(window);
    }

    return {
      details,
      tailDetails,
      records,
      tailRecords,
      position: {
        resumeOffset,
        guardLength,
        guardHash,
        state: encodedState,
      },
      resumed,
    };
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
