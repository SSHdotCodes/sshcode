import type { EnvironmentPresentation, NetworkStatus } from "@t3tools/client-runtime/connection";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import type { EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentSummaryAtoms } from "@t3tools/client-runtime/state/presentation";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentLabels } from "@t3tools/shared/environmentLabels";
import { projectWorkspaceConnectionState } from "./workspaceModel";

export function createWorkspaceConnectionAtoms(input: {
  readonly displayLabelsAtom?: Atom.Atom<ReadonlyMap<string, string>>;
  readonly catalogValueAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly networkStatusValueAtom: Atom.Atom<NetworkStatus>;
  readonly presentationAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<EnvironmentPresentation | null>;
}) {
  const summaries = createEnvironmentSummaryAtoms(input);
  const environmentsAtom = Atom.make((get) => {
    const environments = get(summaries.environmentsAtom);
    const labels = input.displayLabelsAtom
      ? get(input.displayLabelsAtom)
      : environmentLabels(
          environments.map((environment) => ({
            id: environment.environmentId,
            label: environment.environmentLabel,
            address: environment.displayUrl,
          })),
        );
    const previous = Option.getOrNull(get.self<typeof environments>());
    const next = environments.map((environment, index) => {
      const label = labels.get(environment.environmentId) ?? environment.environmentLabel;
      if (label === environment.environmentLabel) return environment;
      const prior = previous?.[index];
      const labeled = { ...environment, environmentLabel: label };
      return prior &&
        Object.keys(labeled).every(
          (key) => prior[key as keyof typeof prior] === labeled[key as keyof typeof labeled],
        )
        ? prior
        : labeled;
    });
    return previous &&
      next.length === previous.length &&
      next.every((environment, index) => environment === previous[index])
      ? previous
      : next;
  });
  const isReadyAtom = input.catalogValueAtom.pipe(Atom.map((catalog) => catalog.isReady));
  const stateAtom = Atom.make((get) =>
    projectWorkspaceConnectionState({
      isReady: get(isReadyAtom),
      networkStatus: get(input.networkStatusValueAtom),
      environments: get(environmentsAtom),
    }),
  ).pipe(Atom.withLabel("mobile:workspace-connection-state"));
  return { environmentsAtom, stateAtom, isReadyAtom };
}
