import { useNavigation } from "@react-navigation/native";
import { useAtomValue } from "@effect/atom-react";
import { computerUseChatStatus } from "@t3tools/client-runtime/state/computer-use";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { computerUseEnvironment, serverEnvironment } from "../../state/server";

export function useComputerUseStatus(environmentId: EnvironmentId, threadId: ThreadId) {
  const navigation = useNavigation();
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const enabled = config?.computerUse === true && config.settings.computerUse.enabled;
  const query = useEnvironmentQuery(
    enabled ? computerUseEnvironment.state({ environmentId, input: {} }) : null,
  );
  const status = query.data ? computerUseChatStatus(query.data, threadId) : null;
  const openSettings = useCallback(() => {
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: {
        screen: "SettingsComputerUse",
        initial: false,
        params: { environmentId },
      },
    });
  }, [environmentId, navigation]);

  return useMemo(() => {
    if (!status) return null;
    const icon =
      status.kind === "paused"
        ? ("stop.fill" as const)
        : status.kind === "queued" || status.kind === "setup-unknown"
          ? ("clock" as const)
          : status.kind === "needs-setup"
            ? ("gearshape" as const)
            : ("desktopcomputer" as const);
    return {
      ...status,
      icon,
      selected: status.kind === "controlling" || status.kind === "paused",
      openSettings,
    };
  }, [openSettings, status]);
}
