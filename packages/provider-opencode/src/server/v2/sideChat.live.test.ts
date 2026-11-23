// @effect-diagnostics nodeBuiltinImport:off
// The opt-in contract test owns its native process and loopback model endpoint.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AbsolutePath, Location, Model, Provider } from "@opencode/client/effect";
import { ProviderInstanceId, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import { describe } from "vite-plus/test";

import { OPENCODE_PROVIDER } from "../adapter.ts";
import * as OpenCode2Client from "./OpenCode2Client.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";
import { make } from "./adapter.ts";

interface WireRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools: unknown[];
  prompt_cache_key?: string;
  stream?: boolean;
}

// No credentials or external model calls. The real harness builds every request;
// this loopback provider records the compiled bytes and supplies fixed answers.
async function start(binary: string) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-btw-prefix-"));
  const directory = NodePath.join(root, "work");
  await NodeFSP.mkdir(directory);
  const requests: Array<{ body: WireRequest; headers: NodeHttp.IncomingHttpHeaders }> = [];
  const pending = Promise.withResolvers<void>();
  let release: (() => void) | undefined;
  const reply = (response: NodeHttp.ServerResponse, streaming: boolean, text: string) => {
    const base = { id: "chatcmpl-test", created: 1, model: "test", object: "chat.completion" };
    if (streaming) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n` +
          `data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 } })}\n\n` +
          "data: [DONE]\n\n",
      );
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          ...base,
          choices: [
            { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 },
        }),
      );
    }
  };
  const upstream = NodeHttp.createServer(async (request, response) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as WireRequest;
    requests.push({ body, headers: request.headers });
    if (requests.length === 2) {
      release = () => {
        release = undefined;
        reply(response, body.stream === true, "MAIN_SECOND");
      };
      pending.resolve();
    } else {
      reply(response, body.stream === true, requests.length === 1 ? "MAIN_FIRST" : "SIDE_ANSWER");
    }
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  assert(address !== null && typeof address !== "string");
  await NodeFSP.writeFile(
    NodePath.join(directory, "opencode.json"),
    JSON.stringify({
      model: "btw-test/test",
      update: "disable",
      providers: {
        "btw-test": {
          package: "@opencode/ai/providers/openai-compatible",
          settings: {
            baseURL: `http://127.0.0.1:${address.port}/v1`,
            apiKey: "test",
            provider: "btw-test",
          },
          models: {
            test: {
              capabilities: { tools: true, input: ["text"], output: ["text"] },
              limit: { context: 200000, output: 1024 },
            },
          },
        },
      },
    }),
  );
  const child = NodeChildProcess.spawn(binary, ["serve", "--hostname=127.0.0.1", "--port=0"], {
    cwd: directory,
    env: {
      PATH: process.env.PATH,
      HOME: root,
      XDG_CONFIG_HOME: NodePath.join(root, "config"),
      XDG_DATA_HOME: NodePath.join(root, "data"),
      XDG_STATE_HOME: NodePath.join(root, "state"),
      XDG_CACHE_HOME: NodePath.join(root, "cache"),
      OPENCODE_PASSWORD: "btw-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const stop = async () => {
    try {
      release?.();
    } finally {
      child.kill("SIGTERM");
      await closed;
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        upstream.close((error) => (error ? reject(error) : resolve())),
      );
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  };
  try {
    const ready = Promise.withResolvers<string>();
    child.once("error", ready.reject);
    const lines = NodeReadline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      const url = /server listening on\s+(https?:\/\/\S+)/i.exec(line)?.[1];
      if (url) ready.resolve(url);
    });
    void closed.then(() => ready.reject(new Error(`OpenCode exited: ${stderr}`)));
    return {
      url: await ready.promise,
      directory,
      requests,
      pending: pending.promise,
      release: () => release?.(),
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

const binary = process.env.OPENCODE2_SIDECHAT_BIN;
const layer = Layer.mergeAll(
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
  IdAllocator.layer,
  McpProviderSessions.layer,
  OpenCode2Client.layer.pipe(Layer.provide(FetchHttpClient.layer)),
  NodeServices.layer,
);

describe.runIf(binary !== undefined)("OpenCode /btw native prefix contract", () => {
  it.live(
    "preserves compiled model, tools, cache affinity and history while the main turn runs",
    () =>
      Effect.gen(function* () {
        const native = yield* Effect.acquireRelease(
          Effect.promise(() => start(binary!)),
          (native) => Effect.promise(() => native.stop()),
        );
        const api = yield* OpenCode2Client.OpenCode2Client;
        const connection = yield* api.connect({ baseUrl: native.url, password: "btw-test" });
        const { client } = connection;
        const session = yield* client.session.create({
          title: "native side question contract",
          location: Location.PublicRef.make({ directory: AbsolutePath.make(native.directory) }),
          model: Model.Ref.make({
            providerID: Provider.ID.make("btw-test"),
            id: Model.ID.make("test"),
          }),
        });
        yield* client.session.prompt({ sessionID: session.id, text: "first main question" });
        yield* client.session.wait({ sessionID: session.id });
        yield* client.session.prompt({ sessionID: session.id, text: "second main question" });
        yield* Effect.promise(() => native.pending);
        const beforeMessages = yield* client.message.list({ sessionID: session.id });
        const beforeSession = yield* client.session.get({ sessionID: session.id });
        const instanceId = ProviderInstanceId.make("opencode");
        const threadId = ThreadId.make("thread:live-btw");
        const adapter = yield* make(instanceId).pipe(
          Effect.provideService(OpenCode2Server.OpenCode2Server, {
            retire: Effect.void,
            withConnection: (use) =>
              use({ ...connection, url: native.url, version: "2", external: true }),
          }),
        );
        const now = yield* DateTime.now;
        const side = yield* adapter.openSideChat!({
          threadId,
          providerThread: {
            id: ProviderThreadId.make("provider-thread:live-btw"),
            driver: OPENCODE_PROVIDER,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: {
              driver: OPENCODE_PROVIDER,
              nativeId: session.id,
              strength: "strong",
            },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
          modelSelection: { instanceId, model: "btw-test/test" },
          runtimePolicy: {
            cwd: native.directory,
            runtimeMode: "full-access",
            interactionMode: "default",
          },
        });
        const updates: string[] = [];
        assert.equal(
          yield* side.ask({
            prompt: "side question",
            onUpdate: (update) =>
              Effect.sync(() => {
                assert.equal(update.type, "text");
                if (update.type === "text") updates.push(update.text);
              }),
          }),
          "SIDE_ANSWER",
        );
        assert.deepEqual(updates, ["SIDE_ANSWER"]);
        assert.lengthOf(native.requests, 3);
        const main = native.requests[1]!;
        const btw = native.requests[2]!;
        assert.equal(btw.body.model, main.body.model);
        assert.isNotEmpty(main.body.tools);
        assert.equal(JSON.stringify(btw.body.tools), JSON.stringify(main.body.tools));
        // All system instructions and completed tool/text history remain byte
        // identical; only the final side-question user message is appended.
        assert.equal(
          JSON.stringify(btw.body.messages.slice(0, -1)),
          JSON.stringify(main.body.messages),
        );
        assert.equal(btw.body.prompt_cache_key, main.body.prompt_cache_key);
        assert.isString(main.headers["x-session-affinity"]);
        assert.equal(btw.headers["x-session-affinity"], main.headers["x-session-affinity"]);
        assert.equal(btw.headers["x-opencode-session-id"], session.id);
        assert.deepEqual(yield* client.message.list({ sessionID: session.id }), beforeMessages);
        assert.deepEqual(yield* client.session.get({ sessionID: session.id }), beforeSession);
        assert.property(yield* client.session.active(), session.id);
        native.release();
        yield* client.session.wait({ sessionID: session.id });
        const after = yield* client.message.list({ sessionID: session.id });
        assert.include(JSON.stringify(after), "MAIN_SECOND");
        assert.notInclude(JSON.stringify(after), "SIDE_ANSWER");
        assert.notInclude(JSON.stringify(after), "side question");
      }).pipe(Effect.scoped, Effect.provide(layer)),
    90_000,
  );
});
