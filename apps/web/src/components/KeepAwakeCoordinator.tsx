import { useEffect, useMemo } from "react";

import { isElectron } from "../env";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { agentWorkOnMachine } from "../keepAwake";
import { questPanelRole } from "../questBridge";
import { useThreadShells } from "../state/entities";
import { usePrimaryEnvironmentId } from "../state/environments";

/**
 * Tells the desktop app which agent work is in flight on this machine, so it can keep the
 * computer from idle-sleeping in the middle of it.
 */
export function KeepAwakeCoordinator() {
  const settingsHydrated = useClientSettingsHydrated();
  const enabled = useClientSettings((settings) => settings.keepAwakeWhileWorking);
  const supported =
    isElectron && questPanelRole() === null && window.desktopBridge?.setKeepAwake !== undefined;
  const active = supported && settingsHydrated && enabled;
  const threads = useThreadShells(active);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const work = useMemo(
    () => (active ? agentWorkOnMachine(threads, primaryEnvironmentId) : null),
    [active, primaryEnvironmentId, threads],
  );
  const working = work?.working ?? null;
  const waiting = work?.waiting ?? null;

  useEffect(() => {
    if (!supported || !settingsHydrated) return;
    // A short pause between turns should not drop and retake the hold.
    const timer = window.setTimeout(
      () => {
        void window.desktopBridge?.setKeepAwake?.(
          working === null || waiting === null ? null : { working, waiting },
        );
      },
      working ? 0 : 5_000,
    );
    return () => window.clearTimeout(timer);
  }, [settingsHydrated, supported, waiting, working]);

  return null;
}
