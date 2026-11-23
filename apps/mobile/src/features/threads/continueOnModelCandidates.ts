import { activeProviderFailure, type ModelSelection } from "@t3tools/contracts";
import {
  CONTINUE_ON_CHOICES,
  type ContinueOnHistoryEntry,
  continueOnProviders,
  usedModels,
} from "@t3tools/shared/continueOnModel";

import type { ProviderGroup } from "../../lib/modelOptions";

export interface PhoneContinueCandidate {
  /** Provider and model: two choices can share a provider. */
  readonly key: string;
  readonly instanceId: string;
  readonly label: string;
  readonly selection: ModelSelection;
}

/** The chat's own model on the user's other plan, named by the plan. */
export interface PhoneOtherPlan {
  readonly instanceId: string;
  readonly label: string;
  readonly model: string;
  readonly options?: ModelSelection["options"];
}

/**
 * The models a stopped chat can continue on. First the chat's own model on the user's other
 * plan, when this plan is out of room and that one is not. Then the models the owner starts
 * chats with, most used first; with no chat history to go by, each other provider's default
 * model, strongest harness first.
 */
export function phoneContinueCandidates(
  groups: ReadonlyArray<ProviderGroup>,
  failedInstanceId: string | null,
  history: ReadonlyArray<ContinueOnHistoryEntry> = [],
  now: number = Date.now(),
  otherPlan: PhoneOtherPlan | null = null,
  excludedModel: string | null = null,
): PhoneContinueCandidate[] {
  const providers = groups.flatMap((group) => {
    const model = group.models.find((option) => option.isDefault) ?? group.models[0];
    if (model === undefined) return [];
    return [
      {
        instanceId: group.providerKey,
        driver: model.providerDriver,
        recentFailure: group.recentFailure,
        group,
        model,
      },
    ];
  });
  const allowed = continueOnProviders(providers, failedInstanceId);
  const limited = (provider: (typeof providers)[number] | undefined, model: string) =>
    provider?.recentFailure?.modelIds !== undefined &&
    activeProviderFailure(provider, now, model) !== null;
  const planOption =
    otherPlan === null
      ? undefined
      : allowed
          .find((provider) => provider.instanceId === otherPlan.instanceId)
          ?.group.models.find(
            (candidate) =>
              candidate.selection.model === otherPlan.model &&
              !candidate.isUnavailable &&
              !limited(
                allowed.find((provider) => provider.instanceId === otherPlan.instanceId),
                otherPlan.model,
              ),
          );
  const plan: PhoneContinueCandidate[] =
    otherPlan !== null && planOption !== undefined
      ? [
          {
            key: `${otherPlan.instanceId}\0${otherPlan.model}`,
            instanceId: otherPlan.instanceId,
            // The model stays; the plan is what changes.
            label: otherPlan.label,
            selection:
              otherPlan.options && otherPlan.options.length > 0
                ? { ...planOption.selection, options: [...otherPlan.options] }
                : planOption.selection,
          },
        ]
      : [];
  const isPlan = (key: string) => plan.some((candidate) => candidate.key === key);
  const used = usedModels(history, now).flatMap((entry): PhoneContinueCandidate[] => {
    if (entry.model === excludedModel || isPlan(`${entry.instanceId}\0${entry.model}`)) return [];
    const option = allowed
      .find((provider) => provider.instanceId === entry.instanceId)
      ?.group.models.find(
        (candidate) =>
          candidate.selection.model === entry.model &&
          !candidate.isUnavailable &&
          !candidate.isHidden &&
          !candidate.isLegacy &&
          !limited(
            allowed.find((provider) => provider.instanceId === entry.instanceId),
            entry.model,
          ),
      );
    if (option === undefined) return [];
    return [
      {
        key: `${entry.instanceId}\0${entry.model}`,
        instanceId: entry.instanceId,
        label: option.label,
        selection: entry.options
          ? { ...option.selection, options: [...entry.options] }
          : option.selection,
      },
    ];
  });
  if (used.length > 0) return [...plan, ...used].slice(0, CONTINUE_ON_CHOICES);
  const defaults = allowed
    .filter(
      (provider) =>
        provider.model.selection.model !== excludedModel &&
        !limited(provider, provider.model.selection.model),
    )
    .map(({ instanceId, model }) => ({
      key: `${instanceId}\0${model.selection.model}`,
      instanceId,
      label: model.label,
      selection: model.selection,
    }))
    .filter((candidate) => !isPlan(candidate.key));
  return [...plan, ...defaults].slice(0, 5);
}
