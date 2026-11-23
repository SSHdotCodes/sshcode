import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  CodexSettings,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as CodexError from "effect-codex-app-server/errors";
import * as CodexClient from "effect-codex-app-server/client";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ClaudeAdapter from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapter from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  CODEX_SIDE_CONVERSATION_BOUNDARY,
  CODEX_SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS,
} from "../provider/CodexSideConversation.ts";

const decodeClaudeSettings = Schema.decodeEffect(ClaudeSettings);
const decodeCodexSettings = Schema.decodeEffect(CodexSettings);
const testLayer = Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer);
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});
const inputFor = Effect.fnUntraced(function* (driver: "claudeAgent" | "codex") {
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("native-side-test");
  const providerInstanceId = ProviderInstanceId.make(driver);
  const providerThread: OrchestrationV2ProviderThread = {
    id: ProviderThreadId.make("provider-thread"),
    driver: driver === "codex" ? CodexAdapter.CODEX_DRIVER_KIND : ClaudeAdapter.CLAUDE_PROVIDER,
    providerInstanceId,
    providerSessionId: null,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: {
      driver: driver === "codex" ? CodexAdapter.CODEX_DRIVER_KIND : ClaudeAdapter.CLAUDE_PROVIDER,
      nativeId: "native-parent",
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  return {
    threadId,
    providerThread,
    modelSelection: {
      instanceId: providerInstanceId,
      model: "test-model",
      options: [{ id: "reasoningEffort", value: "high" }],
    },
    runtimePolicy,
  };
});

describe("native side chat mechanisms", () => {
  it.effect(
    "Claude reuses one SDK side-question process and its native history without a provider turn",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        let opens = 0;
        const questions: Array<unknown> = [];
        let options: ClaudeAdapter.ClaudeAgentSdkQueryOptions | undefined;
        const adapter = yield* ClaudeAdapter.makeClaudeAdapterV2({
          instanceId: ClaudeAdapter.CLAUDE_DEFAULT_INSTANCE_ID,
          settings: yield* decodeClaudeSettings({}),
          environment: {},
          attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: "side-claude-" }),
          fileSystem,
          path: yield* Path.Path,
          crypto: yield* Crypto.Crypto,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          queryRunner: {
            allocateSessionId: Effect.die("Side questions must not allocate a new native session"),
            forkSession: () => Effect.die("Side questions use the SDK control request"),
            subagentLaunchToolUseId: () => Effect.succeed(null),
            assertComplete: Effect.void,
            open: (input) =>
              Effect.sync(() => {
                opens++;
                options = input.options;
                return {
                  messages: Stream.never,
                  offer: () => Effect.die("No provider turns for a side question"),
                  setModel: () => Effect.void,
                  applyFlagSettings: () => Effect.void,
                  setPermissionMode: () => Effect.void,
                  backgroundTasks: () => Effect.succeed(false),
                  stopTask: () => Effect.void,
                  interrupt: Effect.void,
                  close: Effect.void,
                  askSideQuestion: (question, history) =>
                    Effect.sync(() => {
                      questions.push({ question, history });
                      return { response: `answer: ${question}`, synthetic: false };
                    }),
                };
              }),
          },
        });
        const chat = yield* adapter.openSideChat!(yield* inputFor("claudeAgent"));
        assert.equal(
          yield* chat.ask({ prompt: "first", onUpdate: () => Effect.void }),
          "answer: first",
        );
        assert.equal(
          yield* chat.ask({ prompt: "second", onUpdate: () => Effect.void }),
          "answer: second",
        );
        assert.equal(opens, 1);
        assert.deepEqual(questions, [
          { question: "first", history: [] },
          { question: "second", history: [{ question: "first", response: "answer: first" }] },
        ]);
        assert.equal(options?.resume, "native-parent");
        assert.equal(options?.forkSession, true);
        assert.equal(options?.cwd, "/workspace");
        assert.equal(options?.model, "test-model");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("Claude follows the thread after opening while no CLI ran", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const forks: Array<ClaudeAdapter.ClaudeAgentSdkQueryOptions> = [];
      let closes = 0;
      const adapter = yield* ClaudeAdapter.makeClaudeAdapterV2({
        instanceId: ClaudeAdapter.CLAUDE_DEFAULT_INSTANCE_ID,
        settings: yield* decodeClaudeSettings({}),
        environment: {},
        attachmentsDir: yield* fileSystem.makeTempDirectoryScoped({ prefix: "side-claude-" }),
        fileSystem,
        path: yield* Path.Path,
        crypto: yield* Crypto.Crypto,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.die("Side questions must not allocate a new native session"),
          forkSession: () => Effect.die("Side questions use the SDK control request"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
          open: (input) =>
            Effect.sync(() => {
              const head = input.options.resumeSessionAt;
              forks.push(input.options);
              return {
                messages: Stream.never,
                offer: () => Effect.die("No provider turns for a side question"),
                setModel: () => Effect.void,
                applyFlagSettings: () => Effect.void,
                setPermissionMode: () => Effect.void,
                backgroundTasks: () => Effect.succeed(false),
                stopTask: () => Effect.void,
                interrupt: Effect.void,
                close: Effect.sync(() => {
                  closes++;
                }),
                askSideQuestion: (question) =>
                  Effect.succeed({
                    response: `fork ${head ?? "start"}: ${question}`,
                    synthetic: false,
                  }),
              };
            }),
        },
      });
      const input = yield* inputFor("claudeAgent");
      // Opened right after a restart: no CLI runs and the fork starts at the old head.
      let current: ProviderAdapter.ProviderAdapterV2SideChatCurrent = {
        providerThread: input.providerThread,
      };
      const chat = yield* adapter.openSideChat!({
        ...input,
        current: Effect.sync(() => current),
      });
      const ask = (prompt: string) => chat.ask({ prompt, onUpdate: () => Effect.void });
      assert.equal(yield* ask("first"), "fork start: first");

      // The main thread took a turn: the next question forks at the new head.
      current = {
        providerThread: {
          ...input.providerThread,
          nativeConversationHeadRef: {
            driver: ClaudeAdapter.CLAUDE_PROVIDER,
            nativeId: "head-2",
            strength: "strong",
          },
        },
      };
      assert.equal(yield* ask("second"), "fork head-2: second");
      assert.equal(yield* ask("again"), "fork head-2: again");
      assert.deepEqual(
        forks.map((fork) => fork.resumeSessionAt),
        [undefined, "head-2"],
      );
      assert.equal(closes, 1);

      // A normal turn changes the ordinal even when there is no rollback head.
      current = { providerThread: { ...input.providerThread, lastRunOrdinal: 2 } };
      yield* ask("after turn");
      assert.equal(forks.length, 3);
      current = {
        ...current,
        providerThread: {
          ...current.providerThread,
          nativeThreadRef: {
            driver: ClaudeAdapter.CLAUDE_PROVIDER,
            nativeId: "native-replacement",
            strength: "strong",
          },
        },
      };
      yield* ask("after reset");
      assert.equal(forks.at(-1)?.resume, "native-replacement");
      assert.isUndefined(forks.at(-1)?.resumeSessionAt);

      current = { ...current, modelSelection: { ...input.modelSelection, model: "new-model" } };
      yield* ask("after model change");
      assert.equal(forks.at(-1)?.model, "new-model");
      current = { ...current, runtimePolicy: { ...input.runtimePolicy, interactionMode: "plan" } };
      yield* ask("after policy change");
      assert.equal(forks.at(-1)?.permissionMode, "plan");
      current = {
        ...current,
        providerThread: {
          ...current.providerThread,
          nativeThreadRef: {
            driver: ClaudeAdapter.CLAUDE_PROVIDER,
            nativeId: "another-replacement",
            strength: "strong",
          },
          nativeConversationHeadRef: {
            driver: ClaudeAdapter.CLAUDE_PROVIDER,
            nativeId: "replacement-head",
            strength: "strong",
          },
        },
      };
      yield* ask("after another reset");
      assert.equal(forks.at(-1)?.resume, "another-replacement");
      assert.equal(forks.at(-1)?.resumeSessionAt, "replacement-head");
      assert.equal(closes, 6);

      // The thread's CLI is running again: it answers, with the chat's history.
      const liveQuestions: Array<unknown> = [];
      const liveRuntime: Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "askSideQuestion"> =
        {
          askSideQuestion: (request) =>
            Effect.sync(() => {
              liveQuestions.push({ question: request.question, history: request.history });
              return Option.some({ response: `live: ${request.question}` });
            }),
        };
      current = {
        ...current,
        liveRuntime: liveRuntime as ProviderAdapter.ProviderAdapterV2SessionRuntime,
      };
      assert.equal(yield* ask("third"), "live: third");
      assert.equal(forks.length, 7);
      assert.deepEqual(liveQuestions, [
        {
          question: "third",
          history: [
            { question: "first", response: "fork start: first" },
            { question: "second", response: "fork head-2: second" },
            { question: "again", response: "fork head-2: again" },
            { question: "after turn", response: "fork start: after turn" },
            { question: "after reset", response: "fork start: after reset" },
            { question: "after model change", response: "fork start: after model change" },
            { question: "after policy change", response: "fork start: after policy change" },
            {
              question: "after another reset",
              response: "fork replacement-head: after another reset",
            },
          ],
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("Codex keeps one ephemeral fork with its boundary and reuses it for follow-ups", () =>
    Effect.gen(function* () {
      const requests: Array<{ method: string; params: unknown }> = [];
      const handlers = new Map<
        string,
        (payload: never) => Effect.Effect<void, CodexError.CodexAppServerError>
      >();
      const serverRequests = new Map<
        string,
        (payload: never) => Effect.Effect<unknown, CodexError.CodexAppServerError>
      >();
      const responses: unknown[] = [];
      const activityLabels: string[] = [];
      const sleepStatuses: string[] = [];
      let turns = 0;
      const client = yield* CodexClient.CodexAppServerClient.pipe(
        Effect.provide(
          Layer.mock(CodexClient.CodexAppServerClient)({
            raw: {} as never,
            request: (method, params) =>
              Effect.gen(function* () {
                requests.push({ method, params });
                if (method === "thread/fork") return { thread: { id: "ephemeral-fork" } } as never;
                if (method === "config/read")
                  return { config: { model_reasoning_effort: "high" } } as never;
                if (method === "turn/start") {
                  turns++;
                  responses.push(
                    yield* serverRequests.get("mcpServer/elicitation/request")!({
                      threadId: "ephemeral-fork",
                      serverName: "example",
                      elicitationId: "request-1",
                      mode: "url",
                    } as never),
                  );
                  yield* handlers.get("item/started")!({
                    threadId: "ephemeral-fork",
                    item: { type: "sleep", id: "sleep", durationMs: 1500 },
                  } as never).pipe(Effect.orDie);
                  if (turns === 1)
                    yield* handlers.get("item/completed")!({
                      threadId: "ephemeral-fork",
                      item: { type: "sleep", id: "sleep", durationMs: 1500 },
                    } as never).pipe(Effect.orDie);
                  responses.push(
                    yield* serverRequests.get("item/tool/requestUserInput")!({
                      threadId: "ephemeral-fork",
                      itemId: "question-1",
                    } as never),
                  );
                  yield* handlers.get("item/agentMessage/delta")!({
                    threadId: "ephemeral-fork",
                    itemId: `answer-${requests.length}`,
                    delta: "complete answer",
                  } as never).pipe(Effect.orDie);
                  yield* handlers.get("turn/completed")!({
                    threadId: "ephemeral-fork",
                    turn: { status: turns === 1 ? "completed" : "interrupted" },
                  } as never).pipe(Effect.orDie);
                }
                return {} as never;
              }),
            notify: () => Effect.void,
            handleServerRequest: (method, handler) =>
              Effect.sync(() => {
                serverRequests.set(method, handler);
              }),
            handleServerNotification: (method, handler) =>
              Effect.sync(() => {
                handlers.set(method, handler);
              }),
          }),
        ),
      );
      let opens = 0;
      const adapter = yield* CodexAdapter.makeCodexAdapterV2({
        instanceId: CodexAdapter.CODEX_DEFAULT_INSTANCE_ID,
        settings: yield* decodeCodexSettings({}),
        environment: {},
        clientFactory: {
          open: () =>
            Effect.sync(() => {
              opens++;
              return client;
            }),
        },
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
      });
      const chat = yield* adapter.openSideChat!(yield* inputFor("codex"));
      assert.equal(
        yield* chat.ask({
          prompt: "first",
          onUpdate: (update) =>
            Effect.sync(() => {
              if (update.type === "activity") {
                activityLabels.push(update.activity.label);
                if (update.activity.id === "sleep") sleepStatuses.push(update.activity.status);
              }
            }),
        }),
        "complete answer",
      );
      assert.equal(
        yield* chat.ask({
          prompt: "second",
          onUpdate: (update) =>
            Effect.sync(() => {
              if (update.type === "activity" && update.activity.id === "sleep")
                sleepStatuses.push(update.activity.status);
            }),
        }),
        "complete answer",
      );
      assert.equal(opens, 1);
      assert.deepEqual(responses, [
        { action: "decline" },
        { answers: {} },
        { action: "decline" },
        { answers: {} },
      ]);
      assert.deepEqual(activityLabels, [
        "Side conversation cannot answer an MCP request",
        "Wait 1.5s",
        "Waited 1.5s",
        "Side conversation cannot answer a tool question",
      ]);
      assert.deepEqual(sleepStatuses, ["running", "completed", "running", "failed"]);
      assert.equal(requests.filter((request) => request.method === "thread/fork").length, 1);
      assert.deepInclude(requests.find((request) => request.method === "thread/fork")?.params, {
        threadId: "native-parent",
        ephemeral: true,
        excludeTurns: true,
        developerInstructions: CODEX_SIDE_CONVERSATION_DEVELOPER_INSTRUCTIONS,
      });
      assert.deepEqual(
        requests.find((request) => request.method === "thread/inject_items")?.params,
        {
          threadId: "ephemeral-fork",
          items: [
            {
              type: "message",
              role: "developer",
              content: [{ type: "input_text", text: CODEX_SIDE_CONVERSATION_BOUNDARY }],
            },
          ],
        },
      );
      assert.equal(requests.filter((request) => request.method === "turn/start").length, 2);
      assert.equal(
        requests.some((request) => request.method === "thread/start"),
        false,
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          testLayer,
          ServerConfig.layerTest(process.cwd(), { prefix: "side-codex-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
  );

  it.effect("Codex fails a side answer when its app-server exits mid-turn", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<CodexError.CodexAppServerError>();
      const client = yield* CodexClient.CodexAppServerClient.pipe(
        Effect.provide(
          Layer.mock(CodexClient.CodexAppServerClient)({
            raw: {} as never,
            request: (method) =>
              Effect.gen(function* () {
                if (method === "thread/fork") return { thread: { id: "ephemeral-fork" } } as never;
                if (method === "config/read")
                  return { config: { model_reasoning_effort: "high" } } as never;
                // The turn is admitted, then the process dies before turn/completed.
                if (method === "turn/start") {
                  yield* Deferred.succeed(
                    exited,
                    new CodexError.CodexAppServerProcessExitedError({ code: 1 }),
                  );
                }
                return {} as never;
              }),
            notify: () => Effect.void,
            handleServerRequest: () => Effect.void,
            handleServerNotification: () => Effect.void,
            awaitTermination: Deferred.await(exited),
          }),
        ),
      );
      const adapter = yield* CodexAdapter.makeCodexAdapterV2({
        instanceId: CodexAdapter.CODEX_DEFAULT_INSTANCE_ID,
        settings: yield* decodeCodexSettings({}),
        environment: {},
        clientFactory: { open: () => Effect.succeed(client) },
        crypto: yield* Crypto.Crypto,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* ServerConfig.ServerConfig,
      });
      const chat = yield* adapter.openSideChat!(yield* inputFor("codex"));
      const error = yield* chat
        .ask({ prompt: "first", onUpdate: () => Effect.void })
        .pipe(Effect.timeout("5 seconds"), Effect.flip);
      assert.include(String(error), "Codex stopped before the side answer finished");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.merge(
          testLayer,
          ServerConfig.layerTest(process.cwd(), { prefix: "side-codex-exit-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
  );
});
