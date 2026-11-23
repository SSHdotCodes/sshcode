// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, SideChatId, ThreadId, type SideChatState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  calls: [] as Array<{ input: { messageId: string } }>,
  resolve: null as ((result: unknown) => void) | null,
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { sideChatState: () => stateAtom, openSideChat: "open" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => (target: { input: { messageId: string } }) =>
    new Promise((resolve) => {
      harness.calls.push(target);
      harness.resolve = resolve;
    }),
}));
vi.mock("../ChatMarkdown", () => ({ default: () => null }));

import { useSideChat } from "./SideChatPanel";

const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
let stateAtom: Atom.Writable<AsyncResult.AsyncResult<SideChatState | null>>;
let registry: AtomRegistry.AtomRegistry;
let root: Root | null;
let current: ReturnType<typeof useSideChat>;
const complete: SideChatState = {
  sideChatId: SideChatId.make("side"),
  threadId: threadRef.threadId,
  kind: "btw",
  status: "idle",
  error: null,
  messages: [
    { id: "question", role: "user", text: "question", status: "complete", activities: [] },
    {
      id: "answer",
      role: "assistant",
      text: "complete answer",
      status: "complete",
      activities: [],
    },
  ],
};
function Probe() {
  const result = useSideChat(threadRef);
  useEffect(() => {
    current = result;
  }, [result]);
  return null;
}
function mount() {
  root = createRoot(document.createElement("div"));
  act(() =>
    root!.render(
      <RegistryContext.Provider value={registry}>
        <Probe />
      </RegistryContext.Provider>,
    ),
  );
}
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.calls = [];
  harness.resolve = null;
  registry = AtomRegistry.make();
  stateAtom = Atom.make<AsyncResult.AsyncResult<SideChatState | null>>(AsyncResult.success(null));
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  registry.dispose();
});

it("recovers a live exchange after reload without opening it", () => {
  registry.set(stateAtom, AsyncResult.success(complete));
  mount();
  expect(current.session?.opened).toEqual(complete);
  expect(current.isOpen).toBe(false);
  expect(current.busy).toBe(false);
  act(() => current.setOpen(true));
  expect(current.isOpen).toBe(true);
  expect(current.session?.opened).toEqual(complete);
  act(() => current.setOpen(false));
  act(() => root!.unmount());
  mount();
  expect(current.session?.opened).toEqual(complete);
  expect(harness.calls).toHaveLength(0);
});

it("never brings a closed side chat back, and starts fresh from the control", () => {
  registry.set(stateAtom, AsyncResult.success({ ...complete, status: "closed" }));
  mount();
  act(() => current.setOpen(true));
  expect(current.isOpen).toBe(true);
  expect(current.session).toBeNull();
  act(() => {
    void current.open({
      environmentId: threadRef.environmentId,
      threadRef,
      kind: "btw",
      prompt: "another question",
    });
  });
  expect(current.isOpen).toBe(true);
  expect(current.busy).toBe(true);
  expect(current.session?.question).toBe("another question");
});

it("opens when a question is sent and closes the popover on request", () => {
  mount();
  expect(current.isOpen).toBe(false);
  act(() => {
    void current.open({
      environmentId: threadRef.environmentId,
      threadRef,
      kind: "btw",
      prompt: "question",
    });
  });
  expect(current.isOpen).toBe(true);
  act(() => current.setOpen(false));
  expect(current.isOpen).toBe(false);
  // The question is still in flight, so it stays for the next opening.
  expect(current.session?.question).toBe("question");
});

it("lets recovered snapshots win over a lost open acknowledgement and never resurrects an expired optimistic state", async () => {
  mount();
  let opening: Promise<void>;
  act(() => {
    opening = current.open({
      environmentId: threadRef.environmentId,
      threadRef,
      kind: "btw",
      prompt: "question",
    });
  });
  const accepted: SideChatState = {
    ...complete,
    messages: [
      { ...complete.messages[0]!, id: harness.calls[0]!.input.messageId },
      complete.messages[1]!,
    ],
  };
  act(() => registry.set(stateAtom, AsyncResult.success(accepted)));
  expect(current.session?.opened).toEqual(accepted);
  await act(async () => {
    harness.resolve!(AsyncResult.failure(Cause.die(new Error("socket closed"))));
    await opening!;
  });
  expect(current.session?.opened).toEqual(accepted);
  expect(current.session?.error).toBeNull();
  act(() => registry.set(stateAtom, AsyncResult.success(null)));
  expect(current.session).toBeNull();
});

it("opens ready for a question about selected text and forgets the text when closed", () => {
  mount();
  act(() => current.askAbout("selected words"));
  expect(current.isOpen).toBe(true);
  expect(current.quote).toBe("selected words");
  act(() => current.setOpen(false));
  expect(current.quote).toBeNull();
});
