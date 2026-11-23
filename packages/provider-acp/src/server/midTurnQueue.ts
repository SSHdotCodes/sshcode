import type { ProviderDriverKind } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import type { AcpAdapterV2ExtensionContext, AcpAdapterV2Flavor } from "./adapter.ts";

/**
 * A pull-based steering extension (Qwen Code 0.26): during a turn the agent asks
 * the client for queued user input with `craft/drainMidTurnQueue` after every
 * tool step, and, once nudged with `craft/midTurnSendNow`, while a reply streams
 * (it then stops that reply and answers the input). Agents announce nothing at
 * initialize, so a flavor opts in per agent.
 */
export const MID_TURN_DRAIN_METHOD = "craft/drainMidTurnQueue";
export const MID_TURN_SEND_NOW_METHOD = "craft/midTurnSendNow";

/** How long a steer waits for the agent to take it before handing it back to the host. */
const TAKE_WINDOW = "2500 millis";

const DrainRequest = Schema.Struct({ sessionId: Schema.String });

type SteerInput = Parameters<NonNullable<AcpAdapterV2Flavor["steer"]>>[0] & {
  readonly driver: ProviderDriverKind;
};

interface QueuedSteer {
  readonly text: string;
  readonly taken: Deferred.Deferred<"taken" | "dropped">;
  readonly turnOver: SteerInput["turnOver"];
}

export const makeAcpMidTurnQueue = Effect.gen(function* () {
  const queued = yield* Ref.make(new Map<string, ReadonlyArray<QueuedSteer>>());
  const withdraw = (sessionId: string, steer: QueuedSteer) =>
    Ref.modify(queued, (current) => {
      const items = current.get(sessionId) ?? [];
      if (!items.includes(steer)) return [false, current] as const;
      const next = new Map(current);
      const remaining = items.filter((item) => item !== steer);
      if (remaining.length === 0) next.delete(sessionId);
      else next.set(sessionId, remaining);
      return [true, next] as const;
    });

  /** Hands every live steer for the session to the agent; ones from ended turns are dropped. */
  const drain = (sessionId: string) =>
    Effect.gen(function* () {
      const items = yield* Ref.modify(queued, (current) => {
        const next = new Map(current);
        next.delete(sessionId);
        return [current.get(sessionId) ?? [], next] as const;
      });
      const live: QueuedSteer[] = [];
      for (const item of items) {
        if (yield* item.turnOver.isDone) {
          yield* Deferred.succeed(item.taken, "dropped");
          yield* Effect.logWarning("acp.mid-turn-steer.dropped-after-turn", { sessionId });
          continue;
        }
        live.push(item);
        yield* Deferred.succeed(item.taken, "taken");
      }
      return {
        items: live.map((item) => ({
          content: [{ type: "text", text: item.text }],
          displayText: item.text,
        })),
        hasQueuedPrompt: false,
      };
    }).pipe(Effect.uninterruptible);

  const registerExtensions = (context: AcpAdapterV2ExtensionContext) =>
    context.runtime.handleExtRequest(MID_TURN_DRAIN_METHOD, DrainRequest, ({ sessionId }) =>
      drain(sessionId),
    );

  /**
   * Queues the text and nudges the agent. Taken: steered. Not taken within the
   * window (a long tool is running) or the turn ends first: withdrawn and
   * reported unsupported, so the host sends it as the next message. A queued
   * steer never outlives its call, so none is ever dropped unseen. Never holds
   * a worker for long.
   */
  const steer = (input: SteerInput) =>
    Effect.gen(function* () {
      const item: QueuedSteer = {
        text: input.text,
        taken: yield* Deferred.make<"taken" | "dropped">(),
        turnOver: input.turnOver,
      };
      return yield* Effect.acquireUseRelease(
        Ref.update(queued, (current) =>
          new Map(current).set(input.sessionId, [...(current.get(input.sessionId) ?? []), item]),
        ),
        () =>
          Effect.gen(function* () {
            yield* input.runtime
              .request(MID_TURN_SEND_NOW_METHOD, { sessionId: input.sessionId })
              .pipe(Effect.timeoutOption("2 seconds"), Effect.ignore);
            const outcome = yield* Effect.raceFirst(
              Deferred.await(item.taken),
              input.turnOver.await.pipe(Effect.as("ended" as const)),
            ).pipe(Effect.timeoutOption(TAKE_WINDOW));
            if (Option.isSome(outcome) && outcome.value === "taken") return;
            // Removal alone is not delivery: a concurrent drain may have dropped it.
            const withdrawn = yield* withdraw(input.sessionId, item);
            if (!withdrawn && (yield* Deferred.await(item.taken)) === "taken") return;
            return yield* new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver: input.driver,
              providerThreadId: input.providerThreadId,
            });
          }),
        () => withdraw(input.sessionId, item),
      );
    });

  return { registerExtensions, steer } as const;
});
