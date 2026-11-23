import { useLocation, useParams } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

import {
  openQuestThread,
  postQuest,
  questPanelRole,
  useQuestFeed,
  questThread,
  questThreadSnapshot,
} from "../questBridge";
import {
  readThreadShells,
  useServerConfigs,
  useThreadShell,
  useThreadShells,
} from "../state/entities";
import { resolveThreadRouteRef } from "../threadRoutes";

export function QuestPanelCoordinator() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const threadRef = useParams({ strict: false, select: resolveThreadRouteRef });
  const role = threadRef ? "thread" : questPanelRole();
  const feed = useQuestFeed();
  const threads = useThreadShells(feed);
  const ownThread = useThreadShell(role === "thread" ? threadRef : null);
  const configs = useServerConfigs();
  const snapshot = questThreadSnapshot(
    threads,
    (id) => [...configs].find(([environmentId]) => environmentId === id)?.[1].providers ?? [],
  );
  const snapshotKey = JSON.stringify(snapshot);
  const ownState = ownThread
    ? questThread(ownThread, configs.get(ownThread.environmentId)?.providers ?? [])
    : null;
  const panelState = ownState
    ? {
        v: 1 as const,
        environmentId: ownState.environmentId,
        threadId: ownState.threadId,
        title: ownState.title,
        harness: ownState.harness,
        state: ownState.state,
        needsUser: ownState.needsUser,
      }
    : null;
  const panelStateKey = JSON.stringify(panelState);
  const sendPanelState = useEffectEvent(() => {
    if (panelState) postQuest("panelState", panelState);
  });
  const sendSnapshot = useEffectEvent(() => {
    postQuest("postThreads", { v: 1, threads: snapshot });
  });

  useEffect(() => {
    if (role) postQuest("ready", { v: 1, role, path: pathname });
  }, [role, pathname]);

  useEffect(() => {
    if (!feed || !snapshotKey) return;
    const timer = setTimeout(sendSnapshot, 300);
    return () => clearTimeout(timer);
  }, [feed, snapshotKey]);

  useEffect(() => {
    if (!feed) return;
    const timer = setInterval(sendSnapshot, 30_000);
    return () => clearInterval(timer);
  }, [feed]);

  useEffect(() => {
    if (role === "thread" && panelStateKey !== "null") sendPanelState();
  }, [role, panelStateKey]);

  useEffect(() => {
    // Capturing anchors covers markdown links and chips, including portaled viewers.
    const openLink = (event: MouseEvent) => {
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      const thread = readThreadShells().find(
        (item) =>
          url.pathname ===
          `/${encodeURIComponent(item.environmentId)}/${encodeURIComponent(item.id)}`,
      );
      if (
        thread &&
        openQuestThread({
          environmentId: thread.environmentId,
          threadId: thread.id,
          title: thread.title,
        })
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("click", openLink, true);
    return () => document.removeEventListener("click", openLink, true);
  }, []);

  return null;
}
