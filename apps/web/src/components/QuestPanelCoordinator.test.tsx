// @vitest-environment jsdom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";
import { useQuestComposer } from "../questBridge";
import { QuestPanelCoordinator } from "./QuestPanelCoordinator";

const state = vi.hoisted(() => ({
  pathname: "/overview",
  threadRef: null as { environmentId: EnvironmentId; threadId: ThreadId } | null,
  threads: [] as ReturnType<typeof makeThreadFixture>[],
  configs: new Map(),
}));
vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { pathname: string }) => string }) =>
    select({ pathname: state.pathname }),
  useParams: () => state.threadRef,
}));
vi.mock("../state/entities", () => ({
  useThreadShells: (enabled: boolean) => (enabled ? state.threads : []),
  useThreadShell: () => (state.threadRef ? (state.threads[0] ?? null) : null),
  useServerConfigs: () => state.configs,
  readThreadShells: () => state.threads,
}));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  state.pathname = "/overview";
  state.threadRef = null;
  state.threads = [makeThreadFixture({ runtime: null })];
  sessionStorage.setItem("sshcodePanel", "overview");
  window.SSHCodeQuest = {
    ready: vi.fn(),
    postThreads: vi.fn(),
    panelState: vi.fn(),
    openThread: vi.fn(),
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  sessionStorage.clear();
  delete window.SSHCodeQuest;
});

it("does not register composer commands in ordinary tabs", async () => {
  sessionStorage.clear();
  const send = vi.fn();
  function Composer() {
    useQuestComposer({ send, insertText: () => {}, focusComposer: () => {} });
    return null;
  }
  await act(async () => root.render(<Composer />));
  window.dispatchEvent(new CustomEvent("sshcode-quest", { detail: { type: "send" } }));
  expect(send).not.toHaveBeenCalled();
});

it("debounces full snapshots from the designated home and repeats the latest every 30 seconds", async () => {
  sessionStorage.setItem("sshcodePanel", "new");
  sessionStorage.setItem("sshcodeFeed", "1");
  state.pathname = "/new";
  await act(async () => root.render(<QuestPanelCoordinator />));
  expect(window.SSHCodeQuest!.ready).toHaveBeenCalledWith(
    JSON.stringify({ v: 1, role: "new", path: "/new" }),
  );
  expect(window.SSHCodeQuest!.postThreads).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(200));
  state.threads = [{ ...state.threads[0]!, title: "Updated title" }];
  await act(async () => root.render(<QuestPanelCoordinator />));
  await act(async () => vi.advanceTimersByTime(299));
  expect(window.SSHCodeQuest!.postThreads).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTime(1));
  expect(window.SSHCodeQuest!.postThreads).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(vi.mocked(window.SSHCodeQuest!.postThreads).mock.calls[0]![0]);
  expect(payload.threads).toHaveLength(1);
  expect(payload.threads[0].title).toBe("Updated title");
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(window.SSHCodeQuest!.postThreads).toHaveBeenCalledTimes(2);
  expect(window.SSHCodeQuest!.panelState).not.toHaveBeenCalled();
});

it("keeps Overview quiet without the feed flag and transfers the feed without reloading a chat", async () => {
  await act(async () => root.render(<QuestPanelCoordinator />));
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(window.SSHCodeQuest!.postThreads).not.toHaveBeenCalled();
  await act(async () => {
    sessionStorage.setItem("sshcodeFeed", "1");
    window.dispatchEvent(new Event("sshcode-quest-feed"));
  });
  await act(async () => vi.advanceTimersByTime(300));
  expect(window.SSHCodeQuest!.postThreads).toHaveBeenCalledTimes(1);
  await act(async () => {
    sessionStorage.setItem("sshcodeFeed", "0");
    window.dispatchEvent(new Event("sshcode-quest-feed"));
  });
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(window.SSHCodeQuest!.postThreads).toHaveBeenCalledTimes(1);
});

it("promotes new panels and reports only changes to their own thread state", async () => {
  sessionStorage.setItem("sshcodePanel", "new");
  state.pathname = "/draft/example";
  await act(async () => root.render(<QuestPanelCoordinator />));
  expect(window.SSHCodeQuest!.panelState).not.toHaveBeenCalled();
  const thread = state.threads[0]!;
  state.threadRef = { environmentId: thread.environmentId, threadId: thread.id };
  state.pathname = `/${thread.environmentId}/${thread.id}`;
  await act(async () => root.render(<QuestPanelCoordinator />));
  expect(window.SSHCodeQuest!.panelState).toHaveBeenCalledTimes(1);
  expect(JSON.parse(vi.mocked(window.SSHCodeQuest!.ready).mock.lastCall![0]).role).toBe("thread");
  state.threads = [{ ...thread, updatedAt: "2026-10-19T20:00:00.000Z" }];
  await act(async () => root.render(<QuestPanelCoordinator />));
  expect(window.SSHCodeQuest!.panelState).toHaveBeenCalledTimes(1);
  state.threads = [{ ...thread, hasPendingApprovals: true }];
  await act(async () => root.render(<QuestPanelCoordinator />));
  expect(JSON.parse(vi.mocked(window.SSHCodeQuest!.panelState).mock.lastCall![0])).toMatchObject({
    state: "waiting",
    needsUser: true,
  });
  await act(async () => vi.advanceTimersByTime(30_000));
  expect(window.SSHCodeQuest!.postThreads).not.toHaveBeenCalled();
});

it("intercepts chat anchors only with the bridge present", async () => {
  await act(async () => root.render(<QuestPanelCoordinator />));
  const thread = state.threads[0]!;
  const link = document.createElement("a");
  link.href = `/${thread.environmentId}/${thread.id}`;
  container.append(link);
  const click = () =>
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  expect(click()).toBe(false);
  expect(window.SSHCodeQuest!.openThread).toHaveBeenCalledWith(
    JSON.stringify({
      environmentId: thread.environmentId,
      threadId: thread.id,
      title: thread.title,
    }),
  );
  delete window.SSHCodeQuest;
  expect(click()).toBe(true);
});

it("composer listeners read current actions and unregister on unmount", async () => {
  const first = vi.fn();
  const second = vi.fn();
  function Composer({ send }: { send: () => void }) {
    useQuestComposer({ send, insertText: () => {}, focusComposer: () => {} });
    return null;
  }
  await act(async () => root.render(<Composer send={first} />));
  const send = () =>
    window.dispatchEvent(new CustomEvent("sshcode-quest", { detail: { type: "send" } }));
  send();
  await act(async () => root.render(<Composer send={second} />));
  send();
  expect(first).toHaveBeenCalledTimes(1);
  expect(second).toHaveBeenCalledTimes(1);
  await act(async () => root.render(null));
  send();
  expect(second).toHaveBeenCalledTimes(1);
});
