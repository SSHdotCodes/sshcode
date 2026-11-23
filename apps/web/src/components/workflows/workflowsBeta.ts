import type { EnvironmentId } from "@t3tools/contracts";
import { useEnvironments } from "../../state/environments";

/** Global navigation shows the feature when any connected environment enables it. */
export function useWorkflowsBeta(environmentId?: EnvironmentId): boolean {
  const { environments } = useEnvironments();
  return environments.some(
    (environment) =>
      (environmentId === undefined || environment.environmentId === environmentId) &&
      environment.serverConfig?.settings.workflowsBeta === true,
  );
}
