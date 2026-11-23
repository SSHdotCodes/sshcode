/**
 * Notices an agent asking the same status question again with nothing
 * changed. Each check is a full model round trip over the agent's context,
 * and the wake-up it is waiting for comes on its own, so the answer can say
 * so. Memory only: a restart forgets earlier checks.
 *
 * @module mcp/repeatChecks
 */

/** Checks further apart than this are not polling. */
const REPEAT_WINDOW_MS = 10 * 60 * 1_000;
const MAX_TRACKED = 2_000;

/**
 * Returns a check function: given what is asked about (`key`), what the answer
 * says (`fingerprint`) and the time, it returns how many milliseconds ago the
 * same answer was given, or undefined when the answer changed or is new.
 */
export function makeRepeatChecks() {
  const last = new Map<string, { readonly fingerprint: string; readonly at: number }>();
  return (key: string, fingerprint: string, now: number): number | undefined => {
    const previous = last.get(key);
    last.delete(key);
    last.set(key, { fingerprint, at: now });
    if (last.size > MAX_TRACKED) last.delete(last.keys().next().value!);
    return previous !== undefined &&
      previous.fingerprint === fingerprint &&
      now - previous.at < REPEAT_WINDOW_MS
      ? now - previous.at
      : undefined;
  };
}

/** The note an unchanged answer carries, naming what wakes the agent instead. */
export const unchangedNotice = (sinceMs: number, wakes: string) =>
  `No change since your check ${Math.max(1, Math.round(sinceMs / 1_000))} s ago. ${wakes} wakes this thread on its own; end your turn if waiting is all that's left.`;
