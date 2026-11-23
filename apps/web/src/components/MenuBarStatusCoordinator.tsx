import { useEffect, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  formatQuotaReset,
  newChatUsageWindows,
  selectHappeningNow,
} from "@t3tools/client-runtime/new-chat-dashboard";

import { isElectron } from "../env";
import { useNowMinute } from "../hooks/useNowMinute";
import { usePrivacyMode } from "../hooks/usePrivacyMode";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { buildMenuBarStatus } from "../menuBarStatus";
import { questPanelRole } from "../questBridge";
import { useServerConfigs, useThreadShells } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { useHiddenWorkflowChatKeys } from "./workflows/WorkflowRunChatsTracker";

/**
 * Feeds the Mac menu-bar item: the chats that need the user and the chats still working (the same
 * selection and order as "Happening now"), plus this machine's usage limits.
 */
export function MenuBarStatusCoordinator() {
  const navigate = useNavigate();
  const settingsHydrated = useClientSettingsHydrated();
  const enabled = useClientSettings((settings) => settings.menuBarStatusEnabled);
  const supported =
    isElectron && questPanelRole() === null && window.desktopBridge?.setMenuBarStatus !== undefined;
  const active = supported && settingsHydrated && enabled;
  const threads = useThreadShells(active);
  const hideTitles = usePrivacyMode();
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const hiddenWorkflowChats = useHiddenWorkflowChatKeys();
  const serverConfigs = useServerConfigs();
  const { presentationById } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();

  const status = useMemo(() => {
    if (!active) return null;
    const { entries } = selectHappeningNow(threads, {
      now,
      connectionPhase: (environmentId) => presentationById.get(environmentId)?.connection.phase,
      snoozes: (environmentId) =>
        serverConfigs.get(environmentId)?.environment.capabilities.threadSnooze === true,
      isHidden: (thread) =>
        hiddenWorkflowChats !== null &&
        (thread.source.creationSource === "workflows" ||
          hiddenWorkflowChats.has(`${thread.environmentId}:${thread.id}`)),
    });
    const windows =
      primaryEnvironmentId === null
        ? []
        : newChatUsageWindows(
            serverConfigs.get(primaryEnvironmentId) ?? null,
            primaryEnvironmentId,
            null,
          );
    return buildMenuBarStatus({
      chats: entries.map((entry) => ({
        environmentId: entry.thread.environmentId,
        threadId: entry.thread.id,
        title: entry.thread.title,
        needsYou: entry.box.tone === "asking",
      })),
      limits: windows.map((window) => ({
        accountLabel: window.accountLabel,
        label: window.label,
        usedPercent: window.usedPercent,
        resets: window.resetsAt ? formatQuotaReset(window.resetsAt) : null,
      })),
      hideTitles,
    });
  }, [
    active,
    threads,
    now,
    presentationById,
    serverConfigs,
    hiddenWorkflowChats,
    primaryEnvironmentId,
    hideTitles,
  ]);

  // The menu is rebuilt natively on every send, so only real changes go out.
  const serialized = useMemo(() => JSON.stringify(status), [status]);
  useEffect(() => {
    if (!supported || !settingsHydrated) return;
    const timer = window.setTimeout(() => {
      void window.desktopBridge?.setMenuBarStatus?.(JSON.parse(serialized));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [serialized, settingsHydrated, supported]);

  useEffect(
    () =>
      window.desktopBridge?.onMenuBarOpenChat?.((chat) => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: {
            environmentId: chat.environmentId as EnvironmentId,
            threadId: chat.threadId as ThreadId,
          },
        });
      }),
    [navigate],
  );

  return null;
}
