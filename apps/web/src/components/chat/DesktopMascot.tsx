import { useSyncExternalStore } from "react";
import type { HarnessMascotState } from "@t3tools/shared/harnessMascots";
import { HarnessMascot } from "../HarnessMascot";
import { MascotCompanion } from "../MascotCompanion";
import type { MascotMoment } from "@t3tools/client-runtime/mascot-moments";
import styles from "../MascotCompanion.module.css";

const KEY = "sshcode.desktop-mascot";
const EVENT = "sshcode:desktop-mascot";
const subscribe = (changed: () => void) => {
  window.addEventListener(EVENT, changed);
  window.addEventListener("storage", changed);
  return () => {
    window.removeEventListener(EVENT, changed);
    window.removeEventListener("storage", changed);
  };
};
function readEnabled() {
  try {
    return localStorage.getItem(KEY) !== "false";
  } catch {
    return true;
  }
}
export function useDesktopMascotPreference() {
  const enabled = useSyncExternalStore(subscribe, readEnabled, () => true);
  return {
    enabled,
    setEnabled: (value: boolean) => {
      try {
        localStorage.setItem(KEY, String(value));
      } catch {
        return;
      }
      window.dispatchEvent(new Event(EVENT));
    },
  };
}

export function DesktopMascot({
  state,
  moment,
}: {
  readonly state: HarnessMascotState;
  readonly moment?: MascotMoment | null;
}) {
  const { enabled } = useDesktopMascotPreference();
  return enabled ? (
    // Global hook for the existing gutter and Discord skin styles.
    <div className={`desktop-harness-mascot ${styles.gutter}`}>
      {moment ? (
        <span key={moment.kind} className={styles.bubble} aria-hidden="true">
          {moment.text}
        </span>
      ) : null}
      <MascotCompanion state={state} size={64}>
        {(pose) => <HarnessMascot state={pose} size={64} />}
      </MascotCompanion>
    </div>
  ) : null;
}
