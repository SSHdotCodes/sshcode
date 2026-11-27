import { agentBehaviorOnMachines } from "@t3tools/client-runtime/state/agent-behavior";

import { useSettingsEnvironmentFilter } from "../settings-environment-filter";

/** Settings > Agents as last set from any device, on the machines a change goes to. */
export function useSyncedAgentBehavior() {
  return agentBehaviorOnMachines(useSettingsEnvironmentFilter().availableTargets);
}
