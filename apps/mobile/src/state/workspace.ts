import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { environmentDisplayLabelsAtom } from "./environment-labels";
import { environmentShellSummaryAtom } from "./shell";
import { projectWorkspaceState } from "./workspaceModel";
import { environmentCatalog } from "../connection/catalog";
import { environmentPresentations } from "./presentation";
import { createWorkspaceConnectionAtoms } from "./workspace-connection-atoms";

export const workspaceConnections = createWorkspaceConnectionAtoms({
  displayLabelsAtom: environmentDisplayLabelsAtom,
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  networkStatusValueAtom: environmentCatalog.networkStatusValueAtom,
  presentationAtom: environmentPresentations.presentationAtom,
});

export function useWorkspaceEnvironments() {
  return useAtomValue(workspaceConnections.environmentsAtom);
}

export function useWorkspaceConnectionState() {
  return useAtomValue(workspaceConnections.stateAtom);
}

export function useConnectionsReady() {
  return useAtomValue(workspaceConnections.isReadyAtom);
}

/**
 * @param ignoredEnvironmentIds environments left out of the connection state,
 *   such as cloud machines whose chats appear under their home environment.
 */
export function useWorkspaceState(ignoredEnvironmentIds?: ReadonlySet<EnvironmentId>) {
  const isReady = useConnectionsReady();
  const networkStatus = useAtomValue(environmentCatalog.networkStatusValueAtom);
  const projectedEnvironments = useWorkspaceEnvironments();
  const shellSummary = useAtomValue(environmentShellSummaryAtom);
  const state = useMemo(
    () =>
      projectWorkspaceState({
        isReady,
        networkStatus,
        environments:
          ignoredEnvironmentIds === undefined || ignoredEnvironmentIds.size === 0
            ? projectedEnvironments
            : projectedEnvironments.filter(
                (environment) => !ignoredEnvironmentIds.has(environment.environmentId),
              ),
        shellSummary,
      }),
    [ignoredEnvironmentIds, isReady, networkStatus, projectedEnvironments, shellSummary],
  );

  return {
    environments: projectedEnvironments,
    state,
  };
}
