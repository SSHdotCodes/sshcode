import * as DateTime from "effect/DateTime";
import type {
  CheckpointId,
  MessageId,
  NodeId,
  OrchestrationV2Checkpoint,
  OrchestrationV2DomainEvent,
  OrchestrationV2ContextHandoff,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  dedupeSubagentBodies,
  dedupeTurnItemBodies,
} from "@t3tools/shared/orchestrationV2DedupedBodies";
import {
  compactDynamicToolOutput,
  omitToolOutputImageData,
  readToolOutputImage,
  toolOutputImages,
  toolOutputIndicatesFailure,
} from "@t3tools/shared/toolOutput";

/** Apply display activity only at the client boundary, never to task delivery or accounting. */
function projectSubagentActivity<
  T extends {
    readonly childActivity?: OrchestrationV2Subagent["childActivity"];
    readonly status: string;
    readonly startedAt: DateTime.Utc | null;
    readonly completedAt: DateTime.Utc | null;
    readonly result: string | null;
  },
>(record: T): T {
  const activity = record.childActivity;
  if (activity === undefined) return record;
  return {
    ...record,
    childActivity: undefined,
    status: activity.status,
    startedAt: DateTime.makeUnsafe(activity.startedAt),
    completedAt: activity.completedAt === null ? null : DateTime.makeUnsafe(activity.completedAt),
    result: activity.result,
  };
}

function projectSubagentForWire(subagent: OrchestrationV2Subagent): OrchestrationV2Subagent {
  const projected = projectSubagentActivity(subagent);
  const { childActivity, completedAt, seen } = subagent;
  // The original task's check, files and commits describe work up to its completion.
  if (
    seen !== undefined &&
    childActivity !== undefined &&
    completedAt !== null &&
    childActivity.startedAt > DateTime.toEpochMillis(completedAt)
  ) {
    return { ...projected, seen: undefined };
  }
  return projected;
}

const MAX_DETAIL_STRING_BYTES = 32_768;
export const COMMAND_OUTPUT_FAILURE_SCAN_CHARS = MAX_DETAIL_STRING_BYTES;
const MAX_DYNAMIC_VALUE_BYTES = 16_384;
const MAX_ON_DEMAND_BYTES = 256 * 1024;

function truncateDetail(
  value: string | undefined,
  maxBytes = MAX_DETAIL_STRING_BYTES,
): string | undefined {
  if (
    value === undefined ||
    (value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes)
  ) {
    return value;
  }
  // UTF-8 needs at least one byte per UTF-16 code unit. Only encode the prefix
  // that could fit, rather than allocating a buffer for the complete output.
  const prefix = Buffer.from(value.slice(0, maxBytes), "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${prefix}\n… output truncated for transport`;
}

/**
 * Bounds the text a provider file change keeps in the event log and its
 * projection. Clients never receive more than this (see projectTurnItemForWire),
 * so a full diff of a large file would only grow the database and the heap that
 * reads it back. Agents reading the thread over MCP get the bounded text.
 */
export function boundFileChangeForStorage(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "file_change") return item;
  const { diffStr, oldStr, newStr } = item;
  const bounded = {
    ...item,
    ...(diffStr === undefined ? {} : { diffStr: truncateDetail(diffStr) }),
    ...(oldStr === undefined ? {} : { oldStr: truncateDetail(oldStr) }),
    ...(newStr === undefined ? {} : { newStr: truncateDetail(newStr) }),
  };
  return bounded.diffStr === diffStr && bounded.oldStr === oldStr && bounded.newStr === newStr
    ? item
    : bounded;
}

/** Room for the marker between the kept ends. */
const EDGE_MARKER_BYTES = 64;

/**
 * The start and end of a text, within `maxBytes` of UTF-8, with a marker where
 * the middle was. Both ends matter: a command's result is in its tail, and a
 * detail read shows the start.
 */
function keepTextEdges(text: string, maxBytes: number): string {
  // A UTF-16 code unit takes at most three bytes, so most texts need no encoding.
  if (text.length * 3 <= maxBytes) return text;
  if (text.length <= maxBytes && Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const edgeBytes = Math.floor((maxBytes - EDGE_MARKER_BYTES) / 2);
  // Cut on character boundaries: a split character decodes as U+FFFD, dropped here.
  const head = Buffer.from(text.slice(0, edgeBytes), "utf8")
    .subarray(0, edgeBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  const tailBytes = Buffer.from(text.slice(-edgeBytes), "utf8");
  const tail = tailBytes
    .subarray(Math.max(0, tailBytes.length - edgeBytes))
    .toString("utf8")
    .replace(/^\uFFFD+/u, "");
  const omitted = text.length - head.length - tail.length;
  return `${head}\n… ${omitted} characters of output omitted …\n${tail}`;
}

/** Command output stored per command: this many bytes from each end. */
const STORED_COMMAND_OUTPUT_EDGE_BYTES = 64 * 1024;

/**
 * Bounds a command's output in the event log and its projection to its first
 * and last 64 KB. Finished rows show the tail (CommandOutputHub keeps 64K of
 * it) and a detail read sends at most 256 KB from the start, so the middle of
 * a long output was saved with every command but never shown.
 */
export function boundCommandOutputForStorage(
  item: OrchestrationV2TurnItem,
): OrchestrationV2TurnItem {
  if (item.type !== "command_execution" || item.output === undefined) return item;
  const output = keepTextEdges(
    item.output,
    STORED_COMMAND_OUTPUT_EDGE_BYTES * 2 + EDGE_MARKER_BYTES,
  );
  return output === item.output ? item : { ...item, output };
}

/** Each text in a tool output keeps its ends, within what a detail read sends. */
function boundToolOutputStrings(value: unknown): unknown {
  if (typeof value === "string") return keepTextEdges(value, MAX_ON_DEMAND_BYTES);
  if (typeof value !== "object" || value === null || readToolOutputImage(value) !== null) {
    return value;
  }
  let changed = false;
  const bound = (entry: unknown) => {
    const bounded = boundToolOutputStrings(entry);
    if (bounded !== entry) changed = true;
    return bounded;
  };
  const next = Array.isArray(value)
    ? value.map(bound)
    : Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bound(entry)]));
  return changed ? next : value;
}

/**
 * Bounds every text in a tool's output in the event log and its projection to
 * its first and last 128 KB: a detail read sends at most 256 KB of it
 * (projectTurnItemForDetail). Image blocks stay whole, as the asset route
 * serves their bytes by index (toolOutputImages).
 */
export function boundToolOutputForStorage(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "dynamic_tool" || item.output === undefined) return item;
  const output = boundToolOutputStrings(item.output);
  return output === item.output ? item : { ...item, output };
}

/** The opening of a streaming thought that storage keeps; see boundStreamingReasoningForStorage. */
export const STREAMING_REASONING_STORED_CHARS = 2_000;

/** How much of a live thought's latest text follows its opening. */
export const STREAMING_REASONING_LIVE_TAIL_CHARS = 1_500;

/** A live thought past its opening is written at most this often. */
export const STREAMING_REASONING_LIVE_INTERVAL_MS = 1_000;

/** Sits between a live thought's opening and its latest text. */
export const STREAMING_REASONING_ELISION = "\n\n…\n\n";

/**
 * A thought that is still streaming is stored as its opening only. Live rows
 * show just its first heading or sentence (liveThoughtLine), and some agents
 * send the whole thought so far with every chunk, which stored it again each
 * time. The finished thought is stored whole.
 *
 * Chats that show thoughts live also keep the thought's latest text
 * after the opening, starting at a line where one is near, so a long thought
 * keeps moving instead of stopping at the opening's last word.
 */
export function boundStreamingReasoningForStorage(
  item: OrchestrationV2TurnItem,
  options?: { readonly liveTail?: boolean },
): OrchestrationV2TurnItem {
  if (item.type !== "reasoning" || item.streaming !== true) return item;
  if (item.text.length <= STREAMING_REASONING_STORED_CHARS) return item;
  const opening = item.text.slice(0, STREAMING_REASONING_STORED_CHARS);
  if (options?.liveTail !== true) return { ...item, text: opening };
  const rest = item.text.slice(STREAMING_REASONING_STORED_CHARS);
  if (rest.length <= STREAMING_REASONING_LIVE_TAIL_CHARS) return item;
  let tail = rest.slice(-STREAMING_REASONING_LIVE_TAIL_CHARS);
  const lineStart = tail.indexOf("\n");
  if (lineStart !== -1 && lineStart < STREAMING_REASONING_LIVE_TAIL_CHARS / 2) {
    tail = tail.slice(lineStart + 1);
  }
  return { ...item, text: `${opening}${STREAMING_REASONING_ELISION}${tail.trimStart()}` };
}

/**
 * Tells storage whether a turn item update is worth writing. A streaming
 * thought whose stored text is unchanged is not, and one that has grown past
 * its opening (a live thought's tail) is written at most once per
 * STREAMING_REASONING_LIVE_INTERVAL_MS. Texts are kept per item until the
 * thought finishes, and bounded in case a turn dies first.
 */
export function makeStreamingThoughtFilter(): (
  item: OrchestrationV2TurnItem,
  nowMs: number,
  force?: boolean,
) => boolean {
  const written = new Map<string, { readonly text: string; readonly atMs: number }>();
  return (item, nowMs, force = false) => {
    if (item.type !== "reasoning") return true;
    const key = `${item.threadId}\u0000${item.id}`;
    if (item.streaming !== true) {
      written.delete(key);
      return true;
    }
    const previous = written.get(key);
    if (previous?.text === item.text) return false;
    if (
      !force &&
      previous !== undefined &&
      previous.text.length >= STREAMING_REASONING_STORED_CHARS &&
      nowMs - previous.atMs < STREAMING_REASONING_LIVE_INTERVAL_MS
    ) {
      return false;
    }
    written.delete(key);
    written.set(key, { text: item.text, atMs: nowMs });
    if (written.size > 1_024) written.delete(written.keys().next().value!);
    return true;
  };
}

function summarizeDynamicValue(value: unknown): unknown {
  let serialized: string;
  try {
    if (typeof value === "string" && value.length > MAX_DYNAMIC_VALUE_BYTES) {
      serialized = value;
    } else {
      const json = JSON.stringify(value) ?? String(value);
      if (Buffer.byteLength(json, "utf8") <= MAX_DYNAMIC_VALUE_BYTES) {
        return value;
      }
      serialized = typeof value === "string" ? value : json;
    }
  } catch {
    serialized = "Unserializable tool output";
  }

  // Preserve the first nonblank normalized line, but stop after the preview.
  // Splitting and normalizing every line can allocate far more than the input.
  const start = /\S/u.exec(serialized)?.index;
  let firstLine = start === undefined ? "Large tool output" : "";
  let pendingSpace = false;
  for (let index = start ?? serialized.length; index < serialized.length; index += 1) {
    const character = serialized[index]!;
    if (character === "\n") break;
    if (/\s/u.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) firstLine += " ";
    firstLine += character;
    pendingSpace = false;
    if (firstLine.length > 160) break;
  }
  return {
    summary: firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 159).trimEnd()}…`,
    truncated: true,
  };
}

export function projectTurnItemForWire(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type === "subagent") item = projectSubagentActivity(item);
  switch (item.type) {
    case "handoff": {
      const { summary: _summary, ...projected } = item;
      return projected;
    }
    case "command_execution": {
      const { output, ...projected } = item;
      // Clients used this preview to recognize provider-reported failures. Keep
      // the outcome without retaining or serializing the output that proved it.
      const failed =
        item.outputIndicatesFailure === true ||
        (item.exitCode !== undefined && item.exitCode !== 0) ||
        (output !== undefined &&
          toolOutputIndicatesFailure(output.slice(0, COMMAND_OUTPUT_FAILURE_SCAN_CHARS)));
      return {
        ...projected,
        ...(failed ? { outputIndicatesFailure: true } : {}),
        ...(output?.trim() ? { outputOmitted: true } : {}),
      };
    }
    case "file_change": {
      // File identity and counts are enough for activity. Full diffs come from
      // checkpoint diffs; storage keeps only a bounded copy of this text.
      const { diffStr, oldStr: _old, newStr: _new, ...projected } = item;
      // A failed edit stores the provider's error where the diff would be.
      return item.status === "failed" && diffStr?.trim()
        ? { ...projected, diffStr: truncateDetail(diffStr) }
        : projected;
    }
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt) ?? "",
        progress: truncateDetail(item.progress),
        result: item.result === null ? null : (truncateDetail(item.result) ?? null),
      };
    case "dynamic_tool": {
      const { output: rawOutput, ...projected } = item;
      const images = toolOutputImages(rawOutput);
      // Generated images need a tiny asset marker in the collapsed work row.
      // The image bytes stay in storage and are only served by the asset route.
      const output =
        item.toolName === "image_gen" && images.length > 0
          ? images.map((image) => ({
              type: "image",
              mimeType: image.mimeType,
              ...(image.unavailable ? { imageUnavailable: true } : {}),
            }))
          : compactDynamicToolOutput(rawOutput);
      return {
        ...projected,
        ...(images.length > 0
          ? {
              outputImages: images.map(({ mimeType, unavailable }) => ({
                mimeType,
                ...(unavailable ? { unavailable: true } : {}),
              })),
            }
          : {}),
        input: summarizeDynamicValue(item.input),
        ...(output === undefined ? {} : { output }),
        ...(hasDynamicValue(rawOutput) ? { outputOmitted: true } : {}),
      };
    }
    default:
      return item;
  }
}

function hasDynamicValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "object" || Object.keys(value).length > 0;
}

function boundDynamicValue(value: unknown): unknown {
  if (value === undefined) return value;
  if (typeof value === "string") return truncateDetail(value, MAX_ON_DEMAND_BYTES);
  let json: string;
  try {
    // Compact, so measuring does not inflate the value; clients indent it.
    json = JSON.stringify(value) ?? String(value);
  } catch {
    return "Unserializable tool value";
  }
  return Buffer.byteLength(json, "utf8") <= MAX_ON_DEMAND_BYTES
    ? value
    : truncateDetail(json, MAX_ON_DEMAND_BYTES);
}

/**
 * A tool output for a detail read, without image bytes. When the rest is too
 * large to send whole, its truncated text still comes with the image markers,
 * in order, so clients can load each image by index.
 */
function boundToolOutput(output: unknown): unknown {
  const omitted = omitToolOutputImageData(output);
  const bounded = boundDynamicValue(omitted);
  if (typeof bounded !== "string" || typeof omitted === "string") return bounded;
  const images = toolOutputImages(omitted);
  return images.length === 0
    ? bounded
    : [
        { type: "text", text: bounded },
        ...images.map((image) => ({
          type: "image",
          mimeType: image.mimeType,
          ...(image.unavailable ? { imageUnavailable: true } : {}),
        })),
      ];
}

/**
 * Projects one item for an on-demand detail read: keeps the input and output
 * the timeline withholds, bounded so a huge result cannot stall the socket.
 * Image bytes are left out; clients load them as `tool-output-image` assets.
 */
export function projectTurnItemForDetail(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type === "subagent") item = projectSubagentActivity(item);
  switch (item.type) {
    case "command_execution":
      return {
        ...item,
        input: truncateDetail(item.input, MAX_ON_DEMAND_BYTES) ?? "",
        output: truncateDetail(item.output, MAX_ON_DEMAND_BYTES),
      };
    case "dynamic_tool":
      return {
        ...item,
        input: boundDynamicValue(item.input),
        output: boundToolOutput(item.output),
      };
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt, MAX_ON_DEMAND_BYTES) ?? "",
        progress: truncateDetail(item.progress, MAX_ON_DEMAND_BYTES),
        result:
          item.result === null ? null : (truncateDetail(item.result, MAX_ON_DEMAND_BYTES) ?? null),
      };
    case "handoff":
    case "file_change":
      return projectTurnItemForWire(item);
    default:
      return item;
  }
}

export function projectContextHandoffForWire(
  handoff: OrchestrationV2ContextHandoff,
): OrchestrationV2ContextHandoff {
  const { history: _history, delivery: _delivery, brief, ...projected } = handoff;
  // Clients show who wrote a brief; the text is for the successor model only.
  return {
    ...projected,
    summaryText: "",
    ...(brief === undefined ? {} : { brief: { ...brief, text: "" } }),
  };
}

export function projectThreadProjectionForWire(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const projectedById = new Map<string, OrchestrationV2TurnItem>();
  const project = (item: OrchestrationV2TurnItem) => {
    const key = `${item.threadId}:${item.id}`;
    const existing = projectedById.get(key);
    if (existing !== undefined) return existing;
    const projected = projectTurnItemForWire(item);
    projectedById.set(key, projected);
    return projected;
  };
  return {
    ...projection,
    subagents: projection.subagents.map(projectSubagentForWire),
    contextHandoffs: projection.contextHandoffs.map(projectContextHandoffForWire),
    turnItems: projection.turnItems.map(project),
    visibleTurnItems: projection.visibleTurnItems.map((row) => ({
      ...row,
      item: project(row.item),
    })),
  };
}

export function projectDomainEventForWire(
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent {
  if (event.type === "subagent.updated")
    return { ...event, payload: projectSubagentForWire(event.payload) };
  return event.type === "turn-item.updated"
    ? { ...event, payload: projectTurnItemForWire(event.payload) }
    : event.type === "context-handoff.updated"
      ? { ...event, payload: projectContextHandoffForWire(event.payload) }
      : event;
}

const LIVE_DEDUPE_MEMORY = 32;

function remember<K, V>(memory: Map<K, V>, key: K, value: V): void {
  memory.delete(key);
  memory.set(key, value);
  if (memory.size > LIVE_DEDUPE_MEMORY) memory.delete(memory.keys().next().value as K);
}

/**
 * One per subscription, applied after coalescing so it only remembers records the client
 * received, in the snapshot or in events. A record event comes before the turn item that repeats
 * its body (adapters and the orchestrator emit them in that order), so the item can ship blank
 * and marked; so can a repeated subagent record. Emitting in the other order, or forgetting a
 * record, only costs bytes: the repeat ships whole.
 */
export function makeLiveBodyDeduper(options?: {
  readonly textAppends?: boolean;
}): (item: OrchestrationV2ThreadStreamItem) => OrchestrationV2ThreadStreamItem {
  const messageText = new Map<MessageId, string>();
  const checkpointFiles = new Map<CheckpointId, OrchestrationV2Checkpoint["files"]>();
  const subagents = new Map<NodeId, Pick<OrchestrationV2Subagent, "prompt" | "result">>();
  const source = {
    messageText: (id: MessageId) => messageText.get(id),
    checkpointFiles: (id: CheckpointId) => checkpointFiles.get(id),
    subagent: (id: NodeId) => subagents.get(id),
  };
  const rememberSubagent = ({ id, prompt, result }: OrchestrationV2Subagent) =>
    remember(subagents, id, { prompt, result });
  return (item) => {
    if (item.kind === "snapshot") {
      messageText.clear();
      checkpointFiles.clear();
      subagents.clear();
      // The client now holds exactly these records; their bodies are never blanked.
      const { messages, checkpoints, subagents: records } = item.projection;
      for (const message of messages) remember(messageText, message.id, message.text);
      for (const checkpoint of checkpoints)
        remember(checkpointFiles, checkpoint.id, checkpoint.files);
      for (const subagent of records) rememberSubagent(subagent);
      return item;
    }
    if (item.kind !== "event") return item;
    const { event } = item;
    switch (event.type) {
      case "message.updated": {
        const previous = messageText.get(event.payload.id);
        remember(messageText, event.payload.id, event.payload.text);
        if (
          options?.textAppends === true &&
          previous !== undefined &&
          previous.length >= 512 &&
          event.payload.text.startsWith(previous)
        ) {
          return {
            ...item,
            textAppendFrom: previous.length,
            event: {
              ...event,
              payload: { ...event.payload, text: event.payload.text.slice(previous.length) },
            },
          };
        }
        return item;
      }
      case "checkpoint.captured":
        remember(checkpointFiles, event.payload.id, event.payload.files);
        return item;
      case "subagent.updated": {
        const payload = dedupeSubagentBodies(event.payload, subagents.get(event.payload.id));
        rememberSubagent(event.payload);
        return payload === event.payload ? item : { ...item, event: { ...event, payload } };
      }
      case "turn-item.updated": {
        const payload = dedupeTurnItemBodies(event.payload, source);
        return payload === event.payload ? item : { ...item, event: { ...event, payload } };
      }
      default:
        return item;
    }
  };
}
