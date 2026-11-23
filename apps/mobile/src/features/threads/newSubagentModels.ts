import type { OrchestrationV2Subagent, ServerProvider } from "@t3tools/contracts";
import type { ContinueOnHistoryEntry } from "@t3tools/shared/continueOnModel";
import { modelFamilySupersessions, modelRankingSelectionKey } from "@t3tools/shared/modelRankings";
import { subagentModelChoices, usualOptionsLabel } from "@t3tools/shared/subagentModelChoices";
import * as DateTime from "effect/DateTime";

import type { ProviderGroup } from "../../lib/modelOptions";
import { type PhoneContinueCandidate, phoneContinueCandidates } from "./continueOnModelCandidates";

type SubagentModelRecord = Pick<
  OrchestrationV2Subagent,
  "origin" | "providerInstanceId" | "model" | "modelSelection" | "startedAt" | "updatedAt"
>;

/**
 * The models offered for a subagent the user starts in a chat: what that chat's subagents
 * run on, then what the user starts chats with. With no history at all, each provider's
 * default. Two accounts with the same model are told apart by the account's name.
 */
export function newSubagentCandidates(input: {
  readonly groups: ReadonlyArray<ProviderGroup>;
  /** The provider snapshots, to tell which models a newer release replaced. */
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly subagents: ReadonlyArray<SubagentModelRecord>;
  readonly history: ReadonlyArray<ContinueOnHistoryEntry>;
  readonly now: number;
}): PhoneContinueCandidate[] {
  const superseded = modelFamilySupersessions(input.providers);
  /** The provider and current model a used entry still names, or nothing. */
  const resolve = (used: { readonly instanceId: string; readonly model: string }) => {
    const group = input.groups.find((candidate) => candidate.providerKey === used.instanceId);
    // Not a retired model, not one a newer release replaced, not one hidden from the pickers.
    const option = group?.models.find(
      (candidate) =>
        candidate.selection.model === used.model &&
        !candidate.isUnavailable &&
        !candidate.isHidden &&
        !candidate.isLegacy &&
        !superseded.has(
          modelRankingSelectionKey({
            instanceId: candidate.selection.instanceId,
            model: candidate.selection.model,
          }),
        ),
    );
    return group === undefined || option === undefined ? undefined : { group, option };
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
  }).flatMap((entry) => {
    const found = resolve(entry);
    if (found === undefined) return [];
    return [
      {
        key: `${entry.instanceId}\0${entry.model}`,
        instanceId: entry.instanceId,
        label: found.option.label,
        account: found.group.providerLabel,
        usual: usualOptionsLabel(entry.options),
        selection: entry.options
          ? { ...found.option.selection, options: [...entry.options] }
          : found.option.selection,
      },
    ];
  });
  if (offered.length === 0) {
    return phoneContinueCandidates(input.groups, null, input.history, input.now);
  }
  return offered.map(({ account, usual, ...candidate }) => ({
    ...candidate,
    // The account when two share a model, then the effort and speed it will run with.
    label: [
      candidate.label,
      ...(offered.filter((other) => other.label === candidate.label).length > 1 ? [account] : []),
      ...(usual.length > 0 ? [usual] : []),
    ].join(" · "),
  }));
}
