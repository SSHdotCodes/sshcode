import { usageLoadingState } from "@t3tools/client-runtime/state/usage-progress";
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, USAGE_CONTRACT_VERSION, type UsageProviderKind } from "@t3tools/contracts";
import {
  buildModelPicks,
  modelPickProviders,
  effortOfSelection,
  PICKS_WINDOW_DAYS,
} from "@t3tools/shared/modelPickEvidence";
import { makeWindow } from "@t3tools/shared/usageFormat";
import type { EnvironmentUsage } from "@t3tools/shared/usageMerge";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";
import { usePrimarySettings } from "../../hooks/useSettings";
import { environmentPresentations } from "../../state/presentation";
import { subagentRankingsEnvironment } from "../../state/server";
import { useUsage } from "../../state/usage";
import { useBenchmarkTable } from "./useBenchmarkTable";
import { PROVIDER_PRESENTATION } from "./usageProviders";

/** Every selected environment's grades in one atom, so the hook count never changes. */
const rankingsAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    key === ""
      ? []
      : key.split("\n").map((id) => {
          const environmentId = EnvironmentId.make(id);
          const snapshot = get(subagentRankingsEnvironment.snapshotAtom(environmentId));
          return snapshot === null ? null : { ...snapshot, environmentId };
        }),
  ),
);

/** Cached evidence shared by the Usage cards and the first-prompt recommendation. */
export function useModelPicks(
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  hiddenProviders: ReadonlySet<UsageProviderKind>,
  now: number,
) {
  const window = useMemo(() => makeWindow(PICKS_WINDOW_DAYS), []);
  const { selectedEnvironments, shown } = useUsage(window, selectedEnvironmentIds, hiddenProviders);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const environmentKey = selectedEnvironments
    .map((environment) => environment.environmentId)
    .join("\n");
  const snapshots = useAtomValue(rankingsAtom(environmentKey));
  const table = useBenchmarkTable(
    selectedEnvironments.map((environment) => environment.environmentId),
    now,
  );
  // Benchmarks are read at the effort new chats start with, not each model's top setting.
  const effort = usePrimarySettings((settings) =>
    effortOfSelection(settings.defaultModelSelection),
  );
  const planPrices = usePrimarySettings((settings) => settings.usagePlanPrices);
  const providers = useMemo(
    () =>
      selectedEnvironments.flatMap((environment) =>
        modelPickProviders(
          environment.environmentId,
          presentations.get(environment.environmentId)?.serverConfig,
        ),
      ),
    [presentations, selectedEnvironments],
  );

  const picks = useMemo(() => {
    const environments: EnvironmentUsage[] = selectedEnvironments.flatMap((environment) =>
      environment.summary === null
        ? []
        : [
            {
              environmentId: environment.environmentId,
              label: environment.label,
              summary: environment.summary,
            },
          ],
    );
    return buildModelPicks({
      environments,
      contractVersion: USAGE_CONTRACT_VERSION,
      hiddenProviders,
      providers,
      snapshots,
      table,
      effort,
      planPrices,
      providerLabel: (provider) => PROVIDER_PRESENTATION[provider].label,
      timeZone: window.timeZone,
      // A pick stands on the account a new chat would start on, where accounts share new chats.
      balanceAccounts: (environmentId) =>
        environmentId === undefined ||
        presentations.get(EnvironmentId.make(environmentId))?.serverConfig?.settings
          ?.balanceAccounts === true,
      now,
    });
  }, [
    effort,
    hiddenProviders,
    now,
    planPrices,
    presentations,
    providers,
    selectedEnvironments,
    snapshots,
    table,
    window,
  ]);

  const progress = usageLoadingState(selectedEnvironments);
  const loading =
    progress.everyProvider ||
    [...progress.providers].some((provider) => !hiddenProviders.has(provider));
  return { picks, providers, table, shown, loading };
}
