// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, SideChatId, ThreadId, type SideChatState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  listeners: new Set<(state: string) => void>(),
  targets: [] as Array<unknown>,
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_event: string, listener: (state: string) => void) => {
      harness.listeners.add(listener);
      return { remove: () => harness.listeners.delete(listener) };
    },
  },
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    sideChatState: (target: unknown) => {
      harness.targets.push(target);
      return stateAtom;
    },
  },
}));

import { useThreadSideChat } from "./useThreadSideChat";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("thread");
let stateAtom: Atom.Atom<AsyncResult.AsyncResult<SideChatState | null>>;
let serverState: SideChatState;
let observed: SideChatState | null;
let acquisitions: number;
let registry: AtomRegistry.AtomRegistry;
let root: Root | null;

function Probe() {
  const result = useThreadSideChat(environmentId, threadId);
  useEffect(() => {
    observed = Option.getOrNull(AsyncResult.value(result));
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
  harness.listeners.clear();
  harness.targets = [];
  acquisitions = 0;
  observed = null;
  serverState = {
    sideChatId: SideChatId.make("side"),
    threadId,
    kind: "side",
    status: "running",
    error: null,
    messages: [
      { id: "question", role: "user", text: "question", status: "complete", activities: [] },
      { id: "answer", role: "assistant", text: "partial", status: "streaming", activities: [] },
    ],
  };
  stateAtom = Atom.make(() => {
    acquisitions++;
    return AsyncResult.success(serverState);
  }).pipe(Atom.setIdleTTL(0));
  registry = AtomRegistry.make();
});
afterEach(() => {
  act(() => root?.unmount());
  registry.dispose();
  root = null;
});

it("refreshes on foreground, replaces the partial answer, and restores it after the sheet remounts", () => {
  mount();
  expect(observed?.status).toBe("running");
  act(() => harness.listeners.forEach((listener) => listener("background")));
  serverState = {
    ...serverState,
    status: "idle",
    messages: [
      serverState.messages[0]!,
      { ...serverState.messages[1]!, text: "complete answer", status: "complete" },
    ],
  };
  expect(observed?.messages.at(-1)?.text).toBe("partial");
  act(() => harness.listeners.forEach((listener) => listener("active")));
  expect(acquisitions).toBe(2);
  expect(observed).toEqual(serverState);
  act(() => root!.unmount());
  expect(harness.listeners.size).toBe(0);
  mount();
  expect(observed).toEqual(serverState);
  expect(observed?.messages.map((message) => message.id)).toEqual(["question", "answer"]);
  expect(
    harness.targets.every(
      (target) => JSON.stringify(target) === JSON.stringify({ environmentId, input: { threadId } }),
    ),
  ).toBe(true);
});
