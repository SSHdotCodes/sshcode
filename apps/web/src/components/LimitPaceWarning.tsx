import { useAtomValue } from "@effect/atom-react";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  LIMIT_WARNING_MIN_USED_PERCENT,
  limitPaceWarning,
  limitPeriodKey,
  recentUsageRunOut,
} from "@t3tools/shared/usageLimitForecast";
import { useEffect } from "react";

import { usePrimarySettings } from "../hooks/useSettings";
import { primaryServerProvidersAtom } from "../state/server";
import { formatClockTime } from "../timestampFormat";
import { toastManager } from "./ui/toast";

/** One warning per limit period, for as long as this window stays open. */
const warned = new Set<string>();
/** The toast showing each window's warning, so later readings can update or close it. */
const shown = new Map<string, { readonly toastId: string; readonly resetKey: string }>();

function warningText(
  name: string,
  window: ServerProviderUsageWindow,
  now: number,
  timestampFormat: Parameters<typeof formatClockTime>[1],
) {
  const runsOutAt = recentUsageRunOut(window, now);
  return {
    title: `${name} \u00b7 ${window.label}: ${Math.round(window.usedPercent)}% used`,
    description:
      window.usedPercent >= 100
        ? "It is used up until it resets."
        : runsOutAt === null
          ? "At the last hour's pace it lasts until the reset."
          : `At the last hour's pace it runs out around ${formatClockTime(runsOutAt, timestampFormat)}.`,
  };
}

/**
 * Says so once when a limit is about to run out at the last hour's pace. The
 * average pace since a week opened hides a busy evening: 87% used with ten
 * hours to the reset read as fine an hour before the limit hit.
 *
 * The warning then stays until it is dismissed or stops being true: its numbers follow each new
 * reading, and it closes when the window resets, drops back below the warning level, or is no
 * longer reported. A pace that eases for a while does not close it.
 */
export function LimitPaceWarning() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  useEffect(() => {
    // Nothing loaded yet (first paint, reconnecting): leave open warnings alone.
    if (providers.length === 0) return;
    const now = Date.now();
    const kept = new Set<string>();
    for (const provider of providers) {
      if (!provider.enabled) continue;
      const prefix = `${provider.instanceId}:`;
      // A failed probe's older reading says nothing about the pace now.
      const windows = provider.usageLimits?.unavailable
        ? []
        : (provider.usageLimits?.windows ?? []);
      if (windows.length === 0) {
        // No reading for this provider right now says nothing about its warnings.
        for (const windowKey of shown.keys()) {
          if (windowKey.startsWith(prefix)) kept.add(windowKey);
        }
        continue;
      }
      const name = provider.displayName?.trim() || String(provider.driver);
      for (const window of windows) {
        const windowKey = `${prefix}${window.id}`;
        const open = shown.get(windowKey);
        if (
          open &&
          open.resetKey === limitPeriodKey(window) &&
          window.usedPercent >= LIMIT_WARNING_MIN_USED_PERCENT
        ) {
          kept.add(windowKey);
          toastManager.update(open.toastId, warningText(name, window, now, timestampFormat));
          continue;
        }
        const warning = limitPaceWarning(window, now);
        if (warning === null) continue;
        const key = `${prefix}${warning.resetKey}`;
        if (warned.has(key)) continue;
        warned.add(key);
        if (open) toastManager.close(open.toastId);
        kept.add(windowKey);
        const toastId = toastManager.add({
          type: "warning",
          ...warningText(name, window, now, timestampFormat),
          timeout: 0,
        });
        shown.set(windowKey, { toastId, resetKey: warning.resetKey });
      }
    }
    // A warning the newest reading no longer backs must not stay up.
    for (const [windowKey, open] of shown) {
      if (kept.has(windowKey)) continue;
      toastManager.close(open.toastId);
      shown.delete(windowKey);
    }
  }, [providers, timestampFormat]);
  return null;
}
