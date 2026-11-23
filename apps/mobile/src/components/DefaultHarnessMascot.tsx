import type { EnvironmentId } from "@t3tools/contracts";
import {
  defaultHarnessMascotProvider,
  harnessMascotAgentId,
  type HarnessMascotState,
} from "@t3tools/shared/harnessMascots";
import { resolveNewChatModelSelection } from "@t3tools/shared/projectSettings";
import { harnessDefaultsFromProviders } from "../lib/harnessDefaultsFromProviders";
import { useEnvironments } from "../state/environments";
import { useStickyComposerModelSelection } from "../state/use-composer-drafts";
import { HarnessMascot } from "./HarnessMascot";
import { useCoarseNow } from "../lib/useCoarseNow";
import { accountAcceptsModel } from "@t3tools/shared/accountBalance";

export function DefaultHarnessMascot({
  environmentId,
  state = "idle",
  size = 72,
  visible = true,
}: {
  readonly environmentId?: EnvironmentId;
  readonly state?: HarnessMascotState;
  readonly size?: number;
  readonly visible?: boolean;
}) {
  const { environments } = useEnvironments();
  const sticky = useStickyComposerModelSelection();
  const now = useCoarseNow();
  const config = (
    environments.find((environment) => environment.environmentId === environmentId) ??
    environments[0]
  )?.serverConfig;
  const providers = config?.providers ?? [];
  // The harness a new chat would open with: the in-app default, then the one
  // last used on this device, then the harness config.
  const selection = resolveNewChatModelSelection({
    providers,
    harnessDefaults: harnessDefaultsFromProviders(providers),
    fallbackSelection: config?.settings.defaultModelSelection,
    stickyActiveProvider: sticky?.instanceId,
    balanceAccounts:
      config?.settings.balanceAccounts === true
        ? { now, accepts: accountAcceptsModel(config?.settings, null) }
        : null,
  });
  const provider =
    providers.find((candidate) => candidate.instanceId === selection?.instanceId) ??
    defaultHarnessMascotProvider(providers, null);
  const agentId = harnessMascotAgentId(
    provider?.driver,
    provider ? config?.settings.providerInstances[provider.instanceId]?.config : null,
  );
  return (
    <HarnessMascot
      driver={provider?.driver ?? null}
      agentId={agentId}
      state={state}
      size={size}
      visible={visible}
    />
  );
}
