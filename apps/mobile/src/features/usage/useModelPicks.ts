import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId, USAGE_CONTRACT_VERSION } from "@t3tools/contracts";
import {
  buildModelPicks,
  modelPickProviders,
  effortOfSelection,
  PICKS_WINDOW_DAYS,
} from "@t3tools/shared/modelPickEvidence";
import type { ModelPicks } from "@t3tools/shared/modelPicks";
import type { ModelBenchmarkTable } from "@t3tools/shared/modelBenchmarks";
import { makeWindow } from "@t3tools/shared/usageFormat";
import type { EnvironmentUsage } from "@t3tools/shared/usageMerge";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { environmentPresentations } from "../../state/presentation";
import { subagentRankingsEnvironment } from "../../state/server";
import { useUsage } from "../../state/usage";
import { PROVIDER_LABEL } from "./usageProviders";
import { useBenchmarkTable } from "./useBenchmarkTable";

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

/**
 * Cached evidence shared by Usage's best-model cards and the first-prompt model
 * suggestion. `picks` is null until an environment has reported usage.
 */
export function useModelPicks(
  selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null,
  now: number,
): { readonly picks: ModelPicks | null; readonly table: ModelBenchmarkTable } {
  const window = useMemo(() => makeWindow(PICKS_WINDOW_DAYS), []);
  const { selectedEnvironments } = useUsage(window, selectedEnvironmentIds);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const snapshots = useAtomValue(
    rankingsAtom(selectedEnvironments.map((environment) => environment.environmentId).join("\n")),
  );
  const table = useBenchmarkTable(
    selectedEnvironments.map((environment) => environment.environmentId),
    now,
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
    if (environments.length === 0) return null;
    const configs = selectedEnvironments.map(
      (environment) => presentations.get(environment.environmentId)?.serverConfig,
    );
    let effort: string | undefined;
    const planPrices: Record<string, number> = {};
    for (const config of configs) {
      effort ??= effortOfSelection(config?.settings.defaultModelSelection);
      // A server from before plan prices sends none.
      Object.assign(planPrices, config?.settings.usagePlanPrices ?? {});
    }
    return buildModelPicks({
      environments,
      contractVersion: USAGE_CONTRACT_VERSION,
      providers: selectedEnvironments.flatMap((environment) =>
        modelPickProviders(
          environment.environmentId,
          presentations.get(environment.environmentId)?.serverConfig,
        ),
      ),
      snapshots,
      table,
      effort,
      planPrices,
      providerLabel: (provider) => PROVIDER_LABEL[provider],
      timeZone: window.timeZone,
      // A pick stands on the account a new chat would start on, where accounts share new chats.
      balanceAccounts: (environmentId) =>
        selectedEnvironments.every(
          (environment, index) =>
            environment.environmentId !== environmentId ||
            configs[index]?.settings.balanceAccounts === true,
        ),
      now,
    });
  }, [now, presentations, selectedEnvironments, snapshots, table, window.timeZone]);

  return { picks, table };
}
