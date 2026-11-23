import {
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  MessageId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import type { AcpAdapterV2ExtensionContext } from "./adapter.ts";
import {
  MID_TURN_DRAIN_METHOD,
  MID_TURN_SEND_NOW_METHOD,
  makeAcpMidTurnQueue,
} from "./midTurnQueue.ts";

type Handler = (params: { sessionId: string }) => Effect.Effect<{
  items: ReadonlyArray<{
    content: ReadonlyArray<{ type: string; text: string }>;
    displayText: string;
  }>;
  hasQueuedPrompt: boolean;
}>;

const setup = (nudge: Effect.Effect<void> = Effect.void) =>
  Effect.gen(function* () {
    const queue = yield* makeAcpMidTurnQueue;
    const nudges: string[] = [];
    let handler: Handler | undefined;
    const runtime = {
      request: (method: string) =>
        Effect.sync(() => {
          nudges.push(method);
          return {};
        }).pipe(Effect.andThen(nudge)),
      handleExtRequest: (method: string, _payload: unknown, registered: Handler) =>
        Effect.sync(() => {
          assert.equal(method, MID_TURN_DRAIN_METHOD);
          handler = registered;
        }),
    };
    yield* queue.registerExtensions({ runtime } as unknown as AcpAdapterV2ExtensionContext);
    const settled = yield* Deferred.make<void>();
    const turnOver = { await: Deferred.await(settled), isDone: Deferred.isDone(settled) };
    const steer = (text: string) =>
      queue.steer({
        driver: ProviderDriverKind.make("acpRegistry"),
        runtime: runtime as never,
        sessionId: "session",
        text,
        messageId: MessageId.make("message"),
        providerTurnId: ProviderTurnId.make("turn"),
        providerThreadId: ProviderThreadId.make("thread"),
        turnOver,
      });
    const drain = () => handler!({ sessionId: "session" });
    return { steer, drain, settled, nudges };
  });

describe("ACP mid-turn queue", () => {
  it.effect("hands a steer to the agent's next drain after nudging it", () =>
    Effect.gen(function* () {
      const { steer, drain, nudges } = yield* setup();
      const fiber = yield* steer("use tabs").pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      assert.deepEqual(nudges, [MID_TURN_SEND_NOW_METHOD]);
      const drained = yield* drain();
      assert.deepEqual(drained, {
        items: [{ content: [{ type: "text", text: "use tabs" }], displayText: "use tabs" }],
        hasQueuedPrompt: false,
      });
      yield* Fiber.join(fiber);
      assert.deepEqual((yield* drain()).items, []);
    }),
  );

  it.effect("returns a steer the turn never took so the host queues it", () =>
    Effect.gen(function* () {
      const { steer, drain, settled } = yield* setup();
      const fiber = yield* steer("late").pipe(Effect.flip, Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Deferred.succeed(settled, undefined);
      const error = yield* Fiber.join(fiber);
      assert.equal(error._tag, "ProviderAdapterSteerRunUnsupportedError");
      assert.deepEqual((yield* drain()).items, []);
    }),
  );

  it.effect("withdraws a steer interrupted while the agent is handling the nudge", () =>
    Effect.gen(function* () {
      const nudged = yield* Deferred.make<void>();
      const { steer, drain } = yield* setup(
        Deferred.succeed(nudged, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const fiber = yield* steer("cancelled message").pipe(Effect.forkChild);
      yield* Deferred.await(nudged);
      yield* Fiber.interrupt(fiber);
      assert.deepEqual((yield* drain()).items, []);
    }),
  );

  it.effect("returns a steer dropped by a final drain while its nudge is pending", () =>
    Effect.gen(function* () {
      const nudged = yield* Deferred.make<void>();
      const releaseNudge = yield* Deferred.make<void>();
      const { steer, drain, settled } = yield* setup(
        Deferred.succeed(nudged, undefined).pipe(Effect.andThen(Deferred.await(releaseNudge))),
      );
      const fiber = yield* steer("preserve this message").pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(nudged);
      yield* Deferred.succeed(settled, undefined);
      assert.deepEqual((yield* drain()).items, []);
      yield* Deferred.succeed(releaseNudge, undefined);
      const result = yield* Fiber.join(fiber);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterSteerRunUnsupportedError");
      }
      assert.deepEqual((yield* drain()).items, []);
    }),
  );

  it.effect("hands back a steer a long tool kept the agent from taking, so none is lost", () =>
    Effect.gen(function* () {
      const { steer, drain } = yield* setup();
      const fiber = yield* steer("after the build").pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust("3 seconds");
      const error = yield* Fiber.join(fiber);
      assert.equal(error._tag, "ProviderAdapterSteerRunUnsupportedError");
      // The host now sends it as the next message; the agent's later drain gets nothing.
      assert.deepEqual((yield* drain()).items, []);
    }),
  );
});
