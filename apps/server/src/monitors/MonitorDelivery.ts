import { CommandId, MessageId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as MonitorService from "./MonitorService.ts";

/**
 * Least time between two wakes of an idle thread by the same monitor. A wake
 * of an idle thread starts a turn that rereads the whole conversation, and a
 * monitor printing every minute or two cost a turn each time.
 */
export const MONITOR_IDLE_WAKE_INTERVAL_MS = 120_000;
// An idle monitor often prints its answer just before exiting. Give its exit
// two seconds to join that output before spending a turn on progress alone.
const MONITOR_EXIT_GRACE_MS = 2_000;
/** Detail kept when held outputs are delivered together; the latest lines win. */
const MAX_COMBINED_DETAIL = 8_000;
const deliveryRetry = Schedule.exponential("2 seconds").pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.minutes(1))),
  ),
);

interface MonitorDeliveryState {
  lastDeliveredAt: number | null;
  held: Array<MonitorService.MonitorEvent>;
  timer: Fiber.Fiber<void> | null;
}

/** The latest held outputs and the end, if any, as one event, keeping the last one's identity. */
function combineEvents(
  events: ReadonlyArray<MonitorService.MonitorEvent>,
): MonitorService.MonitorEvent {
  const last = events.at(-1)!;
  if (events.length === 1) return last;
  // Durable jobs keep all output in their log. On exit, include the last matched
  // batch if the final log tail doesn't already show it. Keep the log path intact.
  if (last.durable && last.notification.outcome !== "updated") {
    const progress = events.slice(0, -1).findLast((event) => event.notification.detail)
      ?.notification.detail;
    const end = last.notification.detail ?? "";
    if (progress === undefined || end.includes(progress)) return last;
    return {
      ...last,
      text: `${last.text}\n${progress}`,
      notification: { ...last.notification, detail: [end, progress].filter(Boolean).join("\n") },
    };
  }
  let detail = (
    last.durable === true
      ? events.filter((event) => event.notification.detail !== undefined).slice(-1)
      : events
  )
    .map((event) => event.notification.detail ?? "")
    .filter((part) => part.length > 0)
    .join("\n");
  const maxDetail = last.durable === true ? 2_000 : MAX_COMBINED_DETAIL;
  if (detail.length > maxDetail) {
    const tail = detail.slice(-maxDetail);
    detail = `[earlier output omitted]\n${tail.slice(tail.indexOf("\n") + 1)}`;
  }
  const header = last.text.split("\n", 1)[0]!;
  const { detail: _detail, ...notification } = last.notification;
  return {
    ...last,
    text: detail.length > 0 ? `${header}\n${detail}` : header,
    notification: detail.length > 0 ? { ...notification, detail } : notification,
  };
}

/**
 * Hands monitor events to their thread through the notification mailbox,
 * with its active steering and idle queue promotion.
 *
 * Ends, urgent notices and output for a busy thread go out immediately.
 * Idle progress waits briefly for the exit and respects the per-monitor interval.
 * Further output joins the pending wake without moving its deadline.
 */
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const monitors = yield* MonitorService.MonitorService;
    const engine = yield* Orchestrator.OrchestratorV2;
    const scope = yield* Effect.scope;
    const lock = yield* Semaphore.make(1);
    const states = new Map<string, MonitorDeliveryState>();

    const dispatch = (events: ReadonlyArray<MonitorService.MonitorEvent>) => {
      const acknowledgeAll = Effect.forEach(events, monitors.acknowledge, { discard: true });
      if (events.length === 0) return Effect.void;
      const event = combineEvents(events);
      const key = `${event.generation}:${event.monitorId}:${event.sequence}`;
      const terminal = event.notification.outcome !== "updated";
      const rejected = (error: { readonly _tag: string }) =>
        Effect.logWarning("Monitor notification was permanently rejected", {
          monitorId: event.monitorId,
          errorClass: error._tag,
        });
      // The ids are fixed per event, so a retry after an unclear failure can't post twice.
      const send = Effect.suspend(() => {
        if (!monitors.canDeliver(event)) return Effect.void;
        // The orchestrator checks the generation in the message ID again under the thread lock.
        return engine
          .dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`server:monitor:${key}`),
            threadId: event.threadId,
            messageId: MessageId.make(`message:monitor:${key}`),
            text: event.text,
            notification: event.notification,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
            createdBy: "agent",
            creationSource: "server",
          })
          .pipe(
            Effect.asVoid,
            Effect.catchTags({
              OrchestratorCommandPreviouslyRejectedError: rejected,
              OrchestratorCommandIdConflictError: rejected,
            }),
          );
      });
      // Keep retrying exits off the delivery lock. A transient outage must not
      // leave a finished monitor keeping its thread open until the next restart.
      return send.pipe(
        Effect.andThen(acknowledgeAll),
        Effect.catchCause(() =>
          Effect.sleep("2 seconds").pipe(
            Effect.andThen(send),
            Effect.retry({ schedule: deliveryRetry, ...(terminal ? {} : { times: 5 }) }),
            Effect.andThen(acknowledgeAll),
            Effect.catchCause((cause) =>
              Effect.logWarning("Monitor notification delivery failed", {
                monitorId: event.monitorId,
                terminal,
                cause,
              }).pipe(Effect.andThen(terminal ? Effect.void : acknowledgeAll)),
            ),
            Effect.forkIn(scope),
            Effect.asVoid,
          ),
        ),
      );
    };

    // A thread whose state can't be read counts as busy, so its output is never held.
    const threadIsBusy = (event: MonitorService.MonitorEvent) =>
      engine.getThreadShell(event.threadId).pipe(
        Effect.map((thread) => (thread?.activeRunId ?? null) !== null),
        Effect.orElseSucceed(() => true),
      );

    const deliverHeld = (state: MonitorDeliveryState, now: number) =>
      Effect.gen(function* () {
        const held = state.held;
        state.held = [];
        state.timer = null;
        if (held.length === 0) return;
        state.lastDeliveredAt = now;
        yield* dispatch(held);
      });

    const handle = (event: MonitorService.MonitorEvent) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          if (!monitors.canDeliver(event)) return yield* monitors.acknowledge(event);
          const key = `${event.threadId}\u0000${event.monitorId}`;
          const state = states.get(key) ?? { lastDeliveredAt: null, held: [], timer: null };
          states.set(key, state);
          const now = yield* Clock.currentTimeMillis;
          const timer = state.timer;
          if (event.notification.outcome !== "updated" || event.urgent === true) {
            // The monitor ended or looks stuck: deliver what it held with this, now.
            if (event.notification.outcome !== "updated") states.delete(key);
            if (timer !== null) yield* Fiber.interrupt(timer);
            state.held.push(event);
            return yield* deliverHeld(state, now);
          }
          state.held.push(event);
          if (yield* threadIsBusy(event)) {
            // A running turn takes the output as a steer; no new turn starts.
            if (timer !== null) yield* Fiber.interrupt(timer);
            return yield* deliverHeld(state, now);
          }
          if (timer !== null) return;
          const delay =
            state.lastDeliveredAt === null
              ? MONITOR_EXIT_GRACE_MS
              : Math.max(
                  MONITOR_EXIT_GRACE_MS,
                  state.lastDeliveredAt + MONITOR_IDLE_WAKE_INTERVAL_MS - now,
                );
          state.timer = yield* Effect.sleep(delay).pipe(
            Effect.andThen(
              lock.withPermits(1)(
                Effect.gen(function* () {
                  if (states.get(key) !== state || state.held.length === 0) return;
                  yield* deliverHeld(state, yield* Clock.currentTimeMillis);
                }),
              ),
            ),
            Effect.forkIn(scope),
          );
        }),
      );

    yield* monitors.events.pipe(Stream.runForEach(handle), Effect.forkScoped);

    // Monitors the last server left running come back once startup recovery has
    // settled runs and the server is ready, or after two minutes regardless.
    const access = (threadId: Parameters<typeof engine.getThreadShell>[0]) =>
      engine.getThreadShell(threadId).pipe(
        Effect.map((thread): MonitorService.MonitorRecoveryAccess =>
          thread === null || thread.archivedAt != null || thread.deletedAt != null
            ? "gone"
            : thread.runtimeMode === "full-access" && thread.interactionMode === "default"
              ? "ok"
              : "denied",
        ),
        Effect.orElseSucceed((): MonitorService.MonitorRecoveryAccess => "retry"),
      );
    const lifecycle = yield* Effect.serviceOption(ServerLifecycleEvents.ServerLifecycleEvents);
    const ready = Option.isNone(lifecycle)
      ? Effect.void
      : lifecycle.value.snapshot.pipe(
          Effect.map((snapshot) => snapshot.events.some((event) => event.type === "ready")),
          Effect.repeat({ until: (isReady) => isReady, schedule: Schedule.spaced("1 second") }),
          Effect.timeoutOption("2 minutes"),
          Effect.asVoid,
        );
    yield* ready.pipe(
      Effect.andThen(
        Effect.gen(function* () {
          let delay = 5_000;
          while (true) {
            yield* monitors.recover(access);
            yield* Effect.sleep(delay);
            delay = Math.min(delay * 2, 60_000);
          }
        }),
      ),
      Effect.forkScoped,
    );
  }),
);
