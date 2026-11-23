import {
  activeProviderFailure,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { accountAcceptsModel } from "@t3tools/shared/accountBalance";
import { continueOnOtherPlan } from "@t3tools/client-runtime/plan-tip";
import {
  CONTINUE_ON_CHOICES,
  type ContinueOnHistoryEntry,
  continueOnProviders,
  usedModels,
} from "@t3tools/shared/continueOnModel";

import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../../providerInstances";

/** A model the chat can continue on after its own model stopped. */
export interface ContinueCandidate {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  /** "Opus 5.5" style; the provider when the model has no name of its own. */
  readonly label: string;
  readonly providerLabel: string;
  /** The options the owner most often runs this model with, when history named it. */
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
  /** The chat's own model on the user's other plan; the chat's options carry over. */
  readonly otherPlan?: true;
}

/**
 * The models a stopped chat can continue on. First the chat's own model on the user's other
 * plan, when this plan is out of room and that one is not. Then the models the owner starts
 * chats with, most used first; with no chat history to go by, each other ready provider's
 * default model, strongest harness first.
 */
export function continueOnModelCandidates(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly projectId?: ProjectId | null;
  readonly failedInstanceId: ProviderInstanceId | null;
  /** The stopped chat's model and options. */
  readonly failedModel?: string | null;
  readonly failedOptions?: ContinueCandidate["options"];
  readonly history?: ReadonlyArray<ContinueOnHistoryEntry>;
  readonly now?: number;
}): ContinueCandidate[] {
  const now = input.now ?? Date.now();
  const scopedLimit = (provider: ServerProvider, model: string) =>
    provider.recentFailure?.modelIds !== undefined &&
    activeProviderFailure(provider, now, model) !== null;
  const accepts = accountAcceptsModel(input.settings, input.projectId ?? null);
  const providers = input.providers.map((provider) => ({
    ...provider,
    models: provider.models.filter((model) => accepts(provider, model.slug)),
  }));
  const ready = deriveProviderInstanceEntries(providers)
    .filter(isProviderInstancePickerReady)
    .map((entry) => ({
      entry,
      instanceId: entry.instanceId,
      driver: entry.driverKind,
      recentFailure: entry.snapshot.recentFailure,
    }));
  const allowed = continueOnProviders(ready, input.failedInstanceId);
  const failedModel = input.failedModel ?? null;
  const plan =
    input.failedInstanceId !== null && failedModel !== null
      ? continueOnOtherPlan(input.settings.balanceAccounts, providers, {
          instanceId: input.failedInstanceId,
          model: failedModel,
        })
      : null;
  const planEntry =
    plan === null
      ? undefined
      : allowed.find(({ instanceId }) => instanceId === plan.instanceId)?.entry;
  const otherPlan: ContinueCandidate[] =
    plan !== null &&
    failedModel !== null &&
    planEntry?.models.some((candidate) => candidate.slug === failedModel) &&
    !scopedLimit(planEntry.snapshot, failedModel)
      ? [
          {
            instanceId: planEntry.instanceId,
            model: failedModel,
            // The model stays; the plan is what changes.
            label: plan.label,
            providerLabel: plan.label,
            otherPlan: true,
            ...(input.failedOptions && input.failedOptions.length > 0
              ? { options: input.failedOptions }
              : {}),
          },
        ]
      : [];
  const skipModel = (instanceId: string, model: string) =>
    (!input.settings.balanceAccounts && model === failedModel) ||
    otherPlan.some((candidate) => candidate.instanceId === instanceId && candidate.model === model);
  const used = usedModels(input.history ?? [], now).flatMap((model): ContinueCandidate[] => {
    const entry = allowed.find(({ instanceId }) => instanceId === model.instanceId)?.entry;
    const found = entry?.models.find((candidate) => candidate.slug === model.model);
    if (entry === undefined || found === undefined || scopedLimit(entry.snapshot, found.slug))
      return [];
    if (skipModel(entry.instanceId, found.slug)) return [];
    return [
      {
        instanceId: entry.instanceId,
        model: found.slug,
        label: found.name,
        providerLabel: entry.displayName,
        ...(model.options ? { options: model.options } : {}),
      },
    ];
  });
  if (used.length > 0) return [...otherPlan, ...used].slice(0, CONTINUE_ON_CHOICES);
  const defaults = allowed.flatMap(({ entry }): ContinueCandidate[] => {
    const model = resolveAppModelSelectionForInstance(
      entry.instanceId,
      input.settings,
      providers,
      null,
    );
    if (
      model === null ||
      !accepts(entry.snapshot, model) ||
      skipModel(entry.instanceId, model) ||
      scopedLimit(entry.snapshot, model)
    )
      return [];
    const name = entry.models.find((candidate) => candidate.slug === model)?.name;
    return [
      {
        instanceId: entry.instanceId,
        model,
        label: name ?? entry.displayName,
        providerLabel: entry.displayName,
      },
    ];
  });
  return [...otherPlan, ...defaults];
}

export { canContinueOnAnotherModel } from "@t3tools/shared/continueOnModel";
