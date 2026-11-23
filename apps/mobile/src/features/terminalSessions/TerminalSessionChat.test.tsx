// @vitest-environment jsdom
import { act, useSyncExternalStore, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import {
  initialClaudeRcState,
  reduceClaudeRcEvent,
  type ClaudeRcState,
} from "@t3tools/client-runtime/claude-rc";
import type { ClaudeRcCommand, ClaudeRcEvent } from "@t3tools/contracts";

const fixture = vi.hoisted(() => ({
  state: null as ClaudeRcState | null,
  listeners: new Set<() => void>(),
  commands: [] as ClaudeRcCommand[],
  allowed: true,
  error: null as string | null,
  goBack: vi.fn(),
  setOptions: vi.fn(),
  changeText: (_text: string) => {},
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ goBack: fixture.goBack, setOptions: fixture.setOptions }),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "configs"
      ? new Map([
          [
            "mac",
            { environment: { label: "Fixture Mac", capabilities: { claudeRemoteControl: true } } },
          ],
        ])
      : fixture.allowed,
}));
vi.mock("../../state/server", () => ({ environmentServerConfigsAtom: "configs" }));
vi.mock("../../state/environment-labels", () => ({
  useEnvironmentDisplayLabels: () => new Map(),
  useEnvironmentDisplayLabel: () => null,
}));
vi.mock("../../state/presentation", () => ({
  useEnvironmentPresentation: () => ({ presentation: { connection: { phase: "connected" } } }),
}));
vi.mock("../../state/claudeRc", () => ({
  claudeRcEnvironment: {
    sessions: () => "sessions",
    watch: () => "watch",
    command: { permissionAtom: () => "permission" },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: string) => {
    const state = useSyncExternalStore(
      (listener) => {
        fixture.listeners.add(listener);
        return () => {
          fixture.listeners.delete(listener);
        };
      },
      () => fixture.state,
    );
    return {
      data:
        atom === "sessions"
          ? [{ id: "cse_fixture", title: "Review the login", working: false, updatedAt: "" }]
          : state,
      error: null,
      refresh: vi.fn(),
    };
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => async (command: { input: ClaudeRcCommand }) => {
    fixture.commands.push(command.input);
    return fixture.error
      ? { _tag: "Failure", cause: Cause.fail(new Error(fixture.error)) }
      : { _tag: "Success", value: undefined };
  },
}));
vi.mock("react-native", () => ({
  Linking: { openURL: vi.fn() },
  useWindowDimensions: () => ({ width: 400, height: 800, fontScale: 1 }),
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityState,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityState?: { expanded?: boolean };
  }) => (
    <button aria-expanded={accessibilityState?.expanded} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/MaterialButton", () => ({
  MaterialButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../../components/ComposerToolbar", () => ({
  ComposerActionButton: ({
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    accessibilityLabel: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {accessibilityLabel}
    </button>
  ),
}));
vi.mock("../../native/T3ComposerEditor", () => ({
  ComposerEditor: ({
    value,
    onChangeText,
  }: {
    value: string;
    onChangeText: (text: string) => void;
  }) => {
    fixture.changeText = onChangeText;
    return <textarea value={value} readOnly />;
  },
}));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: ({ markdown }: { markdown: string }) => <p>{markdown}</p>,
}));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));

vi.mock("../../lib/useUniwindTheme", () => ({
  useUniwindTheme: () => ({ "--color-icon-subtle": "#888" }),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => ({ appearance: { baseFontSize: 14 }, themeAppearance: "dark" }),
}));
vi.mock("../threads/thread-work-log", () => ({
  ThreadDisclosureChevron: () => null,
  WorkLogIcon: () => null,
  workRowSymbolName: (icon: string) => icon,
  ThreadWorkGroupToggle: (props: { summary: string; expanded: boolean; onToggle: () => void }) => (
    <button aria-expanded={props.expanded} onClick={props.onToggle}>
      {props.summary}
    </button>
  ),
}));
vi.mock("../threads/work-log-layout", () => ({
  WorkLogBlock: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WorkLogRows: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  WorkLogIconSlot: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  WorkLogLabel: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  WorkLogPressable: (props: {
    children: ReactNode;
    onPress: () => void;
    accessibilityState?: { expanded?: boolean };
  }) => (
    <button aria-expanded={props.accessibilityState?.expanded} onClick={props.onPress}>
      {props.children}
    </button>
  ),
}));

import { TerminalSessionRouteScreen } from "./TerminalSessionRouteScreen";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  fixture.state = {
    ...initialClaudeRcState,
    phase: "connected",
    working: true,
    items: [
      { id: "u", role: "user", text: "Check the login" },
      {
        id: "t1",
        role: "tool",
        text: "",
        tool: { name: "Bash", input: { command: "ls" }, output: "private details", done: true },
      },
      {
        id: "t2",
        role: "tool",
        text: "",
        tool: { name: "Read", input: { file_path: "/Users/me/a.ts" }, output: "x", done: true },
      },
      { id: "a", role: "assistant", text: "History from the CLI" },
    ],
    permissions: [{ requestId: "req_1", toolName: "Bash", description: "Run tests" }],
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  fixture.commands = [];
  fixture.error = null;
  fixture.allowed = true;
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <TerminalSessionRouteScreen
        route={{
          params: { environmentId: "mac", sessionId: "cse_fixture" },
        }}
      />,
    ),
  );
}
function button(label: string) {
  return [...host.querySelectorAll("button")].find((item) => item.textContent === label)!;
}
async function event(event: ClaudeRcEvent) {
  await act(async () => {
    fixture.state = reduceClaudeRcEvent(fixture.state!, event);
    for (const notify of fixture.listeners) notify();
  });
}

it("opens as a native screen with a thread-style header, history, live text and folded tool details", async () => {
  await render();
  expect(fixture.setOptions).toHaveBeenCalledWith({
    title: "Review the login",
    headerSubtitle: "Terminal session · Fixture Mac",
  });
  expect(host.textContent).toContain("History from the CLI");
  expect(host.textContent).not.toContain("private details");
  const summary = "Ran 1 command and read 1 file";
  expect(host.textContent).not.toContain("Read ~/a.ts");
  await act(async () => button(summary).click());
  await act(async () => button("ls").click());
  expect(host.textContent).toContain("private details");
  await event({ type: "textDelta", id: "a", text: " live" });
  expect(host.textContent).toContain("History from the CLI live");
  expect([...host.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
    summary,
    "ls",
    "Read ~/a.ts",
    "Allow",
    "Deny",
    "Stop",
    "Send",
  ]);
});

it("sends text, interrupts, answers permissions and keeps failed drafts", async () => {
  await render();
  act(() => fixture.changeText("hello"));
  await act(async () => button("Send").click());
  expect(host.querySelector("textarea")?.value).toBe("");
  await act(async () => button("Stop").click());
  await act(async () => button("Allow").click());
  await act(async () => button("Deny").click());
  expect(fixture.commands).toEqual([
    { action: "send", sessionId: "cse_fixture", text: "hello" },
    { action: "interrupt", sessionId: "cse_fixture" },
    { action: "permission", sessionId: "cse_fixture", requestId: "req_1", allow: true },
    { action: "permission", sessionId: "cse_fixture", requestId: "req_1", allow: false },
  ]);
  fixture.error = "offline";
  act(() => fixture.changeText("keep me"));
  await act(async () => button("Send").click());
  expect(host.querySelector("textarea")?.value).toBe("keep me");
  expect(host.textContent).toContain("offline");
});

it("shows terminal-only notices and disconnected state with a way back", async () => {
  await render();
  await event({
    type: "item",
    item: { id: "n", role: "notice", text: "Answer this in the terminal" },
  });
  await event({ type: "status", phase: "disconnected", working: false });
  expect(host.textContent).toContain("Answer this in the terminal");
  expect(host.textContent).toContain("Disconnected.");
  expect(button("Send").disabled).toBe(true);
  await act(async () => button("Back to Terminal sessions").click());
  expect(fixture.goBack).toHaveBeenCalledOnce();
});
