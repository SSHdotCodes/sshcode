import { expect, it } from "@effect/vitest";
import {
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as ProjectService from "./ProjectService.ts";

const threadId = ThreadId.make("native-history-import");
const instanceId = ProviderInstanceId.make("acp-test");
const now = DateTime.makeUnsafe("2026-10-23T00:00:00.000Z");

const makeHarness = Effect.fnUntraced(function* () {
  let historyOrigin: "v1_import" | undefined;
  let hasRun = false;
  let failRead = true;
  let beforeRead = Effect.void;
  let closed = 0;
  const opened: Array<ProviderAdapter.ProviderAdapterV2OpenSessionInput> = [];
  const written: Array<OrchestrationV2DomainEvent> = [];
  const message = (role: "user" | "assistant", text: string) => ({
    createdBy: role === "user" ? ("user" as const) : ("agent" as const),
    creationSource: "provider" as const,
    id: MessageId.make(`native:${text}`),
    threadId,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
  });
  const adapter = {
    openSession: (input: ProviderAdapter.ProviderAdapterV2OpenSessionInput) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          opened.push(input);
          return {
            readThreadSnapshot: ({ providerThread }) =>
              beforeRead.pipe(
                Effect.andThen(() =>
                  failRead
                    ? Effect.fail(
                        new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                          driver: providerThread.driver,
                          providerThreadId: providerThread.id,
                        }),
                      )
                    : Effect.succeed({
                        providerThread,
                        runtimeRequests: [],
                        reasoningMessageIds: [MessageId.make("native:Thinking")],
                        messages: [
                          message("user", "Fix it"),
                          message("assistant", "Thinking"),
                          message("assistant", "Fixed"),
                          message("assistant", " "),
                        ],
                      }),
                ),
              ),
          } satisfies Pick<ProviderAdapter.ProviderAdapterV2SessionRuntime, "readThreadSnapshot">;
        }),
        () =>
          Effect.sync(() => {
            closed++;
          }),
      ),
  } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];
  const dependencies = Layer.mergeAll(
    IdAllocator.layer,
    ThreadCommandExecutor.layer,
    Layer.mock(AgentSessionScanner.AgentSessionScanner)({}),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
    Layer.mock(ProjectService.ProjectService)({}),
    Layer.mock(ProviderSessionRuntime.ProviderSessionRuntimeRepository)({}),
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      get: () => Effect.succeed(adapter),
    }),
    Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadRecords: () =>
        Effect.sync(
          () =>
            ({
              thread: {
                id: threadId,
                modelSelection: { instanceId, model: "default" },
                runtimeMode: "approval-required",
                interactionMode: "default",
                worktreePath: null,
                historyOrigin,
              },
              runs: hasRun ? [{}] : [],
              providerThreads: [
                {
                  id: ProviderThreadId.make("native-provider-thread"),
                  appThreadId: threadId,
                  providerInstanceId: instanceId,
                  driver: ProviderDriverKind.make("acpRegistry"),
                  nativeThreadRef: { nativeId: "native-session" },
                },
              ],
            }) as never,
        ),
    }),
    Layer.mock(EventSink.EventSinkV2)({
      write: ({ events }) =>
        Effect.sync(() => {
          written.push(...events);
          historyOrigin = "v1_import";
          return [];
        }),
    }),
  );
  const importer = yield* AgentSessionImporter.AgentSessionImporter.pipe(
    Effect.provide(AgentSessionImporter.layer.pipe(Layer.provide(dependencies))),
  );
  return {
    load: importer.importNativeHistory({ threadId, workspaceRoot: "/workspace" }),
    opened,
    written,
    closed: () => closed,
    allowRead: () => {
      failRead = false;
    },
    duringRead: (effect: Effect.Effect<void>) => {
      beforeRead = effect;
    },
    startRun: () => {
      hasRun = true;
    },
  };
});

it.effect(
  "retries a failed native history read, imports reasoning separately, and imports once",
  () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect((yield* Effect.flip(harness.load))._tag).toBe(
        "ProviderAdapterReadThreadSnapshotError",
      );
      expect(harness.closed()).toBe(1);
      expect(harness.written).toEqual([]);
      harness.allowRead();
      expect(yield* harness.load).toBe(3);
      expect(yield* harness.load).toBe(0);
      expect(harness.opened).toHaveLength(2);
      expect(harness.opened[1]).toMatchObject({
        initialNativeThreadId: "native-session",
        runtimePolicy: { cwd: "/workspace" },
      });
      expect(
        harness.written.flatMap((event) =>
          event.type === "turn-item.updated"
            ? [[event.payload.type, "text" in event.payload ? event.payload.text : ""]]
            : [],
        ),
      ).toEqual([
        ["user_message", "Fix it"],
        ["reasoning", "Thinking"],
        ["assistant_message", "Fixed"],
      ]);
      expect(harness.written.at(-1)).toMatchObject({
        type: "thread.metadata-updated",
        payload: { historyOrigin: "v1_import" },
      });
    }).pipe(Effect.scoped),
);

it.effect("times out an unanswered native history read and releases its runtime", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    const entered = yield* Deferred.make<void>();
    harness.duringRead(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)));
    const loading = yield* harness.load.pipe(Effect.flip, Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("2 minutes");
    expect((yield* Fiber.join(loading))._tag).toBe("TimeoutError");
    expect(harness.closed()).toBe(1);
    expect(harness.written).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("does not import run-less history when a run starts during the native read", () =>
  Effect.gen(function* () {
    const harness = yield* makeHarness();
    harness.allowRead();
    harness.duringRead(Effect.sync(harness.startRun));
    expect(yield* harness.load).toBe(0);
    expect(harness.written).toEqual([]);
  }).pipe(Effect.scoped),
);
