import * as BoxFaces from "../sessionBoxes/boxFaces.ts";
import { assert, describe, it, vi } from "@effect/vitest";
import {
  type ChatAttachment,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ChatTabs from "../sessionBoxes/chatTabs.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { placeholderThreadTitle } from "./placeholderThreadTitle.ts";
import { boxNamerCache, boxTitles, subscribeRetitle } from "../sessionBoxes/boxNamerCache.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:title-regeneration");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in title regeneration tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeHarness(
  options: {
    readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
  } = {},
) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-title-regeneration" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({});
  const chatTabs = ChatTabs.make().store;
  const layerChatTabs = Layer.succeed(ChatTabs.ChatTabs, chatTabs);
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerChatTabs),
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === projectId
          ? Option.some({
              projectId,
              title: "Project",
              workspaceRoot: "/repo",
              defaultModelSelection: modelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              deletedAt: null,
            })
          : Option.none(),
      ),
  });
  const layerTitleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(layerChatTabs),
    Layer.provide(Layer.sync(BoxFaces.BoxFaces, () => BoxFaces.make().store)),
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        layerProjectedProjects,
        Layer.mock(TextGeneration.TextGeneration)({ generateThreadTitle }),
        layerServerSettings,
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerThreadManagement,
      layerTitleRegeneration,
      layerOutbox,
      layerDatabase,
    ),
    generateThreadTitle,
    chatTabs,
  };
}

function createThread(input: { readonly command: string; readonly thread: string }) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(input.thread);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(input.command),
      threadId,
      projectId,
      title: "Seed title",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });
}

function dispatchUserMessage(input: {
  readonly command: string;
  readonly threadId: ThreadId;
  readonly text: string;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(input.command),
      threadId: input.threadId,
      messageId: MessageId.make(`${input.command}:message`),
      text: input.text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
  });
}

function armRegeneration(input: { readonly command: string; readonly threadId: ThreadId }) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const requestId = CommandId.make(input.command);
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: requestId,
      threadId: input.threadId,
      regenerateTitle: true,
    });
    return requestId;
  });
}

describe("titleContextMessages", () => {
  const message = (role: string, createdBy: string, text: string, streaming = false) => ({
    role,
    createdBy,
    text,
    streaming,
  });

  it("drops automatic wake-ups so the owner's own messages are what gets sampled", () => {
    const kept = ThreadTitleRegeneration.titleContextMessages([
      message("user", "user", "Make the phone app faster"),
      message("assistant", "agent", "Started a build."),
      message("user", "agent", 'Monitor "Build 12" exited with code 0'),
      message("user", "agent", "Continue where you left off."),
      message("user", "user", "also fix the title bug"),
      message("assistant", "agent", "Still typing", true),
    ]);

    assert.deepStrictEqual(
      kept.map((entry) => entry.text),
      ["Make the phone app faster", "Started a build.", "also fix the title bug"],
    );
  });

  it("keeps an agent's brief when nobody else wrote to the chat", () => {
    const kept = ThreadTitleRegeneration.titleContextMessages([
      message("user", "agent", "Fix the flaky upload test"),
      message("assistant", "agent", "Found the race."),
      message("user", "agent", "Subagent finished"),
    ]);

    assert.equal(kept.length, 3);
  });
});

describe("formatThreadTitleContext", () => {
  const attachment = (id: string): ChatAttachment => ({
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1,
  });

  it("builds a newest-first digest, skipping system messages and empty sections", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: "First question" },
      { role: "system", text: "Hidden instructions" },
      { role: "assistant", text: "" },
      { role: "assistant", text: "Second answer", attachments: [attachment("shot")] },
    ]);
    assert.equal(
      context.message,
      "USER:\nFirst question\n\nASSISTANT:\nSecond answer\n[Attachments: shot.png]",
    );
    assert.deepEqual(
      context.attachments.map((entry) => entry.name),
      ["shot.png"],
    );
  });

  it("pins the first user message ahead of the retained tail once content stops fitting", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: `Ancient context that anchors the topic ${"x".repeat(600)}` },
      { role: "assistant", text: "y".repeat(6_000) },
      { role: "user", text: "z".repeat(1_500) },
    ]);
    assert.isTrue(context.message.includes("USER:\nAncient context that anchors the topic"));
    assert.isTrue(context.message.includes("[Earlier content truncated]\n\n"));
    assert.isTrue(context.message.includes("y".repeat(100)));
  });

  it("truncates an oversized pinned first user message", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: `Topic anchor ${"a".repeat(4_000)}` },
      { role: "assistant", text: "y".repeat(9_000) },
      { role: "user", text: "z".repeat(1_500) },
    ]);
    assert.isTrue(context.message.includes("USER:\nTopic anchor"));
    assert.isTrue(context.message.includes("[Content truncated]"));
    assert.isTrue(context.message.includes("[Earlier content truncated]\n\n"));
  });

  it("retains at most four attachments from the newest messages", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: "older", attachments: [attachment("a"), attachment("b")] },
      {
        role: "user",
        text: "newer",
        attachments: [attachment("c"), attachment("d"), attachment("e")],
      },
    ]);
    assert.deepEqual(
      context.attachments.map((entry) => entry.name),
      ["a.png", "c.png", "d.png", "e.png"],
    );
  });
});

describe("ThreadTitleRegenerationService", () => {
  it.effect("keeps a title set before the first message unless it is a placeholder", () =>
    Effect.gen(function* () {
      const seed = "work on this and pr to dev";
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        // An MCP launch names the thread, or leaves a placeholder, and sends no message.
        for (const [key, title, expectedTitle, generates] of [
          ["preset", "[API] #4821 — retry webhook deliveries after a timeout", undefined, false],
          ["placeholder", placeholderThreadTitle("Parent", 0), seed, true],
        ] as const) {
          const threadId = ThreadId.make(`thread:title:${key}`);
          yield* threads.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`command:title:${key}:create`),
            threadId,
            projectId,
            title,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "agent",
            creationSource: "mcp",
          });
          const requestId = CommandId.make(`command:title:${key}:message`);
          yield* threads.dispatch({
            type: "message.dispatch",
            commandId: requestId,
            threadId,
            messageId: MessageId.make(`command:title:${key}:message:message`),
            text: seed,
            titleSeed: seed,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "defer_start" },
            createdBy: "user",
            creationSource: "web",
          });

          const settled = yield* threads.getThreadProjection(threadId);
          assert.equal(settled.thread.title, expectedTitle ?? title, key);
          assert.equal(
            (yield* outbox.listByCommandId(requestId)).some(
              (effect) => effect.request.type === "thread-title.generate",
            ),
            generates,
            key,
          );
        }
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("arms and clears the regeneration marker through metadata commands", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadId = yield* createThread({
          command: "command:title:arm:create",
          thread: "thread:title:arm",
        });

        const firstRequest = yield* armRegeneration({ command: "command:title:arm:1", threadId });
        const armed = yield* threads.getThreadProjection(threadId);
        assert.equal(armed.thread.titleRegeneration?.requestId, firstRequest);
        assert.deepEqual(
          (yield* outbox.listByCommandId(firstRequest)).map((effect) => effect.request),
          [{ type: "thread-title.generate", kind: { type: "regenerate" } }],
        );

        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title:arm:abandon"),
          threadId,
          regenerateTitle: false,
        });
        const abandoned = yield* threads.getThreadProjection(threadId);
        assert.isNotOk(abandoned.thread.titleRegeneration);

        yield* armRegeneration({ command: "command:title:arm:2", threadId });
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title:arm:rename"),
          threadId,
          title: "Manual title",
        });
        const renamed = yield* threads.getThreadProjection(threadId);
        assert.equal(renamed.thread.title, "Manual title");
        assert.isNotOk(renamed.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("follows the work: retitles a chat that moved on, never one renamed by hand", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const threadId = yield* createThread({
          command: "command:title:follow:create",
          thread: "thread:title:follow",
        });
        const titleOf = threads
          .getThreadProjection(threadId)
          .pipe(Effect.map((projection) => projection.thread.title));
        const waitForTitle = (expected: string) =>
          titleOf.pipe(
            Effect.filterOrFail((title) => title === expected),
            Effect.retry({ schedule: Schedule.spaced("20 millis"), times: 100 }),
          );
        // The model's Title line decides renames; its now line alone never does.
        const read = (title: string, requestId: string, retitle: string | null) =>
          Effect.sync(() =>
            boxNamerCache.put(threadId, { title, requestId, name: null, now: retitle, retitle }),
          );

        // Two requests on the same new topic: the chat takes it as its title.
        yield* read("Seed title", "follow-1", "Studio phone pairing");
        yield* read("Seed title", "follow-2", "Pairing Studio with the iPhone");
        yield* waitForTitle("Pairing Studio with the iPhone");
        assert.isFalse(boxTitles.isByHand(threadId));

        // The user renames it: later topics leave that title alone.
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title:follow:rename"),
          threadId,
          title: "My own title",
        });
        assert.isTrue(boxTitles.isByHand(threadId));
        const candidates: string[] = [];
        const unsubscribe = subscribeRetitle((candidate) => candidates.push(candidate.requestId));
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        yield* read("My own title", "follow-3", "Needs you rules");
        yield* read("My own title", "follow-4", "Needs you rules for chats");
        // put processes each result synchronously. A manual title publishes no work to retitle.
        assert.deepEqual(candidates, []);
        assert.equal(yield* titleOf, "My own title");

        // Regenerating hands the title back.
        yield* armRegeneration({ command: "command:title:follow:regenerate", threadId });
        assert.isFalse(boxTitles.isByHand(threadId));
      }).pipe(Effect.provide(harness.layer), TestClock.withLive);
    }),
  );

  it.effect("skips execution when the marker was superseded by a newer request", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:stale:create",
          thread: "thread:title:stale",
        });
        const staleRequest = yield* armRegeneration({ command: "command:title:stale:1", threadId });
        const currentRequest = yield* armRegeneration({
          command: "command:title:stale:2",
          threadId,
        });

        yield* titleRegeneration.execute({
          threadId,
          requestId: staleRequest,
          kind: { type: "regenerate" },
        });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.equal(projection.thread.titleRegeneration?.requestId, currentRequest);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("lands the regenerated title from the conversation digest", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "Fresh title" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:landing:create",
          thread: "thread:title:landing",
        });
        yield* dispatchUserMessage({
          command: "command:title:landing:message",
          threadId,
          text: "Investigate the flaky login test",
        });
        const requestId = yield* armRegeneration({ command: "command:title:landing:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const call = harness.generateThreadTitle.mock.calls[0]?.[0];
        assert.equal(call?.previousTitle, "Seed title");
        assert.equal(call?.cwd, "/repo");
        assert.include(call?.message, "USER:\nInvestigate the flaky login test");
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Fresh title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("files the chat into the tab its title reply names, once", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "Bench the Sims", tab: "Black Hole" }),
      });
      yield* Effect.gen(function* () {
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:tab:create",
          thread: "thread:title:tab",
        });
        yield* dispatchUserMessage({
          command: "command:title:tab:message",
          threadId,
          text: "Benchmark the black hole simulations",
        });
        const first = yield* armRegeneration({ command: "command:title:tab:1", threadId });
        yield* titleRegeneration.execute({
          threadId,
          requestId: first,
          kind: { type: "regenerate" },
        });
        assert.deepEqual(harness.generateThreadTitle.mock.calls[0]?.[0]?.tabs, []);
        assert.deepEqual(harness.chatTabs.get(threadId), {
          name: "Black Hole",
          position: 0,
          manual: false,
        });

        const second = yield* armRegeneration({ command: "command:title:tab:2", threadId });
        yield* titleRegeneration.execute({
          threadId,
          requestId: second,
          kind: { type: "regenerate" },
        });
        assert.isUndefined(harness.generateThreadTitle.mock.calls[1]?.[0]?.tabs);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps the current title when generation returns the fallback", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "New thread" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:fallback:create",
          thread: "thread:title:fallback",
        });
        yield* dispatchUserMessage({
          command: "command:title:fallback:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({ command: "command:title:fallback:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps the current title when regeneration reproduces it", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "Seed title" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:unchanged:create",
          thread: "thread:title:unchanged",
        });
        yield* dispatchUserMessage({
          command: "command:title:unchanged:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({
          command: "command:title:unchanged:1",
          threadId,
        });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("clears the marker and keeps the title when generation fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.die(new Error("model unavailable")),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:failure:create",
          thread: "thread:title:failure",
        });
        yield* dispatchUserMessage({
          command: "command:title:failure:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({ command: "command:title:failure:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 1);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("stops waiting for a title a provider never returns", () =>
    Effect.gen(function* () {
      const attempted = yield* Deferred.make<void>();
      const harness = makeHarness({
        generateTitle: () =>
          Deferred.succeed(attempted, undefined).pipe(Effect.andThen(Effect.never)),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:hung:create",
          thread: "thread:title:hung",
        });
        const messageCommand = "command:title:hung:message";
        yield* dispatchUserMessage({ command: messageCommand, threadId, text: "Fix the title" });
        const requestId = yield* armRegeneration({ command: "command:title:hung:1", threadId });
        const fiber = yield* titleRegeneration
          .execute({
            threadId,
            requestId,
            kind: { type: "initial", messageId: MessageId.make(`${messageCommand}:message`) },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(attempted);
        yield* TestClock.adjust(ThreadTitleRegeneration.TITLE_GENERATION_LIMIT);
        yield* Fiber.join(fiber);

        assert.equal(harness.generateThreadTitle.mock.calls.length, 1);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("completes without generating when the initial message is unavailable", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:missing:create",
          thread: "thread:title:missing",
        });
        const requestId = yield* armRegeneration({ command: "command:title:missing:1", threadId });

        yield* titleRegeneration.execute({
          threadId,
          requestId,
          kind: { type: "initial", messageId: MessageId.make("message:title:missing") },
        });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

it.effect.each(["success", "exhausted", "stale", "interrupted"] as const)(
  "initial title retry: %s",
  (outcome) =>
    Effect.gen(function* () {
      const attempted = yield* Deferred.make<void>();
      let attempts = 0;
      const harness = makeHarness({
        generateTitle: () =>
          Effect.gen(function* () {
            attempts += 1;
            yield* Deferred.succeed(attempted, undefined);
            if (outcome === "success" && attempts === 3) return { title: "Recovered title" };
            return yield* new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Temporary failure",
            });
          }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: `create:${outcome}`,
          thread: `thread:${outcome}`,
        });
        const messageCommand = `message:${outcome}`;
        yield* dispatchUserMessage({ command: messageCommand, threadId, text: "Fix the title" });
        const requestId = yield* armRegeneration({ command: `title:${outcome}`, threadId });
        const fiber = yield* service
          .execute({
            threadId,
            requestId,
            kind: { type: "initial", messageId: MessageId.make(`${messageCommand}:message`) },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(attempted);
        if (outcome === "interrupted") {
          yield* Fiber.interrupt(fiber);
        } else {
          if (outcome === "stale")
            yield* threads.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("manual-title"),
              threadId,
              title: "Manual title",
            });
          yield* TestClock.adjust("2 seconds");
          if (outcome !== "stale") yield* TestClock.adjust("4 seconds");
          yield* Fiber.join(fiber);
        }
        assert.equal(attempts, outcome === "success" || outcome === "exhausted" ? 3 : 1);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(
          projection.thread.title,
          outcome === "success"
            ? "Recovered title"
            : outcome === "stale"
              ? "Manual title"
              : "Seed title",
        );
        if (outcome === "interrupted")
          assert.equal(projection.thread.titleRegeneration?.requestId, requestId);
        else assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
);
