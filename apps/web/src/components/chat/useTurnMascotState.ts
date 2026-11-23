import { useEffect, useState } from "react";
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
  const [snapshot, setSnapshot] = useState<TurnMascotSnapshot | null>(null);
  const [moments] = useState(() => createTurnMascotMoments(setSnapshot));
  useEffect(() => {
    const sync = () => moments.setActive(!document.hidden);
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      moments.dispose();
    };
  }, [moments]);
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
