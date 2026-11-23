// @effect-diagnostics globalTimers:off - Ephemeral presentation timing, outside an Effect runtime.
import { harnessMascotTurnState, type HarnessMascotState } from "@t3tools/shared/harnessMascots";

export const MASCOT_REACTION_MS = 4800;
export const MASCOT_BUBBLE_MS = 3600;
export const MASCOT_BUBBLE_COOLDOWN_MS = 60_000;
export const MASCOT_PET_MS = 1600;

export interface MascotMoment {
  readonly kind: "waiting" | "failed" | "returned" | "milestone";
  readonly text: string;
}

export interface TurnMascotSnapshot {
  readonly threadKey: string;
  readonly state: HarnessMascotState;
  readonly moment: MascotMoment | null;
}

interface TurnObservation {
  readonly threadKey: string;
  readonly working: boolean;
  readonly waiting: boolean;
  readonly status: string | undefined;
  readonly runKey?: string | undefined;
}

/** Watches this visit only. History, reconnect snapshots and other chats never celebrate. */
export function createTurnMascotMoments(
  onChange: (snapshot: TurnMascotSnapshot) => void,
  now = Date.now,
) {
  let previous: TurnObservation | null = null;
  let startedAt: number | null = null;
  let completed = 0;
  let settledRunKey: string | undefined;
  let active = true;
  let outcome: HarnessMascotState | null = null;
  let moment: MascotMoment | null = null;
  let returnedAt: number | null = null;
  let resumedAt: number | null = null;
  let lastBubbleAt = -Infinity;
  let lastSnapshot: TurnMascotSnapshot | null = null;
  let reactionTimer: ReturnType<typeof setTimeout> | undefined;
  let bubbleTimer: ReturnType<typeof setTimeout> | undefined;
  let waitingTimer: ReturnType<typeof setTimeout> | undefined;

  const publish = () => {
    if (!previous) return;
    const state = harnessMascotTurnState(previous.working, previous.waiting, outcome);
    if (
      lastSnapshot?.threadKey === previous.threadKey &&
      lastSnapshot.state === state &&
      lastSnapshot.moment === moment
    )
      return;
    lastSnapshot = { threadKey: previous.threadKey, state, moment };
    onChange(lastSnapshot);
  };
  const hideBubble = () => {
    clearTimeout(bubbleTimer);
    moment = null;
  };
  const showBubble = (next: MascotMoment) => {
    if (!active || (next.kind !== "milestone" && now() - lastBubbleAt < MASCOT_BUBBLE_COOLDOWN_MS))
      return;
    hideBubble();
    moment = next;
    lastBubbleAt = now();
    bubbleTimer = setTimeout(() => {
      moment = null;
      publish();
    }, MASCOT_BUBBLE_MS);
  };
  const dispose = () => {
    clearTimeout(reactionTimer);
    clearTimeout(bubbleTimer);
    clearTimeout(waitingTimer);
  };

  return {
    update(next: TurnObservation) {
      const last = previous;
      const changedThread = last?.threadKey !== next.threadKey;
      previous = next;
      if (changedThread) {
        dispose();
        startedAt = null;
        completed = 0;
        settledRunKey = next.status === "running" ? undefined : next.runKey;
        outcome = null;
        moment = null;
        returnedAt = null;
        resumedAt = null;
        lastBubbleAt = -Infinity;
      }
      const running = next.working || next.status === "running";
      if (running && startedAt === null) {
        startedAt = now();
        returnedAt = null;
        resumedAt = null;
        outcome = null;
        clearTimeout(reactionTimer);
        hideBubble();
      }
      if (!next.waiting) {
        clearTimeout(waitingTimer);
        if (moment?.kind === "waiting") hideBubble();
      } else if (!changedThread && !last?.waiting && startedAt !== null && active) {
        waitingTimer = setTimeout(() => {
          if (previous?.waiting) {
            showBubble({ kind: "waiting", text: "Your turn 👋" });
            publish();
          }
        }, 1200);
      }
      if (
        !changedThread &&
        (last?.working || last?.status === "running") &&
        (next.runKey === undefined || next.runKey !== settledRunKey) &&
        !next.working &&
        (next.status === "completed" || next.status === "failed" || next.status === "interrupted")
      ) {
        settledRunKey = next.runKey;
        outcome = next.status === "completed" ? "done" : "failed";
        clearTimeout(reactionTimer);
        reactionTimer = setTimeout(() => {
          outcome = null;
          publish();
        }, MASCOT_REACTION_MS);
        if (next.status === "completed") {
          completed++;
          if (completed === 5 && active && !next.waiting) {
            showBubble({ kind: "milestone", text: "Five high fives ✨" });
          } else if (
            startedAt !== null &&
            now() - startedAt >= 60_000 &&
            (!active || (resumedAt !== null && now() - resumedAt < 5000))
          ) {
            // A suspended mobile client may receive the result just after it resumes.
            if (active) showBubble({ kind: "returned", text: "Ready for you ✨" });
            else returnedAt = now();
          }
        } else if (next.status === "failed" && !next.waiting) {
          showBubble({ kind: "failed", text: "A little snag 🌱" });
        }
        startedAt = null;
      }
      publish();
    },
    setActive(value: boolean) {
      if (active === value) return;
      active = value;
      resumedAt = active && startedAt !== null ? now() : null;
      if (!active) {
        clearTimeout(waitingTimer);
        hideBubble();
      } else if (returnedAt !== null) {
        if (now() - returnedAt < 5 * 60_000 && !previous?.working && !previous?.waiting) {
          showBubble({ kind: "returned", text: "Ready for you ✨" });
        }
        returnedAt = null;
      }
      publish();
    },
    dispose,
  };
}

export interface MascotPetReaction {
  readonly state: "greet" | "idea";
  readonly hearts: number;
}

/** Three gentle pets, then a rest. No timer or persistent counter while idle. */
export function createMascotPetting() {
  let lastPetAt = -Infinity;
  let restingUntil = -Infinity;
  let streak = 0;
  return {
    pet(now: number): MascotPetReaction | null {
      if (now < restingUntil || now - lastPetAt < 450) return null;
      streak = now - lastPetAt > 2200 ? 1 : streak + 1;
      lastPetAt = now;
      if (streak === 3) restingUntil = now + 8000;
      return { state: streak === 1 ? "greet" : "idea", hearts: streak };
    },
  };
}

/** Hearts still acknowledge a pet while the work/approval pose stays readable. */
export function pettedMascotState(
  state: HarnessMascotState,
  reaction: MascotPetReaction | null,
): HarnessMascotState {
  return state === "working" || state === "waiting" || state === "failed"
    ? state
    : (reaction?.state ?? state);
}
