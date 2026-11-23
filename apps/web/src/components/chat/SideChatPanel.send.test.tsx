// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import { EnvironmentId, SideChatId, ThreadId, type SideChatState } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  calls: [] as Array<{ input: { messageId: string; prompt: string } }>,
  resolve: [] as Array<(result: unknown) => void>,
}));
vi.mock("~/state/server", () => ({
  serverEnvironment: { sideChatState: () => stateAtom, sendSideChat: "send" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: () => (target: { input: { messageId: string; prompt: string } }) =>
    new Promise((resolve) => {
      harness.calls.push(target);
      harness.resolve.push(resolve);
    }),
}));
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));
import { SideChatPanel, type SideChatSession } from "./SideChatPanel";
import { Popover } from "../ui/popover";

const complete: SideChatState = {
  sideChatId: SideChatId.make("side"),
  threadId: ThreadId.make("thread"),
  kind: "btw",
  status: "idle",
  error: null,
  messages: [
    { id: "question", role: "user", text: "question", status: "complete", activities: [] },
  ],
};
const session: SideChatSession = {
  key: "session",
  threadKey: "thread",
  environmentId: EnvironmentId.make("env"),
  threadRef: { environmentId: EnvironmentId.make("env"), threadId: complete.threadId },
  kind: "btw",
  question: "question",
  opened: complete,
  error: null,
};
let registry: AtomRegistry.AtomRegistry;
let stateAtom: Atom.Writable<AsyncResult.AsyncResult<SideChatState | null>>;
let root: Root;
let container: HTMLDivElement;
function input() {
  return container.querySelector("input")!;
}
function draft(value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function enter() {
  input().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
}
function acknowledge(index: number) {
  const call = harness.calls[index]!;
  act(() =>
    registry.set(
      stateAtom,
      AsyncResult.success({
        ...complete,
        messages: [
          ...complete.messages,
          {
            id: call.input.messageId,
            role: "user",
            text: call.input.prompt,
            status: "complete",
            activities: [],
          },
        ],
      }),
    ),
  );
}
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.calls = [];
  harness.resolve = [];
  registry = AtomRegistry.make();
  stateAtom = Atom.make<AsyncResult.AsyncResult<SideChatState | null>>(AsyncResult.success(null));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Popover open>
          <SideChatPanel session={session} kind="btw" cwd="/repo" onStart={() => {}} />
        </Popover>
      </RegistryContext.Provider>,
    ),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  vi.unstubAllGlobals();
});

it("clears a successfully sent draft including surrounding whitespace", async () => {
  draft("  follow up  ");
  act(enter);
  expect(harness.calls[0]!.input.prompt).toBe("follow up");
  await act(async () => harness.resolve[0]!(AsyncResult.success(undefined)));
  expect(input().value).toBe("");
});

it("clears a whitespace-padded draft when the live snapshot acknowledges it", () => {
  draft("  follow up  ");
  act(enter);
  acknowledge(0);
  expect(input().value).toBe("");
});

it("sends only once for two enter events before React renders", () => {
  draft("follow up");
  act(() => {
    enter();
    enter();
  });
  expect(harness.calls).toHaveLength(1);
});

it("ignores an old RPC completion once the live reply lets the next question send", async () => {
  draft("first");
  act(enter);
  acknowledge(0);
  draft("second");
  act(enter);
  expect(input().disabled).toBe(true);
  await act(async () => harness.resolve[0]!(AsyncResult.success(undefined)));
  expect(input().disabled).toBe(true);
  await act(async () =>
    harness.resolve[1]!(AsyncResult.failure(Cause.die(new Error("connection lost")))),
  );
  expect(input().value).toBe("second");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("connection lost");
  act(enter);
  expect(harness.calls[2]!.input.messageId).toBe(harness.calls[1]!.input.messageId);
});

it("ignores a cached snapshot belonging to the previous side chat", () => {
  act(() =>
    registry.set(
      stateAtom,
      AsyncResult.success({
        ...complete,
        sideChatId: SideChatId.make("previous-side"),
        status: "running",
        messages: [
          {
            id: "old-question",
            role: "user",
            text: "Previous question",
            status: "complete",
            activities: [],
          },
        ],
      }),
    ),
  );
  expect(container.textContent).not.toContain("Previous question");
  expect(container.textContent).toContain("question");
  expect(input().disabled).toBe(false);
});

it("lets the user start another question after the side answer fails", () => {
  const start = vi.fn();
  act(() =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Popover open>
          <SideChatPanel session={session} kind="btw" cwd="/repo" onStart={start} />
        </Popover>
      </RegistryContext.Provider>,
    ),
  );
  act(() =>
    registry.set(
      stateAtom,
      AsyncResult.success({ ...complete, status: "failed", error: "The side answer timed out." }),
    ),
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("The side answer timed out.");
  expect(input().disabled).toBe(false);
  draft("try again");
  act(enter);
  expect(start).toHaveBeenCalledWith("try again");
  expect(harness.calls).toHaveLength(0);
});

it("sends a question about selected text with its quote, then drops the quote", async () => {
  const clearQuote = vi.fn();
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <Popover open>
          <SideChatPanel
            session={session}
            kind="btw"
            cwd="/repo"
            onStart={() => {}}
            quote="the selected part"
            onClearQuote={clearQuote}
          />
        </Popover>
      </RegistryContext.Provider>,
    ),
  );
  expect(container.textContent).toContain("the selected part");
  expect(input().placeholder).toBe("Ask about the selection");
  draft("why?");
  act(enter);
  expect(harness.calls[0]!.input.prompt).toBe(
    "About this part of your answer:\n> the selected part\n\nwhy?",
  );
  expect(clearQuote).not.toHaveBeenCalled();
  await act(async () => harness.resolve[0]!(AsyncResult.success(undefined)));
  expect(clearQuote).toHaveBeenCalledTimes(1);
});
