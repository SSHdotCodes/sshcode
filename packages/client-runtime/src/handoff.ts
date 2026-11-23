import type {
  ModelSelection,
  OrchestrationV2ModelSwitch,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";

import { REASONING_EFFORT_OPTION_IDS } from "./state/threadExecution.ts";

/**
 * The subset of a projection run that handoff rows read. Kept minimal so the
 * timeline can hold a content-stable snapshot: run status/timestamps churn on
 * every stream event, but these fields only change when a run is added.
 */
export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export type HandoffEndpoints = ReturnType<typeof resolveHandoffEndpoints>;

/** Preview the next send's handoff without adding anything to durable history. */
export function resolvePendingHandoff(
  projection: OrchestrationV2ThreadProjection | null | undefined,
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
): HandoffEndpoints | null {
  // A thread with an empty timeline has nothing to hand off. Any loaded row
  // counts: paging can leave a window of only tool rows.
  if (!projection?.visibleTurnItems.length) return null;
  const from = projection.runs.findLast(
    (run) => run.startedAt !== null && run.status !== "rolled_back",
  )?.modelSelection;
  if (from === undefined || selection == null) return null;
  const source = providers.find((provider) => provider.instanceId === from.instanceId);
  const target = providers.find((provider) => provider.instanceId === selection.instanceId);
  const needsHandoff =
    from.instanceId === selection.instanceId
      ? from.model !== selection.model && target?.requiresNewThreadForModelChange === true
      : // Accounts sharing a continuation group resume the same native thread.
        source?.continuation?.groupKey === undefined ||
        source.driver !== target?.driver ||
        source.continuation.groupKey !== target.continuation?.groupKey;
  return needsHandoff ? { from: [from], to: selection } : null;
}

export function resolveHandoffEndpoints(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "handoff" }>,
    "runId" | "fromModelSelections" | "fromProviderInstanceIds" | "toModel" | "toProviderInstanceId"
  >,
  runs: ReadonlyArray<HandoffTimelineRun>,
) {
  // Items persisted before models were stamped only carry instance ids;
  // recover the models from the thread's runs (the handoff's own run is
  // the target, the newest earlier run per source instance is the origin).
  // Clients fall back to the provider display name when neither source has a model.
  const handoffRun = item.runId === null ? undefined : runs.find((run) => run.id === item.runId);
  const toModel =
    item.toModel ??
    (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
      ? handoffRun.modelSelection.model
      : undefined);
  const fromEndpoints: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model?: string | undefined;
  }> =
    item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
      ? item.fromModelSelections
      : item.fromProviderInstanceIds.map((instanceId) => ({
          instanceId,
          model: latestRunModelBefore(runs, instanceId, handoffRun?.ordinal),
        }));
  return { from: fromEndpoints, to: { instanceId: item.toProviderInstanceId, model: toModel } };
}

/**
 * Model of the newest run for `instanceId` that started before the handoff's
 * own run. Legacy handoff items don't record their source models, but the
 * covered runs are still in the projection.
 */
function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}

export interface ModelSwitchChange {
  readonly modelChanged: boolean;
  /** Effort labels, set only when the effort changed. */
  readonly effort: { readonly from: string; readonly to: string } | null;
}

/**
 * What a recorded model switch visibly changed, or null when it changed neither the model nor the
 * effort. The composer omits an untouched effort, so an unset effort reads as the model's default.
 */
export function resolveModelSwitchChange(
  { from, to }: OrchestrationV2ModelSwitch,
  providers: ReadonlyArray<ServerProvider>,
): ModelSwitchChange | null {
  const modelsOf = (selection: ModelSelection) =>
    providers.find((provider) => provider.instanceId === selection.instanceId)?.models;
  const fromEffort = resolveEffort(from, modelsOf(from));
  const toEffort = resolveEffort(to, modelsOf(to));
  const modelChanged = from.model !== to.model;
  const effort =
    fromEffort && toEffort && fromEffort.value !== toEffort.value
      ? { from: fromEffort.label, to: toEffort.label }
      : null;
  return modelChanged || effort ? { modelChanged, effort } : null;
}

/** The composer's reasoning control for the model; stated values only when the catalog lacks it. */
function resolveEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> | undefined,
): { readonly value: string; readonly label: string } | undefined {
  const model = models?.find((candidate) => candidate.slug === selection.model);
  if (model === undefined) {
    // Pi states its effort as `thinking`; the catalog would otherwise mark it a reasoning control.
    const value = [...REASONING_EFFORT_OPTION_IDS, "thinking"]
      .map((id) => getModelSelectionStringOptionValue(selection, id))
      .find((candidate) => candidate !== undefined);
    return value === undefined ? undefined : { value, label: value };
  }
  const descriptor = model.capabilities?.optionDescriptors?.find(
    (candidate): candidate is Extract<typeof candidate, { type: "select" }> =>
      candidate.type === "select" &&
      (candidate.role === "reasoning" ||
        (REASONING_EFFORT_OPTION_IDS as ReadonlyArray<string>).includes(candidate.id) ||
        candidate.id === "thinking"),
  );
  if (descriptor === undefined) return undefined;
  const value =
    getModelSelectionStringOptionValue(selection, descriptor.id) ??
    getProviderOptionCurrentValue(descriptor, selection);
  if (typeof value !== "string") return undefined;
  return { value, label: descriptor.options.find((option) => option.id === value)?.label ?? value };
}
