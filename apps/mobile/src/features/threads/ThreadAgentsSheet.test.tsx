// @vitest-environment jsdom
import type {
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act, type ReactNode, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  focused: true,
  appState: "active",
  connectionState: "connected" as "connected" | "reconnecting",
  focusListeners: new Set<() => void>(),
  appListeners: new Set<(state: string) => void>(),
  subagents: [] as OrchestrationV2Subagent[],
  heldTasks: [] as OrchestrationV2PendingBackgroundTask[],
  dispatch: vi.fn(),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "shell"
      ? { pendingBackgroundTasks: harness.heldTasks, lineage: { rootThreadId: "thread" } }
      : { subagents: harness.subagents, liveCount: harness.subagents.length },
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: harness.dispatch }),
  StackActions: { replace: (name: string, params: unknown) => ({ type: "REPLACE", name, params }) },
  useIsFocused: () =>
    useSyncExternalStore(
      (listener) => {
        harness.focusListeners.add(listener);
        return () => harness.focusListeners.delete(listener);
      },
      () => harness.focused,
    ),
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children, onPress }: { children: ReactNode; onPress: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
  AppState: {
    get currentState() {
      return harness.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      harness.appListeners.add(listener);
      return { remove: () => harness.appListeners.delete(listener) };
    },
  },
}));
vi.mock("react-native-screens", () => ({
  Screen: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScreenStack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScreenStackHeaderConfig: () => null,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => ({ connectionState: harness.connectionState }),
}));
vi.mock("../discord/useUiMode", () => ({ useUiMode: () => ["default", () => {}] }));
vi.mock("../discord/DiscordMembers", () => ({
  DiscordMainMembers: () => null,
  DiscordMember: () => null,
}));
vi.mock("../../components/AndroidScreenHeader", () => ({ AndroidSheetHeader: () => null }));
// Thumbs load native symbols and server state; this sheet test covers rows and navigation.
vi.mock("./SubagentGradeBadge", () => ({ SubagentGradeBadge: () => null }));
// The board chip reads state that opens native storage; these rows have no team board.
vi.mock("./TeamBoardPresenceChip", () => ({ TeamBoardPresenceChip: () => null }));
// The form and footer have their own inputs and native keyboard state; the sheet places them.
vi.mock("./NewSubagentForm", () => ({
  AgentsFooter: ({ onNewSubagent }: { onNewSubagent: () => void }) => (
    <button aria-label="New subagent" onClick={onNewSubagent} />
  ),
  NewSubagentForm: () => <textarea aria-label="Task" />,
}));
vi.mock("react-native-keyboard-controller", () => ({ KeyboardAvoidingView: "div" }));
vi.mock("react-native-reanimated", () => {
  const transition = {
    duration: () => transition,
    easing: () => transition,
    reduceMotion: () => transition,
  };
  return {
    default: { View: ({ children }: { children: ReactNode }) => <div>{children}</div> },
    Easing: { cubic: (t: number) => t, out: (fn: (t: number) => number) => fn },
    FadeIn: transition,
    FadeOut: transition,
    ReduceMotion: { System: "system" },
  };
});
vi.mock("./SubagentStopButton", () => ({ SubagentStopButton: () => null }));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../lib/useUniwindTheme", () => ({ useUniwindTheme: () => ({}) }));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { turnSubagentsAtom: () => null },
  environmentThreadShells: { threadShellAtom: () => "shell" },
  useThreadFamily: () => undefined,
}));
vi.mock("../../native/StackHeader", () => ({
  NativeStackScreenOptions: () => null,
  nativeHeaderScrollEdgeEffects: () => ({}),
}));
vi.mock("./HeldBackgroundWork", () => ({
  HeldBackgroundWorkRow: ({ item }: { item: { label: string } }) => <span>Held: {item.label}</span>,
}));
vi.mock("./SubagentRow", () => ({
  SubagentRow: ({ elapsed }: { elapsed: ReactNode }) => <div>{elapsed}</div>,
}));
vi.mock("../../components/MaterialScreenContent", () => ({ MaterialScreenContent: "div" }));
vi.mock("./ThreadMonitors", () => ({ ThreadMonitorRows: () => null, useThreadMonitors: () => [] }));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: {} }),
}));

import { ThreadAgentsSheet } from "./ThreadAgentsSheet";

const START = Date.UTC(2026, 9, 16, 12);
let root: Root;
let host: HTMLDivElement;
function mount() {
  host = document.createElement("div");
  root = createRoot(host);
  act(() =>
    root.render(
      <ThreadAgentsSheet
        route={{
          params: {
            environmentId: EnvironmentId.make("environment"),
            threadId: ThreadId.make("thread"),
          },
        }}
      />,
    ),
  );
}
function appState(state: string) {
  act(() => {
    harness.appState = state;
    harness.appListeners.forEach((listener) => listener(state));
  });
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.setSystemTime(START);
  harness.focused = true;
  harness.appState = "active";
  harness.connectionState = "connected";
  harness.heldTasks = [];
  harness.dispatch.mockClear();
  harness.subagents = [
    {
      id: NodeId.make("agent"),
      threadId: ThreadId.make("thread"),
      runId: null,
      parentNodeId: NodeId.make("parent"),
      origin: "provider_native",
      createdBy: "agent",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Check thread timers",
      title: null,
      model: null,
      result: null,
      status: "running",
      startedAt: DateTime.makeUnsafe(START - 10_000),
      completedAt: null,
      updatedAt: DateTime.makeUnsafe(START),
    },
  ];
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

it("suspends every agent timer in the background and catches up immediately on foreground", () => {
  mount();
  expect(host.textContent).toBe("10s");
  appState("background");
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(300_000));
  expect(host.textContent).toBe("10s");
  appState("active");
  expect(host.textContent).toBe("5m 10s");
  expect(vi.getTimerCount()).toBe(1);
});

it("stops ticking when another route covers the sheet", () => {
  mount();
  act(() => {
    harness.focused = false;
    harness.focusListeners.forEach((listener) => listener());
  });
  expect(vi.getTimerCount()).toBe(0);
  act(() => vi.advanceTimersByTime(120_000));
  act(() => {
    harness.focused = true;
    harness.focusListeners.forEach((listener) => listener());
  });
  expect(host.textContent).toBe("2m 10s");
});

it("stops cached agent timers while the environment reconnects", () => {
  harness.connectionState = "reconnecting";
  mount();
  expect(host.textContent).toBe("");
  expect(vi.getTimerCount()).toBe(0);
});

it("replaces a held child's working timer with its held message", () => {
  const childThreadId = ThreadId.make("held-child");
  harness.subagents = harness.subagents.map((agent) => ({
    ...agent,
    id: NodeId.make("node:delegated-task:send"),
    childThreadId,
  }));
  harness.heldTasks = [
    {
      taskId: "turn-item:delegated-task:send",
      kind: "subagent",
      description: "Discord levels",
      childThreadId,
      held: { runId: RunId.make("queued"), since: "2026-10-27T12:00:00.000Z" },
    },
  ];
  mount();
  expect(host.textContent).toBe("Held: Discord levels");
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps another task in the same child visible while a send is held", () => {
  const agent = harness.subagents[0]!;
  const childThreadId = ThreadId.make("shared-child");
  harness.subagents = [
    { ...agent, id: NodeId.make("node:delegated-task:send"), childThreadId },
    { ...agent, id: NodeId.make("node:delegated-task:working"), childThreadId },
  ];
  harness.heldTasks = [
    {
      taskId: "turn-item:delegated-task:send",
      kind: "subagent",
      description: "Discord levels",
      childThreadId,
      held: { runId: RunId.make("queued"), since: "2026-10-27T12:00:00.000Z" },
    },
  ];
  mount();
  expect(host.textContent).toBe("Held: Discord levels10s");
  expect(vi.getTimerCount()).toBe(1);
});

it("opens a remote subagent in its own environment", () => {
  harness.subagents = harness.subagents.map((agent) => ({
    ...agent,
    origin: "app_owned",
    childThreadId: ThreadId.make("studio-child"),
    remote: { environmentId: EnvironmentId.make("studio") },
  }));
  mount();
  act(() => host.querySelector("button")!.click());
  expect(harness.dispatch).toHaveBeenCalledWith({
    type: "REPLACE",
    name: "Thread",
    params: { environmentId: "studio", threadId: "studio-child" },
  });
});

it("opens a completed delegated chat using its turn card before any child shell is loaded", () => {
  harness.subagents = [
    {
      ...harness.subagents[0]!,
      origin: "app_owned",
      title: "Finished delegated task",
      childThreadId: ThreadId.make("idle-delegated-child"),
      status: "completed",
      completedAt: DateTime.makeUnsafe(START),
    },
  ];
  mount();
  act(() => host.querySelector("button")?.click());
  expect(harness.dispatch).toHaveBeenCalledWith({
    type: "REPLACE",
    name: "Thread",
    params: { environmentId: "environment", threadId: "idle-delegated-child" },
  });
});

it("leaves the old task behind when navigation changes the sheet's chat", () => {
  mount();
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="New subagent"]')!.click());
  host.querySelector("textarea")!.value = "First chat's task";
  act(() =>
    root.render(
      <ThreadAgentsSheet
        route={{
          params: {
            environmentId: EnvironmentId.make("environment"),
            threadId: ThreadId.make("another"),
          },
        }}
      />,
    ),
  );
  expect(host.querySelector("textarea")).toBeNull();
});
