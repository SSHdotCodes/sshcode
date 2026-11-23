import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";
import { AppState } from "react-native";

import { serverEnvironment } from "../../state/server";

/** The shared subscription follows new sockets; foreground also refreshes a suspended socket. */
export function useThreadSideChat(environmentId: EnvironmentId, threadId: ThreadId) {
  const atom = serverEnvironment.sideChatState({ environmentId, input: { threadId } });
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => subscription.remove();
  }, [refresh]);
  return result;
}
