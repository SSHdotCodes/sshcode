import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  createMascotPetting,
  MASCOT_PET_MS,
  pettedMascotState,
  type MascotPetReaction,
} from "@t3tools/client-runtime/mascot-moments";
import type { HarnessMascotState } from "@t3tools/shared/harnessMascots";
import styles from "./MascotCompanion.module.css";

/** A small, optional interaction around the shared mascot renderer. */
export function MascotCompanion({
  children,
  state = "idle",
  size,
}: {
  readonly children: (state: HarnessMascotState) => ReactNode;
  readonly state?: HarnessMascotState;
  readonly size: number;
}) {
  const [petting] = useState(createMascotPetting);
  const [reaction, setReaction] = useState<MascotPetReaction | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const reset = () => {
      if (document.hidden) {
        clearTimeout(timer.current);
        setReaction(null);
      }
    };
    document.addEventListener("visibilitychange", reset);
    return () => {
      clearTimeout(timer.current);
      document.removeEventListener("visibilitychange", reset);
    };
  }, []);

  return (
    <button
      type="button"
      className={styles.companion}
      style={{ width: size, height: size }}
      aria-label="Pet your companion"
      onClick={() => {
        const next = petting.pet(Date.now());
        if (!next) return;
        clearTimeout(timer.current);
        setReaction(next);
        timer.current = setTimeout(() => setReaction(null), MASCOT_PET_MS);
      }}
    >
      {children(pettedMascotState(state, reaction))}
      {reaction ? (
        <span key={reaction.hearts} className={styles.hearts} aria-hidden="true">
          {Array.from({ length: reaction.hearts }, (_, index) => (
            <span key={index} style={{ left: `${25 + index * 25}%` }}>
              ♥
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}
