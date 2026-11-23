// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import {
  modelManagerTestProjection,
  modelManagerTestQuestion,
  modelManagerTestThreadId,
} from "../../../test/modelManagerBoxFixtures";

const harness = vi.hoisted(() => ({
  request: vi.fn(),
  answer: vi.fn(),
  load: vi.fn(),
  helper: null as ScopedThreadRef | null,
  projection: null as OrchestrationV2ThreadProjection | null,
  listeners: new Set<() => void>(),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => harness.helper }));
vi.mock("../../state/server", () => ({ serverEnvironment: { requestModelChange: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => harness.request }));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => harness.answer,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { modelManagerThreadRefAtom: () => ({}) },
  threadEnvironment: { respondToApproval: {}, respondToUserInput: {} },
  useEnvironmentThread: (...args: unknown[]) => {
    harness.load(...args);
    const projection = useSyncExternalStore(
      (listener) => {
        harness.listeners.add(listener);
        return () => {
          harness.listeners.delete(listener);
        };
      },
      () => harness.projection,
    );
    return {
      data: projection ? Option.some(projection) : Option.none(),
      error: Option.none(),
      status: "live",
    };
  },
}));
vi.mock("./SecretRequestCard", () => ({ SecretRequestCard: () => <div>Private key request</div> }));

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ModelManagerPanel } from "./ModelManagerPanel";
const environmentId = EnvironmentId.make("local");
const harnesses = deriveProviderInstanceEntries([
  {
    instanceId: ProviderInstanceId.make("opencode"),
    driver: ProviderDriverKind.make("opencode"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-20T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  },
]);
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  root = createRoot(host);
  harness.helper = null;
  harness.projection = modelManagerTestProjection();
  harness.request.mockResolvedValue({
    _tag: "Success",
    value: { threadId: modelManagerTestThreadId, runId: "models-run", delivery: "started" },
  });
  harness.answer.mockResolvedValue({ _tag: "Success" });
});
afterEach(() => {
  act(() => root.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
function button(text: string) {
  const result = [...host.querySelectorAll("button")].find((node) => node.textContent === text);
  if (!result) throw new Error(`Missing ${text}: ${host.textContent}`);
  return result;
}
function type(input: HTMLInputElement, text: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function render(searched = false) {
  root.render(
    <ModelManagerPanel
      environmentId={environmentId}
      harnesses={harnesses}
      browsingInstanceId={null}
      searchedModel={
        searched ? { ref: { source: "id", id: "vendor/model" }, query: "vendor/model" } : null
      }
      open={false}
      onOpenChange={() => {}}
    />,
  );
}

it("takes no space when nothing is open, running or searched", () => {
  act(() => render());
  expect(host.innerHTML).toBe("");
});

it("keeps a requested model, streaming reply, activity and follow-up in the box", async () => {
  act(() => render(true));
  expect(harness.load).not.toHaveBeenCalled();
  await act(async () => button("Add").click());
  expect(harness.request).toHaveBeenCalledWith({
    environmentId,
    input: { text: "Add vendor/model", instanceId: "opencode" },
  });
  expect(host.textContent).toContain("Checking the config");
  expect(host.textContent).toContain("Running cat opencode.json");
  expect(host.textContent).not.toContain("Open chat");
  expect(harness.load).toHaveBeenLastCalledWith(environmentId, modelManagerTestThreadId);
  harness.projection = {
    ...harness.projection!,
    messages: harness.projection!.messages.map((message) =>
      message.role === "assistant" ? { ...message, text: "Checking the config now…" } : message,
    ),
  };
  act(() => {
    for (const notify of harness.listeners) notify();
  });
  expect(host.textContent).toContain("Checking the config now…");
  type(host.querySelector('input[aria-label="Reply to Models"]')!, "remove vendor/model");
  await act(async () => button("Send").click());
  expect(harness.request).toHaveBeenLastCalledWith({
    environmentId,
    input: { text: "remove vendor/model", instanceId: "opencode" },
  });
  harness.projection = modelManagerTestProjection("completed");
  act(() => {
    for (const notify of harness.listeners) notify();
  });
  expect(host.textContent).toContain("Done.");
  expect(host.textContent).not.toContain("Running cat");
});

it("keeps typing, arrows and enter from reaching the model list", async () => {
  const listKey = vi.fn();
  const close = vi.fn();
  act(() =>
    root.render(
      <div onKeyDown={listKey}>
        <ModelManagerPanel
          environmentId={environmentId}
          harnesses={harnesses}
          browsingInstanceId={null}
          searchedModel={null}
          open
          onOpenChange={() => {}}
          onRequestClose={close}
        />
      </div>,
    ),
  );
  const input = host.querySelector("input")!;
  type(input, "remove hy4");
  act(() => input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
  );
  expect(listKey).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  expect(harness.request).toHaveBeenCalledTimes(1);
});

it("restores an existing helper and answers its question without opening a thread", async () => {
  harness.helper = { environmentId, threadId: modelManagerTestThreadId };
  harness.projection = modelManagerTestQuestion();
  act(() => render());
  expect(host.textContent).toContain("Enable this model?");
  expect(button("Answer").disabled).toBe(true);
  act(() => host.querySelector<HTMLInputElement>('input[type="radio"]')!.click());
  await act(async () => button("Answer").click());
  expect(harness.answer).toHaveBeenCalledWith({
    environmentId,
    input: {
      threadId: modelManagerTestThreadId,
      requestId: "models-question",
      answers: { next: "enable-id" },
    },
  });
  expect(harness.request).not.toHaveBeenCalled();
});

it("keeps a failed reply draft and the assistant transcript available for retry", async () => {
  harness.helper = { environmentId, threadId: modelManagerTestThreadId };
  harness.request.mockResolvedValueOnce(
    AsyncResult.failure(Cause.fail(new Error("Server unavailable"))),
  );
  act(() => render());
  const input = host.querySelector<HTMLInputElement>('input[aria-label="Reply to Models"]')!;
  type(input, "try again");
  await act(async () => button("Send").click());
  expect(input.value).toBe("try again");
  expect(host.textContent).toContain("Checking the config");
  expect(host.textContent).toContain("Server unavailable");
});
