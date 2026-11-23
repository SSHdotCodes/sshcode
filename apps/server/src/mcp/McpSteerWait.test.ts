import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2StoredEvent,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { captureCallerSteer, raceWithSteer } from "./McpSteerWait.ts";

const threadId = ThreadId.make("thread:steer-wait");
const runId = RunId.make("run:steer-wait");
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:steer-wait"),
  requestNamespace: "steer-wait",
  thread: {
    threadId,
    providerSessionId: "steer-wait",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};

const steerEvent = (
  sequence: number,
  inputIntent = "steer",
  eventRunId = runId,
  eventThreadId = threadId,
) =>
  ({
    sequence,
    event: {
      type: "turn-item.updated",
      threadId: eventThreadId,
      payload: { type: "user_message", runId: eventRunId, inputIntent },
    },
  }) as OrchestrationV2StoredEvent;

it.effect.each(["steer", "promoted_queued_to_steer"])(
  "ends a wait on a new %s and releases the waiting effect",
  (intent) =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
      const started = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      const layer = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadEventSequence: () => Effect.succeed(10),
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId, { activeRunId: runId })),
        streamStoredEventsFrom: () => Stream.fromQueue(events),
      });
      yield* Effect.gen(function* () {
        const steer = yield* captureCallerSteer(scope);
        const waiting = yield* raceWithSteer(
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(Deferred.succeed(released, undefined)),
          ),
          steer,
        ).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        yield* Queue.offer(events, steerEvent(11, intent));
        assert.isTrue(Option.isNone(yield* Fiber.join(waiting)));
        yield* Deferred.await(released);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "replays a steer that arrives during tool setup, including a queued-message promotion",
  () =>
    Effect.gen(function* () {
      const history: OrchestrationV2StoredEvent[] = [steerEvent(10)];
      const layer = Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadEventSequence: () => Effect.succeed(10),
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId, { activeRunId: runId })),
        streamStoredEventsFrom: (input) =>
          Stream.unwrap(
            Effect.sync(() =>
              Stream.fromIterable(
                history.filter((event) => event.sequence > (input?.afterSequence ?? 0)),
              ),
            ),
          ),
      });
      yield* Effect.gen(function* () {
        const steer = yield* captureCallerSteer(scope);
        history.push(steerEvent(11, "promoted_queued_to_steer"));
        assert.isTrue(Option.isNone(yield* raceWithSteer(Effect.never, steer)));
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("ignores old steers, queued inputs, other threads and other runs", () =>
  Effect.gen(function* () {
    const checked = yield* Deferred.make<void>();
    const layer = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadEventSequence: () => Effect.succeed(10),
      getThreadShell: () => Effect.succeed(liveThreadShell(threadId, { activeRunId: runId })),
      streamStoredEventsFrom: () =>
        Stream.fromIterable([
          steerEvent(9),
          steerEvent(10, "promoted_queued_to_steer"),
          steerEvent(11, "queued_turn"),
          steerEvent(12, "steer", RunId.make("run:other")),
          steerEvent(13, "steer", runId, ThreadId.make("thread:other")),
        ]).pipe(Stream.ensuring(Deferred.succeed(checked, undefined))),
    });
    yield* Effect.gen(function* () {
      const steer = yield* captureCallerSteer(scope);
      const result = yield* raceWithSteer(Deferred.await(checked).pipe(Effect.as("done")), steer);
      assert.deepEqual(result, Option.some("done"));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["client", "idle"])("keeps normal wait behavior for an %s caller", (kind) =>
  Effect.gen(function* () {
    const layer = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadEventSequence: () => Effect.succeed(10),
      getThreadShell: () => Effect.succeed(liveThreadShell(threadId, { activeRunId: null })),
    });
    yield* Effect.gen(function* () {
      const steer = yield* captureCallerSteer(
        kind === "client" ? { ...scope, thread: undefined } : scope,
      );
      assert.deepEqual(yield* raceWithSteer(Effect.succeed("done"), steer), Option.some("done"));
    }).pipe(Effect.provide(layer));
  }),
);
