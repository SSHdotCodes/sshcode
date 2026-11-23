import {
  TerminalHandoffError,
  type TerminalHandoffStatus,
  type ThreadId,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

const HERE: TerminalHandoffStatus = { phase: "here", startedAt: null, unavailableReason: null };
function terminalTurnRefusal(status: TerminalHandoffStatus): string | null {
  return status.phase === "in-terminal"
    ? "This chat is open in Terminal. Bring it back to send here."
    : status.phase === "handing-off"
      ? "This chat is being handed to Terminal. Try again in a moment."
      : null;
}

type WhileHere = <A, E, R>(
  threadId: ThreadId,
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | TerminalHandoffError, R>;

export class TerminalHandoffState extends Context.Service<
  TerminalHandoffState,
  {
    readonly get: (threadId: ThreadId) => TerminalHandoffStatus;
    readonly changes: (threadId: ThreadId) => Stream.Stream<TerminalHandoffStatus>;
    readonly assertHere: (threadId: ThreadId) => Effect.Effect<void, TerminalHandoffError>;
    readonly withStart: WhileHere;
    readonly withMessageDispatch: WhileHere;
    readonly handoff: <A, E, R>(
      threadId: ThreadId,
      effect: Effect.Effect<A, E, R>,
      launch?: (prepared: A) => Effect.Effect<void, E, R>,
    ) => Effect.Effect<void, E | TerminalHandoffError, R>;
    readonly bringBack: <E, R>(
      threadId: ThreadId,
      record: (startedAt: string) => Effect.Effect<void, E, R>,
    ) => Effect.Effect<void, E | TerminalHandoffError, R>;
  }
>()("t3/orchestration-v2/TerminalHandoffState") {}

export const layer = Layer.effect(
  TerminalHandoffState,
  Effect.gen(function* () {
    const states = new Map<ThreadId, TerminalHandoffStatus>();
    const changes = yield* PubSub.unbounded<ThreadId>();
    const starts = yield* KeyedLock.make<ThreadId>();
    const messages = yield* KeyedLock.make<ThreadId>("orchestrationV2.messageIntake.wait");
    const get = (id: ThreadId) => states.get(id) ?? HERE;
    const update = (id: ThreadId, state: TerminalHandoffStatus) =>
      Effect.gen(function* () {
        if (state.phase === "here") states.delete(id);
        else states.set(id, state);
        yield* PubSub.publish(changes, id);
      });
    const assertHere = (id: ThreadId) =>
      Effect.suspend(() => {
        const message = terminalTurnRefusal(get(id));
        return message === null ? Effect.void : Effect.fail(new TerminalHandoffError({ message }));
      });
    const whileHere =
      (lock: KeyedLock.KeyedLock<ThreadId>): WhileHere =>
      (id, effect) =>
        assertHere(id).pipe(
          Effect.andThen(lock.withLock(id, assertHere(id).pipe(Effect.andThen(effect)))),
        );
    return TerminalHandoffState.of({
      get,
      assertHere,
      changes: (id) =>
        Stream.unwrap(
          Effect.gen(function* () {
            // Subscribe before reading so a transition cannot fall between snapshot and live updates.
            const queue = yield* PubSub.subscribe(changes);
            return Stream.concat(
              Stream.sync(() => get(id)),
              Stream.fromSubscription(queue).pipe(
                Stream.filter((changed) => changed === id),
                Stream.map(() => get(id)),
              ),
            );
          }),
        ),
      withStart: whileHere(starts),
      withMessageDispatch: whileHere(messages),
      handoff: (id, effect, launch) =>
        Effect.gen(function* () {
          // Claim synchronously, before waiting on any existing startup.
          yield* Effect.suspend(() => {
            const message = terminalTurnRefusal(get(id));
            if (message !== null) return Effect.fail(new TerminalHandoffError({ message }));
            states.set(id, { ...HERE, phase: "handing-off" });
            return PubSub.publish(changes, id);
          });
          yield* Effect.gen(function* () {
            // Intake and provider startup may overlap. Terminal needs both to finish before
            // stopping the session, and the claim above refuses any new work in either lane.
            const prepared = yield* starts
              .withLock(id, messages.withLock(id, effect))
              .pipe(Effect.timeout("10 seconds"));
            // The deadline covers the barrier. Once launch succeeds, always
            // record ownership before answering, including on socket loss.
            yield* launch?.(prepared) ?? Effect.void;
            yield* update(id, {
              ...HERE,
              phase: "in-terminal",
              startedAt: DateTime.formatIso(yield* DateTime.now),
            });
          }).pipe(
            Effect.mapError(
              () =>
                new TerminalHandoffError({
                  message: "Couldn't hand this chat to Terminal. Try again.",
                }),
            ),
            Effect.onError(() => update(id, HERE)),
          );
        }).pipe(Effect.uninterruptible),
      bringBack: (id, record) =>
        starts
          .withLock(
            id,
            Effect.gen(function* () {
              const state = get(id);
              if (state.phase === "here") return;
              if (state.phase !== "in-terminal" || state.startedAt === null)
                return yield* new TerminalHandoffError({
                  message: "Wait for this chat to open in Terminal first.",
                });
              yield* record(state.startedAt);
              yield* update(id, HERE);
            }),
          )
          .pipe(Effect.uninterruptible),
    });
  }),
);
