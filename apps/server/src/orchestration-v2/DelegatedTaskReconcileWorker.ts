import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** How long a task may still show as working after its child went idle. */
export const IDLE_TASK_GRACE_MINUTES = 2;
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Settles delegated tasks still recorded as working whose child has had nothing queued
 * or running for a while. What ends a child's work settles its task as it happens; this
 * catches one those reactions missed, such as a task an earlier build left behind, which
 * its parent's chat would otherwise show as running until the next restart. Settling
 * rechecks what can hold a task without a run, such as background work or tasks below it.
 */
export const sweep = Effect.fn("DelegatedTaskReconcileWorker.sweep")(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const now = yield* DateTime.now;
  const childThreadIds = yield* projections.getIdleDelegatedTaskThreadIds(
    DateTime.subtract(now, { minutes: IDLE_TASK_GRACE_MINUTES }),
  );
  for (const threadId of childThreadIds) {
    yield* threads.recoverDelegatedTask(threadId);
  }
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const nextSweepAt = yield* Ref.make(0);
    yield* scheduler.register(
      "delegated-task-reconcile",
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (now < (yield* Ref.get(nextSweepAt))) return;
        yield* Ref.set(nextSweepAt, now + SWEEP_INTERVAL_MS);
        yield* sweep();
      }),
    );
  }),
);
