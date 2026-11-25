import type { DesktopEnvironmentBootstrap } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { readDesktopSecondaryBootstraps, supportsDesktopSecondaryBootstraps } from "./desktopLocal";

const DESKTOP_LOCAL_BOOTSTRAP_POLL_MS = 2_000;
const EMPTY_BOOTSTRAPS: ReadonlyArray<DesktopEnvironmentBootstrap> = [];

const listeners = new Set<() => void>();
let currentSnapshot: ReadonlyArray<DesktopEnvironmentBootstrap> = EMPTY_BOOTSTRAPS;
let pollInterval: ReturnType<typeof setInterval> | null = null;

function refreshSnapshot() {
  const next = readDesktopSecondaryBootstraps();
  if (next === currentSnapshot) {
    return;
  }
  currentSnapshot = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  if (!supportsDesktopSecondaryBootstraps()) {
    return () => {};
  }
  listeners.add(listener);
  if (pollInterval === null) {
    refreshSnapshot();
    pollInterval = setInterval(refreshSnapshot, DESKTOP_LOCAL_BOOTSTRAP_POLL_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && pollInterval !== null) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
  };
}

function getSnapshot(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  if (!supportsDesktopSecondaryBootstraps()) {
    return EMPTY_BOOTSTRAPS;
  }
  if (pollInterval === null) {
    currentSnapshot = readDesktopSecondaryBootstraps();
  }
  return currentSnapshot;
}

/**
 * Reactively track the desktop's secondary local backends (e.g. a parallel WSL
 * backend). Shares one poll timer across all renderer consumers and skips
 * polling completely on platforms without secondary local backends (macOS,
 * Linux, browser).
 */
export function useDesktopLocalBootstraps(): ReadonlyArray<DesktopEnvironmentBootstrap> {
  return useSyncExternalStore(subscribe, getSnapshot, () => EMPTY_BOOTSTRAPS);
}
