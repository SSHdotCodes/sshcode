import { use, useEffect, useLayoutEffect, useState } from "react";
import { useIsFocused } from "@react-navigation/native";
import { AppState } from "react-native";
import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";
import {
  createTurnMascotMoments,
  resolveTurnMascotCompletion,
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
  const [observed, setObserved] = useState<ReturnType<typeof moments.update> | null>(null);
  useEffect(() => {
    const sync = () =>
      moments.setActive(focused && tabActive && AppState.currentState === "active");
    sync();
    const subscription = AppState.addEventListener("change", sync);
    return () => subscription.remove();
  }, [moments, focused, tabActive]);
  useEffect(() => () => moments.dispose(), [moments]);
  useLayoutEffect(() => {
    setObserved(moments.update({ threadKey, working, waiting, status, runKey }));
  }, [moments, threadKey, working, waiting, status, runKey]);
  // The result must be visible in the render that removes the working status.
  const completion = resolveTurnMascotCompletion(
    observed?.observation,
    { threadKey, working, waiting, status, runKey },
    observed?.settledRunKey,
  );
  const current = snapshot?.threadKey === threadKey ? snapshot : null;
  const outcome = current?.state === "done" || current?.state === "failed" ? current.state : null;
  return {
    state: harnessMascotTurnState(working, waiting, completion ?? outcome),
    moment: current?.moment ?? null,
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
