import type { OrchestrationV2Subagent, ProjectId, ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import { accountAcceptsModel } from "@t3tools/shared/accountBalance";
import type { ContinueOnHistoryEntry } from "@t3tools/shared/continueOnModel";
import { modelFamilySupersessions, modelRankingSelectionKey } from "@t3tools/shared/modelRankings";
import { subagentModelChoices, usualOptionsLabel } from "@t3tools/shared/subagentModelChoices";
import * as DateTime from "effect/DateTime";

import {
  deriveProviderInstanceEntries,
  isProviderInstancePickerReady,
} from "../../providerInstances";
import { type ContinueCandidate, continueOnModelCandidates } from "./continueOnModel";

type SubagentModelRecord = Pick<
  OrchestrationV2Subagent,
  "origin" | "providerInstanceId" | "model" | "modelSelection" | "startedAt" | "updatedAt"
>;

export const newSubagentCandidateKey = (
  candidate: Pick<ContinueCandidate, "instanceId" | "model">,
) => `${candidate.instanceId}\0${candidate.model}`;

/**
 * The models offered for a subagent the user starts in a chat: what that chat's subagents
 * run on, then what the user starts chats with. With no history at all, each ready
 * provider's default. Two accounts with the same model are told apart by the account's name.
 */
export function newSubagentCandidates(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
  readonly projectId?: ProjectId | null;
  readonly subagents: ReadonlyArray<SubagentModelRecord>;
  readonly history: ReadonlyArray<ContinueOnHistoryEntry>;
  readonly now: number;
}): ContinueCandidate[] {
  const accepts = accountAcceptsModel(input.settings, input.projectId ?? null);
  const ready = deriveProviderInstanceEntries(
    input.providers.map((provider) => ({
      ...provider,
      models: provider.models.filter((model) => accepts(provider, model.slug)),
    })),
  ).filter(isProviderInstancePickerReady);
  const superseded = modelFamilySupersessions(input.providers);
  /** The ready provider and current model a used entry still names, or nothing. */
  const resolve = (used: { readonly instanceId: string; readonly model: string }) => {
    const entry = ready.find((candidate) => candidate.instanceId === used.instanceId);
    if (entry === undefined) return undefined;
    const hidden = input.settings.providerModelPreferences?.[entry.instanceId]?.hiddenModels ?? [];
    // Not a retired model, not one a newer release replaced, not one hidden from the pickers.
    const model = entry.models.find(
      (candidate) =>
        candidate.slug === used.model &&
        candidate.isLegacy !== true &&
        (candidate.isCustom || !hidden.includes(candidate.slug)) &&
        !superseded.has(
          modelRankingSelectionKey({ instanceId: entry.instanceId, model: candidate.slug }),
        ),
    );
    return model === undefined ? undefined : { entry, model };
  };
  const offered = subagentModelChoices({
    subagents: input.subagents.flatMap((subagent) =>
      subagent.origin === "app_owned" && subagent.model !== null
        ? [
            {
              startedAt: DateTime.toEpochMillis(subagent.startedAt ?? subagent.updatedAt),
              modelSelection: subagent.modelSelection ?? {
                instanceId: subagent.providerInstanceId,
                model: subagent.model,
              },
            },
          ]
        : [],
    ),
    chats: input.history,
    now: input.now,
    accepts: (used) => resolve(used) !== undefined,
  }).flatMap((used): ContinueCandidate[] => {
    const found = resolve(used);
    if (found === undefined) return [];
    return [
      {
        instanceId: found.entry.instanceId,
        model: found.model.slug,
        label: found.model.name,
        providerLabel: found.entry.displayName,
        ...(used.options ? { options: used.options } : {}),
      },
    ];
  });
  if (offered.length === 0) {
    return continueOnModelCandidates({
      providers: input.providers,
      settings: input.settings,
      projectId: input.projectId ?? null,
      failedInstanceId: null,
      history: input.history,
      now: input.now,
    });
  }
  return offered.map((candidate) => {
    // The account when two share a model, then the effort and speed it will run with.
    const account =
      offered.filter((other) => other.label === candidate.label).length > 1
        ? [candidate.providerLabel]
        : [];
    const usual = usualOptionsLabel(candidate.options);
    return {
      ...candidate,
      label: [candidate.label, ...account, ...(usual.length > 0 ? [usual] : [])].join(" · "),
    };
  });
}
