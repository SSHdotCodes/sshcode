// @vitest-environment jsdom
import {
  CommandId,
  EnvironmentId,
  SideChatId,
  ThreadId,
  type SideChatState,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { RegistryContext } from "@effect/atom-react";
import type { PendingSend } from "../../state/pending-send-model";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  state: null as SideChatState | null,
  enqueue: vi.fn(),
  changeDraft: (_text: string) => {},
  pressSend: () => {},
  nextId: 0,
}));
vi.mock("@react-navigation/native", () => ({ useNavigation: () => ({ goBack: vi.fn() }) }));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0 }),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  HarnessThemeScope: ({ children }: { children: ReactNode }) => children,
  useAppearancePreferences: () => ({}),
}));
vi.mock("../settings/appearance/useHarnessProseStyle", () => ({
  useHarnessProseStyle: () => ({}),
}));
vi.mock("../../lib/harnessThemes", () => ({ resolveMobileHarnessDriver: () => "codex" }));
vi.mock("../../state/use-thread-selection", () => ({ useThreadSelection: () => ({}) }));
vi.mock("../../state/use-remote-environment-registry", () => ({
  useRemoteEnvironmentRuntime: () => null,
}));
vi.mock("../../components/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  AppTextInput: (props: { value: string; onChangeText: (text: string) => void }) => {
    harness.changeDraft = props.onChangeText;
    return <textarea value={props.value} readOnly />;
  },
}));
vi.mock("../../components/ControlPill", () => ({
  ControlPill: (props: { disabled: boolean; onPress: () => void }) => {
    harness.pressSend = props.onPress;
    return (
      <button aria-label="Send" disabled={props.disabled} onClick={props.onPress}>
        Send
      </button>
    );
  },
}));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: ({ markdown }: { markdown: string }) => <p>{markdown}</p>,
}));
vi.mock("../../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => vi.fn() }));
vi.mock("../../lib/uuid", () => ({ uuidv4: () => `message-${++harness.nextId}` }));
vi.mock("./useThreadSideChat", () => ({
  useThreadSideChat: () => AsyncResult.success(harness.state),
}));
vi.mock("../../state/pending-sends", async () => {
  const { appAtomRegistry } = await import("../../state/atom-registry");
  const sendsAtom = Atom.make<ReadonlyArray<PendingSend>>([]).pipe(Atom.keepAlive);
  return {
    pendingSends: {
      sendsAtom,
      awaitingAckAtom: sendsAtom,
      enqueue: (send: PendingSend) => harness.enqueue(send),
      acknowledge: (send: PendingSend) =>
        appAtomRegistry.set(
          sendsAtom,
          appAtomRegistry.get(sendsAtom).filter((item) => item.id !== send.id),
        ),
      retry: async (send: PendingSend) => {
        const { error: _, ...pending } = send;
        appAtomRegistry.set(sendsAtom, [pending]);
      },
    },
    acknowledgedSideChatsAtom: Atom.make<Record<string, SideChatState>>({}).pipe(Atom.keepAlive),
    pendingSendMetadata: () => ({
      id: `message-${++harness.nextId}`,
      createdAt: "2026-10-20T12:00:00.000Z",
    }),
  };
});
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));

import { ThreadSideChatSheet } from "./ThreadSideChatSheet";
import { appAtomRegistry } from "../../state/atom-registry";
import { acknowledgedSideChatsAtom, pendingSends } from "../../state/pending-sends";

const threadId = ThreadId.make("thread");
const initialState: SideChatState = {
  sideChatId: SideChatId.make("side"),
  threadId,
  kind: "side",
  status: "idle",
  error: null,
  messages: [],
};
let host: HTMLDivElement;
let root: Root;
function render() {
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ThreadSideChatSheet
          route={{ params: { environmentId: "environment", threadId, kind: "side" } }}
        />
      </RegistryContext.Provider>,
    ),
  );
}
function type(text: string) {
  act(() => harness.changeDraft(text));
}
function send() {
  act(() => host.querySelector<HTMLButtonElement>("[aria-label=Send]")!.click());
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.state = initialState;
  appAtomRegistry.set(pendingSends.sendsAtom, []);
  appAtomRegistry.set(acknowledgedSideChatsAtom, {});
  harness.enqueue.mockReset();
  harness.enqueue.mockImplementation(async (send: PendingSend) => {
    appAtomRegistry.set(pendingSends.sendsAtom, [send]);
    return send;
  });
  harness.nextId = 0;
  host = document.createElement("div");
  root = createRoot(host);
  render();
});
afterEach(() => act(() => root.unmount()));

it("admits only one question while saving and clears its input only after it is durable", async () => {
  const saving = deferred<PendingSend>();
  harness.enqueue.mockReturnValueOnce(saving.promise);
  type("one question");
  act(() => {
    harness.pressSend();
    harness.pressSend();
  });
  expect(harness.enqueue).toHaveBeenCalledOnce();
  expect(host.querySelector("textarea")?.value).toBe("one question");
  const send = harness.enqueue.mock.calls[0]![0] as PendingSend;
  await act(async () => {
    appAtomRegistry.set(pendingSends.sendsAtom, [send]);
    saving.resolve(send);
  });
  expect(host.querySelector("textarea")?.value).toBe("");
  expect(host.textContent).toContain("one question");
  expect(host.textContent).toContain("Waiting for network");
  expect(host.querySelector<HTMLButtonElement>("[aria-label=Send]")!.disabled).toBe(true);
});

it("keeps the text editable if the pending question cannot be saved", async () => {
  harness.enqueue.mockRejectedValueOnce(new Error("disk full"));
  type("keep my text");
  await act(async () => send());
  expect(host.querySelector("textarea")?.value).toBe("keep my text");
  expect(host.textContent).toContain("Could not save");
  expect(host.querySelector<HTMLButtonElement>("[aria-label=Send]")!.disabled).toBe(false);
});

it("restores an offline pending question when the sheet reopens, then replaces it with the server answer", async () => {
  const pending: PendingSend = {
    id: CommandId.make("stable-id"),
    kind: "side-question",
    prompt: "saved offline question",
    environmentId: EnvironmentId.make("environment"),
    threadId,
    createdAt: "2026-10-20T12:00:00.000Z",
  };
  await act(async () => appAtomRegistry.set(pendingSends.sendsAtom, [pending]));
  act(() => root.unmount());
  root = createRoot(host);
  render();
  expect(host.textContent).toContain("saved offline question");
  expect(host.textContent).toContain("Waiting for network");
  harness.state = {
    ...initialState,
    messages: [
      { id: pending.id, role: "user", text: pending.prompt, status: "complete", activities: [] },
      { id: "answer", role: "assistant", text: "It arrived", status: "complete", activities: [] },
    ],
  };
  await act(async () => render());
  expect(host.textContent).toContain("It arrived");
  expect(host.textContent).not.toContain("Waiting for network");
  expect(appAtomRegistry.get(pendingSends.sendsAtom)).toEqual([]);
});

it("shows an accepted response before the subscription catches up", async () => {
  harness.state = null;
  const accepted: SideChatState = {
    ...initialState,
    status: "running",
    messages: [{ id: "accepted", role: "user", text: "first", status: "complete", activities: [] }],
  };
  await act(async () =>
    appAtomRegistry.set(acknowledgedSideChatsAtom, { "environment:thread": accepted }),
  );
  expect(host.textContent).toContain("first");
  expect(host.textContent).toContain("Working…");
  harness.state = {
    ...accepted,
    status: "idle",
    messages: [
      ...accepted.messages,
      {
        id: "answer",
        role: "assistant",
        text: "complete answer",
        status: "complete",
        activities: [],
      },
    ],
  };
  await act(async () => render());
  expect(host.textContent).toContain("complete answer");
  expect(host.textContent).not.toContain("Working…");
});

it("keeps a permanent send failure visible and retries with the same saved id", async () => {
  const failed: PendingSend = {
    id: CommandId.make("saved-id"),
    kind: "side-question",
    prompt: "please answer",
    environmentId: EnvironmentId.make("environment"),
    threadId,
    createdAt: "2026-10-20T12:00:00.000Z",
    error: "Side chat is unavailable",
  };
  await act(async () => appAtomRegistry.set(pendingSends.sendsAtom, [failed]));
  expect(host.textContent).toContain("Side chat is unavailable");
  await act(async () =>
    host.querySelector<HTMLButtonElement>("[aria-label='Retry side question']")!.click(),
  );
  expect(appAtomRegistry.get(pendingSends.sendsAtom)[0]).toMatchObject({
    id: failed.id,
    prompt: failed.prompt,
  });
  expect(appAtomRegistry.get(pendingSends.sendsAtom)[0]?.error).toBeUndefined();
  expect(host.textContent).toContain("Waiting for network");
});

it("replaces a stale Working state with a provider failure and lets the user ask again", async () => {
  harness.state = {
    ...initialState,
    status: "running",
    messages: [
      { id: "old-question", role: "user", text: "question", status: "complete", activities: [] },
      { id: "answer", role: "assistant", text: "", status: "streaming", activities: [] },
    ],
  };
  render();
  expect(host.textContent).toContain("Working…");
  harness.state = {
    ...harness.state,
    status: "failed",
    error: "The side answer timed out.",
    messages: [harness.state.messages[0]!, { ...harness.state.messages[1]!, status: "failed" }],
  };
  render();
  expect(host.textContent).not.toContain("Working…");
  await act(async () =>
    host.querySelector<HTMLButtonElement>("[aria-label='Retry side question']")!.click(),
  );
  expect(harness.enqueue).toHaveBeenCalledWith(
    expect.objectContaining({
      prompt: "question",
      kind: "side-question",
      id: expect.not.stringMatching(/^old-question$/),
    }),
  );
});
