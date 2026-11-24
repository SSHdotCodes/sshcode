import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

class AntigravityChildWorkReadError extends Data.TaggedError("AntigravityChildWorkReadError")<{
  readonly reason: "outside_data_directory" | "too_many_inbox_files" | "invalid_inbox_file";
}> {}

const NATIVE_ID = /^[a-z0-9_-]{1,128}$/iu;
const MAX_CHILDREN = 64;
const MAX_INBOX_FILES = 256;
const MAX_MESSAGE_BYTES = 256 * 1024;
const decodeMessage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
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
    }),
  ),
);

/** Reads the launch and report envelopes that ACP omits when a child runs past the prompt. */
export const readAntigravityChildrenAtWork = Effect.fnUntraced(function* (input: {
  readonly dataDirectory: string;
  readonly sessionId: string;
  readonly nativeTaskIds: ReadonlyArray<string>;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
}) {
  const { sessionId, nativeTaskIds, fileSystem: fs, path } = input;
  if (!NATIVE_ID.test(sessionId)) return [];
  return yield* Effect.gen(function* () {
    const root = yield* fs.realPath(input.dataDirectory);
    const managedPath = (parts: ReadonlyArray<string>) =>
      fs.realPath(path.join(root, ...parts)).pipe(
        Effect.filterOrFail(
          (candidate) => {
            const relative = path.relative(root, candidate);
            return (
              relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative)
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
        return yield* Effect.forEach(names, (name) =>
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
          }),
        );
      });
    const childIds = (yield* fs.readDirectory(yield* managedPath(records(sessionId, "subagents"))))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5))
      .filter((id) => NATIVE_ID.test(id));
    if (childIds.length === 0 || childIds.length > MAX_CHILDREN) return [];
    const parentInbox = records(sessionId, "messages");
    const parentMessages = (yield* fs.exists(path.join(root, ...parentInbox)))
      ? yield* readInbox(sessionId)
      : [];
    const reported = new Set(parentMessages.map((message) => message.sender));
    const candidates = new Set(nativeTaskIds);
    const atWork = new Set<string>();
    for (const childId of childIds) {
      if (reported.has(childId)) continue;
      for (const message of yield* readInbox(childId)) {
        const launch = message.sourceMetadata?.tool?.toolCall;
        if (
          message.sender === sessionId &&
          launch?.name === "invoke_subagent" &&
          candidates.has(launch.id)
        ) {
          atWork.add(launch.id);
        }
      }
    }
    return [...atWork];
  }).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
});
