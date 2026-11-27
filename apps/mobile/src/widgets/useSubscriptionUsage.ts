import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useMemo } from "react";
import { AppState } from "react-native";

import { appAtomRegistry } from "../state/atom-registry";
import { environmentPresentations } from "../state/presentation";
import { serverEnvironment } from "../state/server";
import { environmentShell } from "../state/shell";
import { useAtomCommand } from "../state/use-atom-command";
import {
  createWidgetRefresher,
  environmentNeedsUsageRefresh,
  WIDGET_REFRESH_INTERVAL,
  WIDGET_REFRESH_SETTLE_MS,
} from "./subscriptionUsageSnapshot";

const connectedLiveEnvironmentIdsAtom = Atom.make((get) => {
  const presentations = get(environmentPresentations.presentationsAtom);
  const ids: string[] = [];
  for (const [id, presentation] of presentations) {
    if (
      presentation.connection.phase === "connected" &&
      get(environmentShell.stateValueAtom(id)).status === "live"
    ) {
      ids.push(id);
    }
  }
  return ids.sort().join(",");
});

export function useSubscriptionUsage(enabled = true) {
  const connectedLiveIds = useAtomValue(connectedLiveEnvironmentIdsAtom);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const refresh = useMemo(
    () =>
      createWidgetRefresher(
        (environmentId: Parameters<typeof refreshProviders>[0]["environmentId"]) =>
          refreshProviders({ environmentId, input: { omitProviders: true } }),
      ),
    [refreshProviders],
  );

  useEffect(() => {
    if (!enabled || connectedLiveIds === "") return;
    const staleConnectedIds = (now: number): EnvironmentId[] => {
      const current = appAtomRegistry.get(environmentPresentations.presentationsAtom);
      const ids: EnvironmentId[] = [];
      for (const rawId of connectedLiveIds.split(",")) {
        if (!rawId) continue;
        const id = rawId as EnvironmentId;
        const presentation = current.get(id);
        if (
          presentation?.connection.phase === "connected" &&
          appAtomRegistry.get(environmentShell.stateValueAtom(id)).status === "live" &&
          environmentNeedsUsageRefresh(presentation.serverConfig, now)
        ) {
          ids.push(id);
        }
      }
      return ids;
    };
    const update = () => {
      if (AppState.currentState !== "active") return;
      const now = Date.now();
      const stale = staleConnectedIds(now);
      if (stale.length > 0) void refresh(stale, now);
    };
    // Defer initial refresh until after connect/reopen sync has settled.
    const settleTimer = setTimeout(update, WIDGET_REFRESH_SETTLE_MS);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") update();
    });
    const timer = setInterval(update, WIDGET_REFRESH_INTERVAL);
    return () => {
      clearTimeout(settleTimer);
      subscription.remove();
      clearInterval(timer);
    };
  }, [connectedLiveIds, enabled, refresh]);
}
