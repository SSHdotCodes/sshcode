import { use, useEffect, useState } from "react";
import { useIsFocused } from "@react-navigation/native";
import { AppState } from "react-native";
import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import {
  createTurnMascotMoments,
  type TurnMascotSnapshot,
} from "@t3tools/client-runtime/mascot-moments";
import { harnessMascotTurnState } from "@t3tools/shared/harnessMascots";

/** Ephemeral reactions for a turn witnessed in this chat, never opened history. */
export function useTurnMascotMoments(
  threadKey: string,
  working: boolean,
  waiting: boolean,
  status: string | undefined,
  runKey?: string,
) {
  const focused = useIsFocused();
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const [snapshot, setSnapshot] = useState<TurnMascotSnapshot | null>(null);
  const [moments] = useState(() => createTurnMascotMoments(setSnapshot));
  useEffect(() => {
    const sync = () =>
      moments.setActive(focused && tabActive && AppState.currentState === "active");
    sync();
    const subscription = AppState.addEventListener("change", sync);
    return () => subscription.remove();
  }, [moments, focused, tabActive]);
  useEffect(() => () => moments.dispose(), [moments]);
  useEffect(() => {
    moments.update({ threadKey, working, waiting, status, runKey });
  }, [moments, threadKey, working, waiting, status, runKey]);
  return {
    state: harnessMascotTurnState(
      working,
      waiting,
      snapshot?.threadKey === threadKey ? snapshot.state : null,
    ),
    moment: snapshot?.threadKey === threadKey ? snapshot.moment : null,
  };
}

export function useTurnMascotState(
  threadKey: string,
  working: boolean,
  waiting: boolean,
  status: string | undefined,
  runKey?: string,
) {
  return useTurnMascotMoments(threadKey, working, waiting, status, runKey).state;
}
