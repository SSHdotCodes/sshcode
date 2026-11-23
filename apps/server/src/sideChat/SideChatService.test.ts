import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  SideChatId,
  sideChatKindForDriver,
  ThreadId,
  type OrchestrationV2HistoricalMessage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type SideChatSubscribeInput,
  type SideChatState,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SideChatService from "./SideChatService.ts";

const threadId = ThreadId.make("side-chat-test");
const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "side-chat-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const snapshot = (
  service: SideChatService.SideChatService["Service"],
  input: SideChatSubscribeInput = { threadId },
) => service.subscribe(input).pipe(Stream.runHead, Effect.map(Option.getOrThrow));
const settled = (service: SideChatService.SideChatService["Service"]) =>
  service.subscribe({ threadId }).pipe(
    Stream.filter((state) => state?.status === "idle"),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );

const makeHarness = Effect.fnUntraced(function* (
  driver: "antigravity" | "claudeAgent" | "codex",
  stallOpen = false,
) {
  const questions = yield* Queue.unbounded<{
    readonly prompt: string;
    readonly finish: Deferred.Deferred<string, ProviderAdapter.ProviderAdapterProtocolError>;
  }>();
  const interrupted = yield* Deferred.make<void>();
  const opening = yield* Deferred.make<void>();
  let opens = 0;
  let closes = 0;
  let current: ProviderAdapter.ProviderAdapterV2SideChatInput["current"];
  let transcript: ProviderAdapter.ProviderAdapterV2SideChatInput["transcript"];
  const turnItems: Array<OrchestrationV2TurnItem> = [];
  let model = "test";
  let interactionMode: "default" | "plan" = "default";
  const adapterLayer = Layer.mock(ProviderAdapter.ProviderAdapterV2)({
    instanceId: ProviderInstanceId.make(driver),
    driver: ProviderDriverKind.make(driver),
    openSideChat: (input) =>
      Effect.gen(function* () {
        current = input.current;
        transcript = input.transcript;
        opens++;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            closes++;
          }),
        );
        yield* Deferred.succeed(opening, undefined);
        if (stallOpen) return yield* Effect.never;
        return {
          kind: sideChatKindForDriver(driver)!,
          ask: ({ prompt, onUpdate }) =>
            Effect.gen(function* () {
              const finish = yield* Deferred.make<
                string,
                ProviderAdapter.ProviderAdapterProtocolError
              >();
              yield* onUpdate({ type: "text", text: "partial" });
              yield* Queue.offer(questions, { prompt, finish });
              return yield* Deferred.await(finish);
            }).pipe(Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined))),
        };
      }),
  });
  const registry = Layer.effect(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    Effect.gen(function* () {
      const adapter = yield* ProviderAdapter.ProviderAdapterV2;
      return {
        get: () => Effect.succeed(adapter),
        list: () => Effect.succeed([ProviderInstanceId.make(driver)]),
      };
    }),
  ).pipe(Layer.provide(adapterLayer));
  const dependencies = Layer.mergeAll(
    registry,
    RuntimePolicy.layer,
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
      get: () => Effect.succeed(Option.none()),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: (id) =>
        Effect.succeed({
          turnItems: [...turnItems],
          thread: {
            id,
            activeProviderThreadId: ProviderThreadId.make("provider-thread"),
            modelSelection: { instanceId: ProviderInstanceId.make(driver), model },
            runtimeMode: "full-access",
            interactionMode,
          },
          providerThreads: [
            {
              id: ProviderThreadId.make("provider-thread"),
              providerInstanceId: ProviderInstanceId.make(driver),
              providerSessionId: null,
              nativeThreadRef: { nativeId: "native-parent" },
            },
          ],
        } as unknown as OrchestrationV2ThreadProjection),
    }),
  );
  const openService = Layer.build(SideChatService.layer.pipe(Layer.provide(dependencies))).pipe(
    Effect.map((context) => Context.get(context, SideChatService.SideChatService)),
  );
  return {
    openService,
    questions,
    interrupted,
    opening,
    opens: () => opens,
    closes: () => closes,
    current: () => current!,
    transcript: () => transcript!,
    addTurnItem: (item: Partial<OrchestrationV2TurnItem>) => {
      turnItems.push({
        threadId,
        runId: null,
        providerThreadId: null,
        status: "completed",
        ...item,
      } as OrchestrationV2TurnItem);
    },
    setSelection: (nextModel: string) => {
      model = nextModel;
      interactionMode = "plan";
    },
  };
});

it.effect("sends text appends only for unchanged streaming side-chat state", () =>
  Effect.gen(function* () {
    const initial: SideChatState = {
      sideChatId: SideChatId.make("patch-side"),
      threadId,
      kind: "btw",
      status: "running",
      error: null,
      messages: [
        { id: "q", role: "user", text: "question", status: "complete", activities: [] },
        { id: "a", role: "assistant", text: "hello", status: "streaming", activities: [] },
      ],
    };
    const appended: SideChatState = {
      ...initial,
      messages: [initial.messages[0]!, { ...initial.messages[1]!, text: "hello world" }],
    };
    const corrected: SideChatState = {
      ...appended,
      messages: [appended.messages[0]!, { ...appended.messages[1]!, text: "corrected" }],
    };
    const activity: SideChatState = {
      ...corrected,
      messages: [
        corrected.messages[0]!,
        {
          ...corrected.messages[1]!,
          activities: [{ id: "tool", label: "reading", status: "running" }],
        },
      ],
    };
    const complete: SideChatState = {
      ...activity,
      status: "idle",
      messages: [activity.messages[0]!, { ...activity.messages[1]!, status: "complete" }],
    };
    const values = yield* SideChatService.sideChatTextPatches(
      Stream.fromIterable([initial, appended, corrected, activity, complete]),
    ).pipe(Stream.runCollect);
    expect(Array.from(values)).toEqual([
      initial,
      {
        kind: "text-append",
        sideChatId: initial.sideChatId,
        messageId: "a",
        previousLength: 5,
        text: " world",
      },
      corrected,
      activity,
      complete,
    ]);
    expect(
      Array.from(
        yield* SideChatService.sideChatTextPatches(Stream.make(appended)).pipe(Stream.runCollect),
      ),
    ).toEqual([appended]);
  }),
);

const drivers = ["antigravity", "claudeAgent", "codex"] as const;
describe.each(drivers)("SideChatService (%s)", (driver) => {
  it.effect("refreshes the model and policy for later questions", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(driver);
      const service = yield* harness.openService;
      yield* service.open({ threadId, prompt: "question" });
      yield* Deferred.await(harness.opening);
      harness.setSelection("new-model");
      const current = yield* harness.current();
      expect(current.modelSelection?.model).toBe("new-model");
      expect(current.runtimePolicy?.interactionMode).toBe("plan");
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect("also bounds a harness that never opens", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(driver, true);
      const service = yield* harness.openService;
      const opened = yield* service.open({ threadId, prompt: "question" });
      yield* Deferred.await(harness.opening);
      yield* TestClock.adjust("2 minutes");
      const failed = yield* service.subscribe({ threadId }).pipe(
        Stream.filter((state) => state?.status === "failed"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(failed?.error).toContain("timed out");
      expect(failed?.messages.at(-1)?.status).toBe("failed");
      yield* service.close({ sideChatId: opened.sideChatId });
      expect(harness.closes()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
  it.effect(
    "finishes after the request and subscription disconnect, and replays exactly one complete exchange",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(driver);
        const service = yield* harness.openService;
        expect(yield* snapshot(service)).toBeNull();
        // Both the RPC scope and the stream scope belong to the disconnected client.
        const opened = yield* Effect.scoped(
          service.open({ threadId, prompt: "question", messageId: "question-1" }),
        );
        const question = yield* Queue.take(harness.questions);
        const observed = yield* Deferred.make<void>();
        const subscription = yield* service.subscribe({ sideChatId: opened.sideChatId }).pipe(
          Stream.tap(() => Deferred.succeed(observed, undefined)),
          Stream.runDrain,
          Effect.forkChild,
        );
        yield* Deferred.await(observed);
        yield* Fiber.interrupt(subscription);
        yield* Deferred.succeed(question.finish, "complete answer");
        const complete = yield* settled(service);
        expect(complete?.messages.map(({ text, status }) => ({ text, status }))).toEqual([
          { text: "question", status: "complete" },
          { text: "complete answer", status: "complete" },
        ]);
        expect(yield* snapshot(service)).toEqual(complete);
        expect(yield* snapshot(service, { sideChatId: opened.sideChatId })).toEqual(complete);
        // A lost open acknowledgement can be retried without rerunning the provider.
        const retried = yield* service.open({
          threadId,
          prompt: "question",
          messageId: "question-1",
        });
        expect(retried).toEqual(complete);
        expect(harness.opens()).toBe(1);
        expect(harness.closes()).toBe(0);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("reuses the native session for follow-ups and deduplicates concurrent retries", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(driver);
      const service = yield* harness.openService;
      const input = { threadId, prompt: "question", messageId: "first" };
      const opened = yield* Effect.all([service.open(input), service.open(input)], {
        concurrency: "unbounded",
      });
      expect(opened[0]?.sideChatId).toBe(opened[1]?.sideChatId);
      const question = yield* Queue.take(harness.questions);
      expect((yield* snapshot(service))?.messages).toHaveLength(2);
      yield* Deferred.succeed(question.finish, "first answer");
      yield* settled(service);
      const followup = {
        sideChatId: opened[0]!.sideChatId,
        prompt: "follow-up",
        messageId: "second",
      };
      yield* Effect.all([service.send(followup), service.send(followup)], {
        concurrency: "unbounded",
      });
      const next = yield* Queue.take(harness.questions);
      expect(next.prompt).toBe("follow-up");
      const busy = yield* service.send({ ...followup, messageId: "third" }).pipe(Effect.flip);
      expect(busy.reason).toBe("busy");
      yield* Deferred.succeed(next.finish, "second answer");
      const complete = yield* settled(service);
      expect(complete?.messages.map((message) => message.text)).toEqual([
        "question",
        "first answer",
        "follow-up",
        "second answer",
      ]);
      expect(new Set(complete?.messages.map((message) => message.id)).size).toBe(4);
      expect(harness.opens()).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "explicit close interrupts the answer, releases its harness, and retains a settled exchange",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(driver);
        const service = yield* harness.openService;
        const opened = yield* service.open({ threadId, prompt: "question" });
        yield* Queue.take(harness.questions);
        yield* service.close({ sideChatId: opened.sideChatId });
        yield* Deferred.await(harness.interrupted);
        const closed = yield* snapshot(service);
        expect(closed?.status).toBe("closed");
        expect(closed?.messages.at(-1)?.status).toBe("failed");
        expect(harness.closes()).toBe(1);
        yield* service.close({ sideChatId: opened.sideChatId });
        expect(harness.closes()).toBe(1);
        const next = yield* service.open({ threadId, prompt: "next question" });
        expect(next.messages.map((message) => message.text)).toEqual([
          "question",
          "partial",
          "next question",
          "",
        ]);
        expect(next.sideChatId).not.toBe(opened.sideChatId);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "keeps answers alive within their deadline, expires idle harnesses, then expires bounded history",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(driver);
        const service = yield* harness.openService;
        yield* service.open({ threadId, prompt: "question" });
        const question = yield* Queue.take(harness.questions);
        yield* TestClock.adjust("1 minute");
        expect(harness.closes()).toBe(0);
        yield* Deferred.succeed(question.finish, "answer");
        yield* settled(service);
        yield* TestClock.adjust("35 minutes");
        yield* service.subscribe({ threadId }).pipe(
          Stream.filter((state) => state?.status === "closed"),
          Stream.runHead,
        );
        expect(harness.closes()).toBe(1);
        expect((yield* snapshot(service))?.messages.at(-1)?.text).toBe("answer");
        expect((yield* snapshot(service))?.status).toBe("closed");
        yield* TestClock.adjust("7 days");
        yield* service.subscribe({ threadId }).pipe(
          Stream.filter((state) => state === null),
          Stream.runHead,
        );
        expect(yield* snapshot(service)).toBeNull();
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "times out a stalled provider, replays the failure after reconnect, and admits a retry",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(driver);
        const service = yield* harness.openService;
        const opened = yield* service.open({ threadId, prompt: "stalled", messageId: "stalled" });
        const question = yield* Queue.take(harness.questions);
        yield* TestClock.adjust("2 minutes");
        const failure = yield* service.subscribe({ threadId }).pipe(
          Stream.filter((state) => state?.status === "failed"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        yield* Deferred.await(harness.interrupted);
        expect(failure?.messages.at(-1)?.status).toBe("failed");
        expect(failure?.error).toContain("timed out");
        expect(yield* snapshot(service)).toEqual(failure);
        // A late provider response cannot replace the failure or a subsequent exchange.
        yield* Deferred.succeed(question.finish, "too late");
        const retry = yield* service.open({ threadId, prompt: "stalled", messageId: "retry" });
        expect(retry.sideChatId).not.toBe(opened.sideChatId);
        const next = yield* Queue.take(harness.questions);
        yield* Deferred.succeed(next.finish, "retry answer");
        const complete = yield* settled(service);
        expect(complete?.messages.map((message) => message.text)).toEqual([
          "stalled",
          "partial",
          "stalled",
          "retry answer",
        ]);
        expect(harness.closes()).toBe(1);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("publishes provider errors and opens a fresh harness for the next question", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(driver);
      const service = yield* harness.openService;
      yield* service.open({ threadId, prompt: "question" });
      const question = yield* Queue.take(harness.questions);
      yield* Deferred.fail(
        question.finish,
        new ProviderAdapter.ProviderAdapterProtocolError({
          driver: ProviderDriverKind.make(driver),
          detail: "Provider connection lost",
        }),
      );
      const failure = yield* service.subscribe({ threadId }).pipe(
        Stream.filter((state) => state?.status === "failed"),
        Stream.runHead,
        Effect.map(Option.getOrThrow),
      );
      expect(failure?.error).toContain("Provider connection lost");
      expect(failure?.messages.at(-1)?.status).toBe("failed");
      yield* service.open({ threadId, prompt: "retry" });
      const retry = yield* Queue.take(harness.questions);
      yield* Deferred.succeed(retry.finish, "recovered");
      expect((yield* settled(service))?.messages.at(-1)?.text).toBe("recovered");
      expect(harness.opens()).toBe(2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "restores completed snapshots and marks interrupted answers after restart without opening providers",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(driver);
        const service = yield* harness.openService;
        yield* service.open({ threadId, prompt: "question", messageId: "saved-question" });
        const question = yield* Queue.take(harness.questions);
        yield* Deferred.succeed(question.finish, "saved answer");
        yield* settled(service);
        // Reading a new service from the same isolated state directory exercises recovery.
        const restored = yield* harness.openService;
        expect((yield* snapshot(restored))?.messages.map((message) => message.text)).toEqual([
          "question",
          "saved answer",
        ]);
        expect((yield* snapshot(restored))?.status).toBe("closed");
        expect(harness.opens()).toBe(1);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const contents = JSON.parse(
          yield* fs.readFileString(path.join(config.stateDir, "side-chats.json")),
        );
        contents.chats[0].state.status = "running";
        contents.chats[0].state.messages[1].status = "streaming";
        yield* fs.writeFileString(
          path.join(config.stateDir, "side-chats.json"),
          JSON.stringify(contents),
        );
        const interrupted = yield* snapshot(yield* harness.openService);
        expect(interrupted?.status).toBe("closed");
        expect(interrupted?.messages.at(-1)?.status).toBe("failed");
        expect(interrupted?.error).toContain("restarted");
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

it.effect(
  "hands an Antigravity side chat the thread's transcript as it stands at each question",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("antigravity");
      const service = yield* harness.openService;
      harness.addTurnItem({
        id: "u1",
        type: "user_message",
        text: "Remember KESTREL-19.",
      } as never);
      harness.addTurnItem({ id: "a1", type: "assistant_message", text: "OK" } as never);
      // Only conversation items reach the side session; reasoning and the like stay out.
      harness.addTurnItem({ id: "r1", type: "reasoning", text: "thinking" } as never);
      const opened = yield* service.open({ threadId, prompt: "What is the codeword?" });
      expect(opened.kind).toBe("btw");
      yield* Deferred.await(harness.opening);
      const summary = (messages: ReadonlyArray<OrchestrationV2HistoricalMessage>) =>
        messages.map(
          (message) => `${message.role}:${message.kind}:${message.status}:${message.text}`,
        );
      expect(summary(yield* harness.transcript())).toEqual([
        "user:user_message:completed:Remember KESTREL-19.",
        "assistant:assistant_message:completed:OK",
      ]);
      // The main turn keeps going; the next read includes its work in flight.
      harness.addTurnItem({
        id: "c1",
        type: "command_execution",
        input: "sleep 45",
        exitCode: null,
        output: null,
        status: "inProgress",
      } as never);
      expect(summary(yield* harness.transcript()).at(-1)).toBe(
        "assistant:command_execution:inProgress:Command: sleep 45\nExit code: unknown\n",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
