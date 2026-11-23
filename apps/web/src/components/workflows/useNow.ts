import { useSyncExternalStore } from "react";

/**
 * One shared one-second clock for elapsed labels. It only ticks while some live
 * label is mounted, and only those labels re-render.
 */
const listeners = new Set<() => void>();
let clock = () => Date.now();
let now = clock();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (timer === null) {
    now = clock();
    timer = setInterval(() => {
      now = clock();
      for (const entry of listeners) entry();
    }, 1000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const idleSubscribe = () => () => {};
const read = () => now;

export function useNow(live: boolean): number {
  return useSyncExternalStore(live ? subscribe : idleSubscribe, read);
}

/** Dev fixture only: pin the clock so frozen runs show matching elapsed times. */
export function setWorkflowClock(next: (() => number) | null) {
  clock = next ?? (() => Date.now());
  now = clock();
  for (const listener of listeners) listener();
}
