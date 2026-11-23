import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isHelperThreadId, type ServerProvider } from "@t3tools/contracts";
import { harnessMascotForDriver, harnessMascotTurnState } from "@t3tools/shared/harnessMascots";
import { useEffect, useSyncExternalStore } from "react";

import { resolveSidebarThreadStatus } from "./components/Sidebar.logic";
import { useStableCallback } from "./hooks/useStableCallback";

export type QuestPanelRole = "overview" | "thread" | "new";
export type QuestThreadState = "idle" | "working" | "waiting" | "done" | "failed";
export type QuestThread = {
  environmentId: string;
  threadId: string;
  title: string;
  harness: "claude" | "codex" | "grok" | "muse" | null;
  state: QuestThreadState;
  needsUser: boolean;
  updatedAt: string;
};
export type QuestPayloads = {
  ready: { v: 1; role: QuestPanelRole; path: string };
  postThreads: { v: 1; threads: QuestThread[] };
  panelState: { v: 1 } & Omit<QuestThread, "updatedAt">;
  openThread: Pick<QuestThread, "environmentId" | "threadId" | "title">;
};
export type QuestComposerEvent =
  | { type: "insertText"; text: string }
  | { type: "send" }
  | { type: "focusComposer" };

declare global {
  interface Window {
    SSHCodeQuest?: { [K in keyof QuestPayloads]: (json: string) => void };
  }
}

const STORAGE_KEY = "sshcodePanel";
const isRole = (value: string | null): value is QuestPanelRole =>
  value === "overview" || value === "thread" || value === "new";

export function detectQuestPanelRole(
  search: string,
  storage: Pick<Storage, "getItem" | "setItem">,
): QuestPanelRole | null {
  const role = new URLSearchParams(search).get(STORAGE_KEY);
  if (isRole(role)) {
    try {
      storage.setItem(STORAGE_KEY, role);
    } catch {
      // A WebView may disable storage; the URL still enables this panel.
    }
    return role;
  }
  try {
    const saved = storage.getItem(STORAGE_KEY);
    return isRole(saved) ? saved : null;
  } catch {
    return null;
  }
}

let currentRole: QuestPanelRole | null = null;
export function questPanelRole(): QuestPanelRole | null {
  if (typeof window === "undefined") return null;
  try {
    currentRole =
      detectQuestPanelRole(window.location.search, window.sessionStorage) ?? currentRole;
  } catch {
    const role = new URLSearchParams(window.location.search).get(STORAGE_KEY);
    if (isRole(role)) currentRole = role;
  }
  return currentRole;
}

export function detectQuestFeed(
  search: string,
  storage: Pick<Storage, "getItem" | "setItem">,
): boolean {
  const flag = new URLSearchParams(search).get("sshcodeFeed");
  try {
    if (flag !== null) {
      const value = flag === "1" ? "1" : "0";
      if (storage.getItem("sshcodeFeed") !== value) storage.setItem("sshcodeFeed", value);
    }
    return flag !== null ? flag === "1" : storage.getItem("sshcodeFeed") === "1";
  } catch {
    return flag === "1";
  }
}

function readQuestFeed() {
  if (typeof window === "undefined") return false;
  try {
    return detectQuestFeed(window.location.search, window.sessionStorage);
  } catch {
    return new URLSearchParams(window.location.search).get("sshcodeFeed") === "1";
  }
}

function subscribeQuestFeed(changed: () => void) {
  window.addEventListener("sshcode-quest-feed", changed);
  return () => window.removeEventListener("sshcode-quest-feed", changed);
}

export function useQuestFeed() {
  return useSyncExternalStore(subscribeQuestFeed, readQuestFeed, () => false);
}

export function postQuest<K extends keyof QuestPayloads>(method: K, payload: QuestPayloads[K]) {
  if (!questPanelRole() || typeof window.SSHCodeQuest !== "object" || !window.SSHCodeQuest) {
    return false;
  }
  const call = window.SSHCodeQuest[method];
  if (typeof call !== "function") return false;
  call.call(window.SSHCodeQuest, JSON.stringify(payload));
  return true;
}

export function openQuestThread(payload: QuestPayloads["openThread"]) {
  return postQuest("openThread", payload);
}

export function questThread(
  thread: EnvironmentThreadShell,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>,
): QuestThread {
  const status = resolveSidebarThreadStatus(thread);
  const needsUser = status === "approval" || status === "input";
  const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
  const driver = providers.find((provider) => provider.instanceId === instanceId)?.driver;
  const harness = harnessMascotForDriver(driver)?.id;
  const outcome =
    status === "failed" || status === "limited" || thread.latestRun?.status === "interrupted"
      ? "failed"
      : thread.latestRun?.status === "completed"
        ? "done"
        : thread.latestRun?.status === "failed"
          ? "failed"
          : null;
  return {
    environmentId: thread.environmentId,
    threadId: thread.id,
    title: thread.title,
    // The external Quest v1 bridge only understands the original four harnesses.
    harness:
      harness === "claude" || harness === "codex" || harness === "grok" || harness === "muse"
        ? harness
        : null,
    // Sidebar idle means background work is waiting, not a user question.
    state: harnessMascotTurnState(
      status === "working" || status === "waiting",
      needsUser,
      outcome,
    ) as QuestThreadState,
    needsUser,
    updatedAt: thread.updatedAt,
  };
}

export function questThreadSnapshot(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  providersFor: (
    environmentId: string,
  ) => ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>,
): QuestThread[] {
  const priority = (thread: QuestThread) =>
    thread.needsUser ? 0 : thread.state === "working" ? 1 : 2;
  return threads
    .filter(
      (thread) =>
        !thread.archivedAt && thread.settledOverride !== "settled" && !isHelperThreadId(thread.id),
    )
    .map((thread) => questThread(thread, providersFor(thread.environmentId)))
    .sort(
      (a, b) =>
        priority(a) - priority(b) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.environmentId.localeCompare(b.environmentId) ||
        a.threadId.localeCompare(b.threadId),
    )
    .slice(0, 40);
}

export type QuestComposerActions = {
  insertText: (text: string) => void;
  send: () => void;
  focusComposer: () => void;
};

export function listenForQuestComposer(target: EventTarget, actions: QuestComposerActions) {
  const listener = (event: Event) => {
    const detail: unknown = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== "object" || !("type" in detail)) return;
    switch (detail.type) {
      case "insertText":
        if (!("text" in detail) || typeof detail.text !== "string") return;
        actions.focusComposer();
        actions.insertText(detail.text);
        break;
      case "send":
        actions.send();
        break;
      case "focusComposer":
        actions.focusComposer();
        break;
    }
  };
  target.addEventListener("sshcode-quest", listener);
  return () => target.removeEventListener("sshcode-quest", listener);
}

export function useQuestComposer(actions: QuestComposerActions) {
  // Not useEffectEvent: React 19.2 never refreshes it in memo() components (ChatComposer).
  const handle = useStableCallback(() => actions);
  useEffect(() => {
    if (!questPanelRole()) return;
    return listenForQuestComposer(window, {
      insertText: (text) => handle().insertText(text),
      send: () => handle().send(),
      focusComposer: () => handle().focusComposer(),
    });
  }, [handle]);
}
