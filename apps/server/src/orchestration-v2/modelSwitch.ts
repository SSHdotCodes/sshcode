import {
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type RunId,
} from "@t3tools/contracts";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";

/**
 * The model or effort change a new run brings, measured from the latest run the timeline shows
 * through its message, its wake notification, or its handoff row, so each change draws once, on
 * the first run that ran on it, and consecutive dividers chain. `baseline` stands in when there
 * is none, such as a fork's source run. Callers skip starts with a context handoff; the handoff
 * item already shows those. `turnItems` must include the notification items of runs that
 * {@link unshownRunIds} returns.
 */
export function modelSwitchSince(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
  to: ModelSelection,
  baseline?: ModelSelection,
): Pick<Extract<OrchestrationV2TurnItem, { type: "user_message" }>, "modelSwitch"> {
  const from = latestShownRun(projection)?.modelSelection ?? baseline;
  return from === undefined || modelSelectionsEqual(from, to) ? {} : { modelSwitch: { from, to } };
}

/**
 * Runs after the latest shown one whose start row the given items do not show. A wake run's row
 * is a notification item, which command projections do not load; callers fetch those for these.
 */
export function unshownRunIds(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
): ReadonlyArray<RunId> {
  const shown = shownRunIds(projection.turnItems);
  const latest = latestShownRun(projection);
  return projection.runs.flatMap((run) =>
    run.status !== "rolled_back" &&
    run.status !== "queued" &&
    !shown.has(run.id) &&
    (latest === undefined || runRanAfter(run, latest))
      ? [run.id]
      : [],
  );
}

type Run = OrchestrationV2ThreadProjection["runs"][number];

function latestShownRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "turnItems">,
): Run | undefined {
  const shown = shownRunIds(projection.turnItems);
  let latest: Run | undefined;
  for (const run of projection.runs) {
    if (run.status === "rolled_back" || run.status === "queued") continue;
    if (!shown.has(run.id) && run.contextHandoffId === null) continue;
    if (latest === undefined || runRanAfter(run, latest)) latest = run;
  }
  return latest;
}

// Clients hide pending queued messages and replace `/compact` with a compaction row. Every other
// run start draws its divider: a message, an answered question, or a wake notification.
function shownRunIds(items: OrchestrationV2ThreadProjection["turnItems"]): ReadonlySet<RunId> {
  const shown = new Set<RunId>();
  for (const item of items) {
    if (item.runId === null) continue;
    if (isShownRunItem(item)) {
      shown.add(item.runId);
    }
  }
  return shown;
}

export function isShownRunItem(item: OrchestrationV2TurnItem): boolean {
  return (
    item.type === "notification" ||
    (item.type === "user_message" &&
      !(item.inputIntent === "queued_turn" && item.status === "pending") &&
      !(item.text.trim().toLowerCase() === "/compact" && item.attachments.length === 0))
  );
}
