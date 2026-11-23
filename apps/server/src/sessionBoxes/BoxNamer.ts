// @effect-diagnostics-next-line nodeBuiltinImport:off -- llama-server listens on a Unix socket, which HttpClient cannot reach.
import * as NodeHttp from "node:http";

import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as SqlClient from "effect/sql/SqlClient";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import {
  boxNamerCache,
  boxTitles,
  type BoxNamerBasis,
  type BoxNamerEntry,
} from "./boxNamerCache.ts";

/**
 * Names session boxes with a small local text model: from a chat's title, the user's
 * latest typed requests and the end of the agent's last reply it writes a short name and
 * what the chat is on now. It runs on this Mac with llama.cpp, only for chats whose title
 * or latest request changed, and its server process exits after a quiet spell, so an idle
 * app costs nothing. Without the model or llama.cpp, boxes keep their rule-based text.
 */

const MODEL_DIR = ["models", "box-namer"] as const;
const CACHE_FILE = "box-names.json";
/** Chats the user named themselves, whose titles the namer never replaces. */
const TITLES_BY_HAND_FILE = "box-titles-by-hand.json";
const IDLE_STOP = Duration.minutes(2);
const START_TIMEOUT = Duration.seconds(30);
const LLAMA_SERVER_CANDIDATES = ["/opt/homebrew/bin/llama-server", "/usr/local/bin/llama-server"];

const Manifest = Schema.Struct({
  /** box-v2 models also decide when a chat's work has moved to a new title. */
  format: Schema.Literals(["box-v1", "box-v2"]),
  file: Schema.String,
  nPredict: Schema.optional(Schema.Number),
  stop: Schema.optional(Schema.Array(Schema.String)),
  temperature: Schema.optional(Schema.Number),
});
type Manifest = typeof Manifest.Type;
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));

const CacheEntry = Schema.Struct({
  title: Schema.String,
  requestId: Schema.String,
  name: Schema.NullOr(Schema.String),
  now: Schema.NullOr(Schema.String),
  retitle: Schema.optional(Schema.NullOr(Schema.String)),
});
const CacheFile = Schema.Struct({
  version: Schema.Literal(1),
  entries: Schema.Record(Schema.String, CacheEntry),
});
const decodeCache = Schema.decodeUnknownEffect(Schema.fromJsonString(CacheFile));
const TitlesByHandFile = Schema.Struct({
  version: Schema.Literal(1),
  threadIds: Schema.Array(Schema.String),
});
const decodeTitlesByHand = Schema.decodeUnknownEffect(Schema.fromJsonString(TitlesByHandFile));
const encodeTitlesByHand = Schema.encodeEffect(Schema.fromJsonString(TitlesByHandFile));
const encodeCache = Schema.encodeEffect(Schema.fromJsonString(CacheFile));

class BoxNamerError extends Schema.TaggedError<BoxNamerError>()("BoxNamerError", {
  reason: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Box namer: ${this.reason}.`;
  }
}

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const Completion = Schema.Struct({ content: Schema.String });
const decodeCompletion = Schema.decodeUnknownEffect(Schema.fromJsonString(Completion));

export interface BoxNamerInput {
  readonly title: string;
  /** The latest typed requests, oldest first. */
  readonly asks: ReadonlyArray<string>;
  /** The end of the agent's last finished reply before the latest request, if any. */
  readonly reply: string | null;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/** The model's prompt, in the exact `box-v1` format it was trained on. */
export function boxNamerPrompt(input: BoxNamerInput): string {
  const title = oneLine(input.title.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")).slice(0, 160);
  const asks = input.asks
    .slice(-3)
    .map((ask) => `- ${oneLine(ask).slice(0, 240)}`)
    .filter((line) => line.length > 2);
  const reply = input.reply === null ? "" : oneLine(input.reply).slice(-300);
  return [
    "<title>",
    title,
    "<asks>",
    ...(asks.length > 0 ? asks : ["-"]),
    "<reply>",
    reply.length > 0 ? reply : "-",
    "<box>",
    "",
  ].join("\n");
}

/** Reads `Name: …` and `Now: …` from the model's output; bad or overlong lines become null. */
export function parseBoxNamerOutput(text: string): {
  name: string | null;
  now: string | null;
  retitle: string | null;
} {
  const field = (key: string, max: number) => {
    const match = new RegExp(`^${key}:[ \\t]*(.*)$`, "mu").exec(text);
    const value = match?.[1]?.trim() ?? "";
    return value.length === 0 || value === "-" || value.length > max ? null : value;
  };
  // box-v1 models write no Title line, so they never rename a chat.
  return { name: field("Name", 40), now: field("Now", 60), retitle: field("Title", 48) };
}

/** One HTTP request to llama-server over its Unix socket. */
function socketRequest(
  socketPath: string,
  method: "GET" | "POST",
  path: string,
  payload?: string,
): Effect.Effect<{ readonly status: number; readonly body: string }, BoxNamerError> {
  const failed = (cause: unknown) =>
    Effect.fail(new BoxNamerError({ reason: "llama-server request failed", cause }));
  return Effect.callback<{ readonly status: number; readonly body: string }, BoxNamerError>(
    (resume) => {
      const request = NodeHttp.request(
        {
          socketPath,
          method,
          path,
          headers:
            payload === undefined
              ? {}
              : {
                  "content-type": "application/json",
                  "content-length": Buffer.byteLength(payload),
                },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on("data", (chunk: Buffer) => chunks.push(chunk));
          response.on("end", () =>
            resume(
              Effect.succeed({
                status: response.statusCode ?? 0,
                body: Buffer.concat(chunks).toString("utf8"),
              }),
            ),
          );
          response.on("error", (error) => resume(failed(error)));
        },
      );
      request.on("error", (error) => resume(failed(error)));
      request.setTimeout(30_000, () => request.destroy());
      if (payload !== undefined) request.write(payload);
      request.end();
      return Effect.sync(() => request.destroy());
    },
  );
}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const sql = yield* SqlClient.SqlClient;
  const env = yield* HostProcess.Environment;
  if ((yield* HostProcess.Platform) !== "darwin") return;

  // Renames are remembered whether or not the model is installed yet.
  const byHandPath = path.join(config.stateDir, TITLES_BY_HAND_FILE);
  const savedByHand = yield* fs.readFileString(byHandPath).pipe(
    Effect.flatMap(decodeTitlesByHand),
    Effect.map((file) => file.threadIds),
    Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
  );
  const saveByHand = Effect.gen(function* () {
    const encoded = yield* encodeTitlesByHand({ version: 1, threadIds: boxTitles.byHand() });
    yield* fs.writeFileString(`${byHandPath}.tmp`, encoded, { mode: 0o600 });
    yield* fs.rename(`${byHandPath}.tmp`, byHandPath);
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not save renamed chats.", { cause })),
  );
  const saves = yield* Queue.sliding<void>(1);
  boxTitles.load(savedByHand, () => Queue.offerUnsafe(saves, undefined));
  yield* Queue.take(saves).pipe(Effect.andThen(saveByHand), Effect.forever, Effect.forkScoped);

  // Looks for the model now and every few minutes until it's installed, so a model that
  // lands while the app runs turns the namer on without a restart.
  const modelDir = path.join(config.stateDir, ...MODEL_DIR);
  // The installed model, read again before each use: a newer one can replace it while the
  // app runs (the manifest then names another file).
  const readModel = fs.readFileString(path.join(modelDir, "manifest.json")).pipe(
    Effect.flatMap(decodeManifest),
    Effect.map((manifest) => ({ manifest, file: path.join(modelDir, manifest.file) })),
    Effect.option,
  );
  const start = Effect.gen(function* () {
    const manifest = yield* readModel.pipe(Effect.map(Option.map((model) => model.manifest)));
    if (Option.isNone(manifest)) return false;
    const modelFile = path.join(modelDir, manifest.value.file);
    const binary = yield* Effect.findFirst(
      [env.T3CODE_LLAMA_SERVER ?? "", ...LLAMA_SERVER_CANDIDATES].filter(Boolean),
      (candidate) => fs.exists(candidate).pipe(Effect.orElseSucceed(() => false)),
    );
    if (
      Option.isNone(binary) ||
      !(yield* fs.exists(modelFile).pipe(Effect.orElseSucceed(() => false)))
    )
      return false;
    yield* Effect.logInfo("Box namer is on.", { model: manifest.value.file });

    const cachePath = path.join(config.stateDir, CACHE_FILE);
    const saved = yield* fs.readFileString(cachePath).pipe(
      Effect.flatMap(decodeCache),
      Effect.map((file) => Object.entries(file.entries)),
      Effect.orElseSucceed(() => [] as Array<[string, BoxNamerEntry]>),
    );
    const signal = yield* Queue.sliding<void>(1);
    boxNamerCache.activate(saved, () => Queue.offerUnsafe(signal, undefined));
    yield* Effect.addFinalizer(() => Effect.sync(() => boxNamerCache.deactivate()));
    // Rows already sent to clients asked for nothing while the namer was off: queue every
    // open chat whose saved name is missing or stale, oldest first so the newest go first.
    const open = yield* sql<{
      readonly thread_id: string;
      readonly title: string;
      readonly message_id: string;
    }>`
      SELECT t.thread_id, t.title, r.message_id FROM orchestration_v2_projection_threads t
      JOIN (
        SELECT thread_id, message_id, updated_at, ROW_NUMBER() OVER (
          PARTITION BY thread_id ORDER BY updated_at DESC, message_id DESC
        ) AS request_rank
        FROM orchestration_v2_projection_messages
        WHERE role = 'user'
          AND json_extract(payload_json, '$.createdBy') = 'user'
          AND json_extract(payload_json, '$.creationSource') IS NOT 'server'
      ) r ON r.thread_id = t.thread_id AND r.request_rank = 1
      WHERE t.deleted_at IS NULL AND t.archived_at IS NULL
      ORDER BY r.updated_at
    `.pipe(Effect.orElseSucceed(() => []));
    for (const row of open)
      boxNamerCache.want(row.thread_id, { title: row.title, requestId: row.message_id });

    const saveCache = Effect.gen(function* () {
      const encoded = yield* encodeCache({
        version: 1,
        entries: Object.fromEntries(boxNamerCache.entries()),
      });
      yield* fs.writeFileString(`${cachePath}.tmp`, encoded, { mode: 0o600 });
      yield* fs.rename(`${cachePath}.tmp`, cachePath);
    });

    const readInput = (threadId: string, basis: BoxNamerBasis) =>
      Effect.gen(function* () {
        const asks = yield* sql<{
          readonly message_id: string;
          readonly text: string | null;
          readonly created_at: string;
        }>`
        SELECT message_id, substr(json_extract(payload_json, '$.text'), 1, 400) AS text, created_at
        FROM orchestration_v2_projection_messages
        WHERE thread_id = ${threadId}
          AND role = 'user'
          AND json_extract(payload_json, '$.createdBy') = 'user'
          AND json_extract(payload_json, '$.creationSource') IS NOT 'server'
        ORDER BY updated_at DESC, message_id DESC
        LIMIT 3
      `;
        const latest = asks[0];
        if (latest === undefined || latest.message_id !== basis.requestId) return null;
        const replies = yield* sql<{ readonly text: string | null }>`
        SELECT substr(json_extract(payload_json, '$.text'), -400) AS text
        FROM orchestration_v2_projection_messages
        WHERE thread_id = ${threadId}
          AND role = 'assistant'
          AND streaming = 0
          AND created_at < ${latest.created_at}
        ORDER BY created_at DESC
        LIMIT 1
      `;
        return {
          title: basis.title,
          asks: asks.toReversed().flatMap((ask) => (ask.text === null ? [] : [ask.text])),
          reply: replies[0]?.text ?? null,
        } satisfies BoxNamerInput;
      });

    // llama-server lives in its own scope while there is work and is closed when idle.
    let running: {
      readonly scope: Scope.Closeable;
      readonly socket: string;
      readonly model: string;
    } | null = null;
    const stopServer = Effect.suspend(() => {
      const current = running;
      running = null;
      return current === null ? Effect.void : Scope.close(current.scope, Exit.void);
    });
    const startServer = (model: string) =>
      Effect.gen(function* () {
        if (running !== null && running.model === model) return running.socket;
        if (running !== null) yield* stopServer;
        const socket = path.join(config.stateDir, "box-namer.sock");
        yield* fs.remove(socket).pipe(Effect.ignore);
        const scope = yield* Scope.make();
        yield* spawner
          .spawn(
            ChildProcess.make(
              binary.value,
              [
                "-m",
                model,
                "--host",
                socket,
                "-c",
                "1024",
                "-np",
                "1",
                "-ngl",
                "99",
                "-t",
                "4",
                "--log-disable",
              ],
              { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
            ),
          )
          .pipe(Scope.provide(scope));
        running = { scope, socket, model };
        const healthy = yield* socketRequest(socket, "GET", "/health").pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.void
              : Effect.fail(new BoxNamerError({ reason: "llama-server is loading" })),
          ),
          Effect.retry({ schedule: Schedule.spaced("250 millis") }),
          Effect.timeoutOption(START_TIMEOUT),
        );
        if (Option.isNone(healthy)) {
          yield* stopServer;
          return yield* new BoxNamerError({ reason: "llama-server did not start" });
        }
        return socket;
      });

    const nameOne = (threadId: string, basis: BoxNamerBasis) =>
      Effect.gen(function* () {
        const input = yield* readInput(threadId, basis);
        if (input === null) return;
        const model = yield* readModel;
        if (Option.isNone(model))
          return yield* new BoxNamerError({ reason: "the model was uninstalled" });
        const manifestValue: Manifest = model.value.manifest;
        const socket = yield* startServer(model.value.file);
        const response = yield* socketRequest(
          socket,
          "POST",
          "/completion",
          yield* encodeJson({
            prompt: boxNamerPrompt(input),
            n_predict: manifestValue.nPredict ?? 48,
            temperature: manifestValue.temperature ?? 0,
            stop: manifestValue.stop ?? ["\n\n"],
            cache_prompt: false,
          }),
        );
        if (response.status !== 200)
          return yield* new BoxNamerError({ reason: `llama-server answered ${response.status}` });
        const { content } = yield* decodeCompletion(response.body);
        boxNamerCache.put(threadId, { ...basis, ...parseBoxNamerOutput(content) });
      });

    // A model that fails three times in a row is broken (llama.cpp missing or too old, a bad
    // file): the namer turns itself off and boxes keep their rule-based text.
    let failures = 0;
    const work: Effect.Effect<boolean> = Effect.gen(function* () {
      const next = boxNamerCache.take();
      if (next === undefined) {
        const woke = yield* Queue.take(signal).pipe(Effect.timeoutOption(IDLE_STOP));
        if (Option.isNone(woke)) yield* stopServer;
        return true;
      }
      return yield* nameOne(next[0], next[1]).pipe(
        Effect.tap(() => saveCache.pipe(Effect.ignore)),
        Effect.as(true),
        Effect.tap(() => Effect.sync(() => (failures = 0))),
        Effect.catchCause((cause) =>
          Effect.logWarning("Box namer could not name a chat.", { cause }).pipe(
            Effect.andThen(stopServer),
            Effect.as(++failures < 3),
          ),
        ),
      );
    });
    yield* work.pipe(
      Effect.repeat({ while: (keepGoing) => keepGoing }),
      Effect.andThen(
        Effect.logWarning("Box namer turned off after repeated failures.").pipe(
          Effect.andThen(Effect.sync(() => boxNamerCache.deactivate())),
        ),
      ),
      Effect.ensuring(stopServer),
      Effect.forkScoped,
    );
    return true;
  });
  yield* start.pipe(
    Effect.repeat({ schedule: Schedule.spaced("5 minutes"), until: (started) => started }),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);
