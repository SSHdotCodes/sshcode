import { createContext, useContext, useEffect, useState } from "react";
import { type PanelAnimationDurationMs } from "@t3tools/contracts/settings";

import { useMediaQuery } from "./hooks/useMediaQuery";
import { useClientSettings } from "./hooks/useSettings";

const PanelAnimationSuppressionContext = createContext(false);

export const PanelAnimationSuppressionProvider = PanelAnimationSuppressionContext.Provider;

/** Exits are snappier than enters (≈120 ms at the default 175 ms panel duration). */
export function resolvePanelExitDurationMs(durationMs: number): number {
  if (durationMs <= 0) return 0;
  return Math.min(120, Math.max(80, Math.round(durationMs * 0.68)));
}

/**
 * Suppresses panel motion for the first painted frame of an initial route or navigation.
 * State restored by a route must be visible immediately; later user actions can animate.
 */
export function usePanelNavigationSuppression(navigationKey: string): boolean {
  const [paintedNavigationKey, setPaintedNavigationKey] = useState<string | null>(null);
  const suppressed = paintedNavigationKey !== navigationKey;

  useEffect(() => {
    if (!suppressed) return;
    let releaseFrame = 0;
    const paintFrame = window.requestAnimationFrame(() => {
      releaseFrame = window.requestAnimationFrame(() => setPaintedNavigationKey(navigationKey));
    });
    return () => {
      window.cancelAnimationFrame(paintFrame);
      window.cancelAnimationFrame(releaseFrame);
    };
  }, [navigationKey, suppressed]);

  return suppressed;
}

export function usePanelAnimationSettings(): {
  active: boolean;
  durationMs: PanelAnimationDurationMs;
  exitDurationMs: number;
} {
  const durationMs = useClientSettings((settings) => settings.panelAnimationDurationMs);
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const suppressed = useContext(PanelAnimationSuppressionContext);
  const active = durationMs > 0 && !prefersReducedMotion && !suppressed;
  return {
    active,
    durationMs,
    exitDurationMs: resolvePanelExitDurationMs(durationMs),
  };
}

/** Keeps closing panel content mounted until its exit transition ends. */
export function usePanelPresence<T>(
  open: boolean,
  value: T | null,
  animated: boolean,
  scopeKey: string | null,
  exitDurationMs: number,
): { present: boolean; value: T | null } {
  const [present, setPresent] = useState(open);
  const [retained, setRetained] = useState<{ scopeKey: string | null; value: T | null } | null>(
    () => (open ? { scopeKey, value } : null),
  );

  if (open && (retained?.scopeKey !== scopeKey || retained?.value !== value)) {
    setRetained({ scopeKey, value });
  }

  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    if (!animated || exitDurationMs <= 0) {
      setPresent(false);
      return;
    }

    const timeout = window.setTimeout(() => setPresent(false), exitDurationMs);
    return () => window.clearTimeout(timeout);
  }, [animated, exitDurationMs, open]);

  const retainedValue = retained?.scopeKey === scopeKey ? retained.value : null;
  const visible = open || (animated && present && retained?.scopeKey === scopeKey);
  return { present: visible, value: open ? value : visible ? retainedValue : null };
}
