export interface KeepAwakeWork {
  /** An agent's turn is running on this machine. */
  readonly working: boolean;
  /** A chat on this machine waits on background work (monitors, subagents). */
  readonly waiting: boolean;
}

/**
 * Whether to hold the computer awake. A running turn always does. Background work that a chat
 * only waits on can run for days, so it holds the computer awake on mains power and lets a
 * laptop on battery sleep. Null is the setting turned off.
 */
export function keepAwakeWanted(work: KeepAwakeWork | null, onBattery: boolean): boolean {
  if (work === null) return false;
  return work.working || (work.waiting && !onBattery);
}
