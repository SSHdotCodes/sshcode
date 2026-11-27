import type { AcpSubagentTranscriptEntry } from "@t3tools/provider-acp/server/adapter";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { sanitizeAntigravityToolPayload } from "./AntigravityProtocol.ts";

class AntigravityChildWorkReadError extends Data.TaggedError("AntigravityChildWorkReadError")<{
  readonly reason: "outside_data_directory" | "too_many_inbox_files" | "invalid_inbox_file";
}> {}

const NATIVE_ID = /^[a-z0-9_-]{1,128}$/iu;
const MAX_CHILDREN = 64;
const MAX_INBOX_FILES = 256;
const MAX_MESSAGE_BYTES = 256 * 1024;
const Message = Schema.Struct({
  sender: Schema.String,
  sourceMetadata: Schema.optional(
    Schema.Struct({
      tool: Schema.optional(
        Schema.Struct({
          toolCall: Schema.optional(Schema.Struct({ id: Schema.String, name: Schema.String })),
        }),
      ),
    }),
  ),
});
const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(Message));

interface ChildProfile {
  readonly dataDirectory: string;
  readonly sessionId: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}

const openChildProfile = Effect.fnUntraced(function* ({
  dataDirectory,
  fileSystem: fs,
  path,
}: ChildProfile) {
  const root = yield* fs.realPath(dataDirectory);
  const managedPath = (parts: ReadonlyArray<string>) =>
    fs.realPath(path.join(root, ...parts)).pipe(
      Effect.filterOrFail(
        (candidate) => {
          const relative = path.relative(root, candidate);
          return (
            relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
          );
        },
        () => new AntigravityChildWorkReadError({ reason: "outside_data_directory" }),
      ),
    );
  const records = (id: string, kind: string) => ["brain", id, ".system_generated", kind];
  const readInbox = (id: string) =>
    Effect.gen(function* () {
      const directory = records(id, "messages");
      const names = (yield* fs.readDirectory(yield* managedPath(directory))).filter(
        (name) => name.endsWith(".json") && name !== "read.json",
      );
      if (names.length > MAX_INBOX_FILES)
        return yield* new AntigravityChildWorkReadError({ reason: "too_many_inbox_files" });
      const decoded = yield* Effect.forEach(names, (name) =>
        Effect.gen(function* () {
          const file = yield* managedPath([...directory, name]);
          const stat = yield* fs.stat(file);
          if (stat.type !== "File" || stat.size > MAX_MESSAGE_BYTES) {
            return yield* new AntigravityChildWorkReadError({ reason: "invalid_inbox_file" });
          }
          const bytes = yield* fs.open(file, { flag: "r" }).pipe(
            Effect.flatMap((handle) => handle.readAlloc(Number(stat.size) + 1)),
            Effect.scoped,
          );
          if (Option.isNone(bytes) || bytes.value.length !== Number(stat.size)) {
            return yield* new AntigravityChildWorkReadError({ reason: "invalid_inbox_file" });
          }
          return yield* decodeMessage(new TextDecoder().decode(bytes.value));
        }).pipe(Effect.option),
      );
      return decoded.flatMap((entry) => (Option.isSome(entry) ? [entry.value] : []));
    });
  const childIds = (id: string) =>
    managedPath(records(id, "subagents")).pipe(
      Effect.flatMap(fs.readDirectory),
      Effect.map((names) =>
        names
          .filter((name) => name.endsWith(".json"))
          .map((name) => name.slice(0, -5))
          .filter((name) => NATIVE_ID.test(name)),
      ),
    );
  return { root, managedPath, records, readInbox, childIds };
});

function isChildLaunch(message: typeof Message.Type, sessionId: string) {
  const launch = message.sourceMetadata?.tool?.toolCall;
  return (
    message.sender === sessionId && (launch?.name === "invoke_subagent" || launch?.name === "swarm")
  );
}

/** Reads the launch and report envelopes that ACP omits when a child runs past the prompt. */
export const readAntigravityChildrenAtWork = Effect.fnUntraced(function* (
  input: ChildProfile & {
    readonly nativeTaskIds: ReadonlyArray<string>;
  },
) {
  const { sessionId, nativeTaskIds, fileSystem: fs, path } = input;
  if (!NATIVE_ID.test(sessionId)) return [];
  return yield* Effect.gen(function* () {
    const { root, records, readInbox, childIds: listChildIds } = yield* openChildProfile(input);
    const childIds = yield* listChildIds(sessionId);
    const parentInbox = records(sessionId, "messages");
    const parentMessages = (yield* fs.exists(path.join(root, ...parentInbox)))
      ? yield* readInbox(sessionId).pipe(Effect.orElseSucceed(() => []))
      : [];
    const reported = new Set(parentMessages.map((message) => message.sender));
    const candidates = new Set(nativeTaskIds);
    const atWork = new Set<string>();
    for (const childId of childIds) {
      if (reported.has(childId)) continue;
      // A freshly created or unreadable child inbox must not wipe out sibling children.
      const childMessages = yield* readInbox(childId).pipe(Effect.orElseSucceed(() => []));
      for (const message of childMessages) {
        const launch = message.sourceMetadata?.tool?.toolCall;
        if (
          isChildLaunch(message, sessionId) &&
          launch !== undefined &&
          candidates.has(launch.id)
        ) {
          atWork.add(launch.id);
        }
      }
    }
    return [...atWork];
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
});

const MAX_STEP_DIRECTORIES = 256;
const MAX_STEP_OUTPUT_BYTES = 64 * 1024;
const MAX_CHILD_IMAGES = 12;
const GENERATED_IMAGE = /saved at (\S+\.(?:png|jpe?g|webp|gif))/giu;

/**
 * The pictures one launched child saved, in the order it made them. The child is found by the
 * launch call recorded in its inbox; each `generate_image` step's output names where the picture
 * was saved. Only files inside the parent conversation's own folder count.
 */
export const readAntigravityChildImages = Effect.fnUntraced(function* (input: {
  readonly dataDirectory: string;
  readonly sessionId: string;
  readonly nativeTaskId: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const { sessionId, nativeTaskId, fileSystem: fs, path } = input;
  if (!NATIVE_ID.test(sessionId)) return [];
  return yield* Effect.gen(function* () {
    const root = yield* fs.realPath(input.dataDirectory);
    const inside = (base: string, candidate: string) => {
      const relative = path.relative(base, candidate);
      return (
        relative !== "" &&
        relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative)
      );
    };
    const managedPath = (base: string, ...parts: ReadonlyArray<string>) =>
      fs.realPath(path.join(base, ...parts)).pipe(
        Effect.filterOrFail(
          (candidate) => inside(base, candidate),
          () => new AntigravityChildWorkReadError({ reason: "outside_data_directory" }),
        ),
      );
    const readSmallFile = (file: string, maxBytes: number) =>
      Effect.gen(function* () {
        const stat = yield* fs.stat(file);
        if (stat.type !== "File" || stat.size > maxBytes) {
          return yield* new AntigravityChildWorkReadError({ reason: "invalid_inbox_file" });
        }
        const bytes = yield* fs.open(file, { flag: "r" }).pipe(
          Effect.flatMap((handle) => handle.readAlloc(maxBytes + 1)),
          Effect.scoped,
        );
        if (Option.isNone(bytes) || bytes.value.length > maxBytes) {
          return yield* new AntigravityChildWorkReadError({ reason: "invalid_inbox_file" });
        }
        return new TextDecoder().decode(bytes.value);
      });
    const records = (id: string, kind: string) => ["brain", id, ".system_generated", kind];
    const childIds = (yield* fs.readDirectory(
      yield* managedPath(root, ...records(sessionId, "subagents")),
    ))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .filter((id) => NATIVE_ID.test(id));
    if (childIds.length > MAX_CHILDREN) return [];
    let child: string | undefined;
    for (const childId of childIds) {
      const inbox = yield* managedPath(root, ...records(childId, "messages")).pipe(Effect.option);
      if (Option.isNone(inbox)) continue;
      const names = (yield* fs
        .readDirectory(inbox.value)
        .pipe(Effect.orElseSucceed(() => []))).filter(
        (name) => name.endsWith(".json") && name !== "read.json",
      );
      if (names.length > MAX_INBOX_FILES) continue;
      for (const name of names) {
        const message = yield* managedPath(inbox.value, name).pipe(
          Effect.flatMap((file) => readSmallFile(file, MAX_MESSAGE_BYTES)),
          Effect.flatMap(decodeMessage),
          Effect.option,
        );
        const launch = Option.isSome(message)
          ? message.value.sourceMetadata?.tool?.toolCall
          : undefined;
        if (
          Option.isSome(message) &&
          message.value.sender === sessionId &&
          launch?.name === "invoke_subagent" &&
          launch.id === nativeTaskId
        ) {
          child = childId;
          break;
        }
      }
      if (child !== undefined) break;
    }
    if (child === undefined) return [];
    const steps = yield* managedPath(root, ...records(child, "steps"));
    const stepNames = (yield* fs.readDirectory(steps))
      .filter((name) => /^\d{1,9}$/u.test(name))
      .toSorted((a, b) => Number(a) - Number(b));
    if (stepNames.length > MAX_STEP_DIRECTORIES) return [];
    const artifacts = yield* managedPath(root, "brain", sessionId);
    const images: Array<string> = [];
    for (const step of stepNames) {
      const output = yield* managedPath(steps, step, "output.txt").pipe(
        Effect.flatMap((file) => readSmallFile(file, MAX_STEP_OUTPUT_BYTES)),
        Effect.option,
      );
      if (Option.isNone(output)) continue;
      for (const match of output.value.matchAll(GENERATED_IMAGE)) {
        const saved = yield* fs.realPath(match[1]!).pipe(Effect.option);
        if (Option.isNone(saved) || !inside(artifacts, saved.value)) continue;
        if (!images.includes(saved.value)) images.push(saved.value);
        if (images.length >= MAX_CHILD_IMAGES) return images;
      }
    }
    return images;
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
});

const TranscriptStep = Schema.Struct({
  step_index: Schema.Int,
  type: Schema.String,
  status: Schema.optional(Schema.String),
  created_at: Schema.optional(Schema.String),
  thinking: Schema.optional(Schema.String),
  content: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  tool_calls: Schema.optional(
    Schema.Array(Schema.Struct({ name: Schema.String, args: Schema.optional(Schema.Unknown) })),
  ),
});
const decodeStep = Schema.decodeUnknownOption(Schema.fromJsonString(TranscriptStep));
const decodeArgument = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const MAX_TRANSCRIPT_BYTES = 256 * 1024;
const MAX_TRANSCRIPT_BATCH_BYTES = 512 * 1024;
const TRANSCRIPT_BOUNDARIES = new Set([
  "PLANNER_RESPONSE",
  "SYSTEM_MESSAGE",
  "USER_INPUT",
  "ERROR_MESSAGE",
]);
const OPEN_STEP_STATUSES = new Set(["PENDING", "RUNNING", "IN_PROGRESS"]);
const FAILED_STEP_STATUSES = new Set(["ERROR", "FAILED", "CANCELED", "CANCELLED"]);

function transcriptArguments(args: unknown): unknown {
  if (typeof args === "string") return Option.getOrElse(decodeArgument(args), () => args);
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  return Object.fromEntries(
    Object.entries(args).map(([key, value]) => [
      key,
      typeof value === "string" ? Option.getOrElse(decodeArgument(value), () => value) : value,
    ]),
  );
}

function transcriptEntries(
  contents: string,
  childId: string,
): ReadonlyArray<AcpSubagentTranscriptEntry> {
  const steps = new Map<number, typeof TranscriptStep.Type>();
  for (const line of contents.split("\n")) {
    const decoded = decodeStep(line);
    if (Option.isSome(decoded) && decoded.value.step_index >= 0) {
      steps.set(decoded.value.step_index, decoded.value);
    }
  }
  const ordered = [...steps.values()].sort((a, b) => a.step_index - b.step_index);
  const entries: Array<AcpSubagentTranscriptEntry> = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const step = ordered[index]!;
    const id = `${childId}:${step.step_index}`;
    const createdAt =
      step.created_at === undefined
        ? undefined
        : Option.getOrUndefined(DateTime.make(step.created_at));
    const timing = createdAt === undefined ? {} : { createdAt };
    if (step.type === "ERROR_MESSAGE") {
      const text = (step.error ?? step.content ?? "").trim();
      if (text) entries.push({ kind: "error", id, text: text.slice(0, 4_000), ...timing });
    }
    if (step.type !== "PLANNER_RESPONSE") continue;
    const thinking = step.thinking?.trim();
    const reply = step.content?.trim();
    if (thinking)
      entries.push({
        kind: "reasoning",
        id: `${id}:thinking`,
        text: thinking.slice(0, 16_000),
        running: OPEN_STEP_STATUSES.has(step.status?.toUpperCase() ?? ""),
        ...timing,
      });
    if (reply)
      entries.push({
        kind: "assistant",
        id: `${id}:reply`,
        text: reply.slice(0, 32_000),
        ...timing,
      });
    for (const [position, call] of (step.tool_calls ?? []).entries()) {
      while (ordered[index + 1]?.type === "CHECKPOINT") index += 1;
      const next = ordered[index + 1];
      const result = next !== undefined && !TRANSCRIPT_BOUNDARIES.has(next.type) ? next : undefined;
      if (result !== undefined) index += 1;
      const status = result?.status?.toUpperCase() ?? "";
      const output = (result?.error ?? result?.content ?? "")
        .replace(/^(?:(?:Created At|Completed At):[^\n]*\n)+/u, "")
        .trim();
      entries.push({
        kind: "tool",
        id: `${id}:tool:${position}`,
        name: call.name,
        input: sanitizeAntigravityToolPayload(transcriptArguments(call.args)) ?? null,
        output: output.slice(0, 8_000) || null,
        status:
          result === undefined || OPEN_STEP_STATUSES.has(status)
            ? "running"
            : FAILED_STEP_STATUSES.has(status)
              ? "failed"
              : "completed",
        ...timing,
      });
    }
  }
  return entries;
}

/** Loads the bounded tail of each transcript proven to belong to this launch. */
export const readAntigravitySubagentTranscript = Effect.fnUntraced(function* (
  input: ChildProfile & { readonly nativeTaskId: string; readonly childSessionId: string | null },
) {
  const { sessionId, nativeTaskId, childSessionId, path, fileSystem: fs } = input;
  if (!NATIVE_ID.test(sessionId)) return [];
  return yield* Effect.gen(function* () {
    const { root, managedPath, records, readInbox, childIds } = yield* openChildProfile(input);
    const listed = yield* childIds(sessionId).pipe(Effect.orElseSucceed(() => []));
    if (listed.length > MAX_CHILDREN) return [];
    const matches: string[] = [];
    for (const child of listed) {
      const inbox = yield* readInbox(child).pipe(Effect.orElseSucceed(() => []));
      if (
        inbox.some(
          (message) =>
            isChildLaunch(message, sessionId) &&
            message.sourceMetadata?.tool?.toolCall?.id === nativeTaskId,
        )
      )
        matches.push(child);
    }
    if (matches.length === 0 && childSessionId !== null && NATIVE_ID.test(childSessionId)) {
      matches.push(childSessionId);
    }
    const byteCap = Math.min(
      MAX_TRANSCRIPT_BYTES,
      Math.floor(MAX_TRANSCRIPT_BATCH_BYTES / matches.length),
    );
    const entries: AcpSubagentTranscriptEntry[] = [];
    for (const child of matches.sort()) {
      const parts = [...records(child, "logs"), "transcript.jsonl"];
      const contents = yield* Effect.gen(function* () {
        const file = yield* managedPath(parts);
        if (file !== path.join(root, ...parts)) return "";
        if ((yield* fs.stat(file)).type !== "File") return "";
        const handle = yield* fs.open(file, { flag: "r" });
        const stat = yield* handle.stat;
        if (stat.type !== "File" || stat.size === 0n) return "";
        const byteStart = stat.size > BigInt(byteCap) ? stat.size - BigInt(byteCap) : 0n;
        if (byteStart > 0n) yield* handle.seek(byteStart - 1n, "start");
        const bytes = Option.getOrUndefined(yield* handle.readAlloc(byteCap + 1));
        if (bytes === undefined) return "";
        const newline = byteStart === 0n ? -1 : bytes.indexOf(0x0a);
        if (byteStart > 0n && newline < 0) return "";
        return new TextDecoder().decode(bytes.subarray(newline + 1));
      }).pipe(
        Effect.scoped,
        Effect.orElseSucceed(() => ""),
      );
      entries.push(...transcriptEntries(contents, child));
    }
    return entries;
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<AcpSubagentTranscriptEntry> => []));
});
