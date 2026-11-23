import { useAtomValue } from "@effect/atom-react";
import { connectionCatalogDisplayUrl } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { environmentLabels } from "@t3tools/shared/environmentLabels";
import { environmentPresentations } from "./presentation";
import { relayEnvironmentDiscovery } from "./relay";

/** Resolve against the whole catalog, so filtering or disconnecting cannot rename a machine. */
export const environmentDisplayLabelsAtom = Atom.make((get) => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const discovered = get(relayEnvironmentDiscovery.stateValueAtom);
  const identities = new Map<string, { id: string; label: string; address?: string | null }>(
    [...discovered.environments.values()].map(({ environment }) => [
      environment.environmentId,
      {
        id: environment.environmentId,
        label: environment.label,
      },
    ]),
  );
  for (const [id, presentation] of presentations) {
    identities.set(id, {
      id,
      label: presentation.entry.target.label,
      address: connectionCatalogDisplayUrl(presentation.entry),
    });
  }
  const next = environmentLabels([...identities.values()]);
  const previous = Option.getOrNull(get.self<ReadonlyMap<string, string>>());
  return previous !== null &&
    previous.size === next.size &&
    [...next].every(([id, label]) => previous.get(id) === label)
    ? previous
    : next;
}).pipe(Atom.withLabel("mobile:environment-display-labels"));

export function useEnvironmentDisplayLabels() {
  return useAtomValue(environmentDisplayLabelsAtom);
}

export function useEnvironmentDisplayLabel(environmentId: EnvironmentId | null) {
  const labels = useEnvironmentDisplayLabels();
  return environmentId === null ? null : (labels.get(environmentId) ?? null);
}
