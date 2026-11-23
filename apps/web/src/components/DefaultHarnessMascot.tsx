import type { EnvironmentId } from "@t3tools/contracts";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useServerConfigs } from "../state/entities";
import { HarnessMascot } from "./HarnessMascot";
import {
  BUILD_DEFAULT_MASCOT_DRIVER,
  defaultHarnessMascotProvider,
  harnessMascotAgentId,
  type HarnessMascotState,
} from "@t3tools/shared/harnessMascots";

export function DefaultHarnessMascot({
  environmentId,
  state = "idle",
  size = 72,
}: {
  readonly environmentId?: EnvironmentId;
  readonly state?: HarnessMascotState;
  readonly size?: number;
}) {
  const primary = usePrimaryEnvironmentId();
  const configs = useServerConfigs();
  const target = environmentId ?? primary;
  const config = target ? configs.get(target) : undefined;
  const selection = config?.settings.defaultModelSelection;
  const provider = defaultHarnessMascotProvider(config?.providers ?? [], selection?.instanceId);
  const agentId = BUILD_DEFAULT_MASCOT_DRIVER
    ? null
    : harnessMascotAgentId(
        provider?.driver,
        provider ? config?.settings.providerInstances[provider.instanceId]?.config : null,
      );
  return (
    <HarnessMascot
      driver={BUILD_DEFAULT_MASCOT_DRIVER ?? provider?.driver ?? null}
      agentId={agentId}
      state={state}
      size={size}
    />
  );
}
