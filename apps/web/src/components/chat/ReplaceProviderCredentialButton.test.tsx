// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import { act, createContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type RecoveryRun = Pick<OrchestrationV2Run, "id" | "status" | "modelSelection"> & {
  credentialRecovery?: {
    credentialRef: string;
    label: string;
    consoleUrl?: string;
    alsoUsedBy: readonly string[];
  };
};
const harness = vi.hoisted(() => ({
  allowed: true,
  latest: null as null | { runId: RunId; status: OrchestrationV2Run["status"] },
  detail: null as null | {
    projection: {
      runs: RecoveryRun[];
      thread: { runtimeMode: string; interactionMode: string; modelSelection: unknown };
    };
  },
  replace: vi.fn<(...args: unknown[]) => Promise<{ _tag: "Success" | "Failure" }>>(),
  start: vi.fn<(...args: unknown[]) => Promise<{ _tag: "Success" | "Failure" }>>(),
}));
vi.mock("@effect/atom-react", () => ({
  RegistryContext: createContext({}),
  useAtomValue: (atom: unknown, select?: (value: unknown) => unknown) =>
    select
      ? select(atom === "shell" ? { latestRun: harness.latest } : harness.detail)
      : harness.allowed,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    replaceProviderCredential: {
      permissionAtom: () => "permission",
      run: (_registry: unknown, input: unknown) => harness.replace(input),
    },
  },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: () => "detail" },
  environmentThreadShells: { threadShellAtom: () => "shell" },
  threadEnvironment: { startTurn: "start" },
}));
vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => harness.start,
}));

import { ReplaceProviderCredentialButton } from "./ReplaceProviderCredentialButton";

const threadRef = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
};
const runId = RunId.make("failed");
const failedSelection = {
  instanceId: ProviderInstanceId.make("pi-work"),
  model: "failed-model",
  options: [{ id: "reasoning", value: "high" }],
};
function failedRun(): RecoveryRun {
  return {
    id: runId,
    status: "failed",
    modelSelection: failedSelection,
    credentialRecovery: {
      credentialRef: "secret-ref",
      label: "Work account",
      consoleUrl: "https://example.com/keys",
      alsoUsedBy: ["Build", "Review"],
    },
  };
}
let host: HTMLDivElement;
let root: Root;
function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
function render() {
  act(() => root.render(<ReplaceProviderCredentialButton threadRef={threadRef} runId={runId} />));
}
function button(label: string) {
  return [...document.querySelectorAll("button")].find((item) => item.textContent === label)!;
}
function enter(value: string) {
  const input = document.querySelector("input")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function open() {
  render();
  act(() => button("Replace API key").click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.allowed = true;
  harness.latest = { runId, status: "failed" };
  harness.detail = {
    projection: {
      runs: [failedRun()],
      thread: {
        runtimeMode: "full-access",
        interactionMode: "plan",
        modelSelection: { instanceId: "another-provider", model: "newer-selection" },
      },
    },
  };
  harness.replace.mockReset().mockResolvedValue({ _tag: "Success" });
  harness.start.mockReset().mockResolvedValue({ _tag: "Success" });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("offers replacement only for the latest failed run with recovery and settings permission", () => {
  render();
  expect(button("Replace API key")).toBeDefined();
  harness.allowed = false;
  render();
  expect(button("Replace API key")).toBeUndefined();
  harness.allowed = true;
  const withoutRecovery = failedRun();
  delete withoutRecovery.credentialRecovery;
  harness.detail!.projection.runs = [withoutRecovery];
  render();
  expect(button("Replace API key")).toBeUndefined();
  harness.detail!.projection.runs = [{ ...failedRun(), status: "running" }];
  render();
  expect(button("Replace API key")).toBeUndefined();
  harness.detail!.projection.runs = [failedRun(), { ...failedRun(), id: RunId.make("newer") }];
  render();
  expect(button("Replace API key")).toBeUndefined();
});
it("shows the key source and shared accounts in a password dialog", () => {
  open();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Work account");
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
    "Also used by: Build, Review",
  );
  expect(document.querySelector("input")?.type).toBe("password");
  expect(document.querySelector('a[href="https://example.com/keys"]')?.textContent).toBe(
    "Get API key",
  );
  expect(button("Save and retry").disabled).toBe(true);
});
it("saves before retrying with the failed model and existing turn modes, then clears the key", async () => {
  const save = deferred<{ _tag: "Success" }>();
  const retry = deferred<{ _tag: "Success" }>();
  harness.replace.mockReturnValueOnce(save.promise);
  harness.start.mockReturnValueOnce(retry.promise);
  open();
  enter("test-replacement-key");
  await act(async () => button("Save and retry").click());
  expect(harness.replace).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: { credentialRef: "secret-ref", value: "test-replacement-key" },
  });
  expect(harness.start).not.toHaveBeenCalled();
  await act(async () => save.resolve({ _tag: "Success" }));
  expect(document.querySelector("input")).toBeNull();
  expect(harness.start).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      message: { messageId: expect.any(String), role: "user", text: "Continue.", attachments: [] },
      modelSelection: failedSelection,
      runtimeMode: "full-access",
      interactionMode: "plan",
      dispatchMode: "auto",
    },
  });
  await act(async () => retry.resolve({ _tag: "Success" }));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  act(() => button("Replace API key").click());
  expect(document.querySelector("input")?.value).toBe("");
});
it("keeps save failures inline and never retries or displays the failed input", async () => {
  harness.replace.mockRejectedValueOnce(new Error("test-replacement-key"));
  open();
  enter("test-replacement-key");
  await act(async () => button("Save and retry").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Could not save the API key. Try again.",
  );
  expect(document.body.textContent).not.toContain("test-replacement-key");
  expect(harness.start).not.toHaveBeenCalled();
});
it("can retry after a saved key without saving it again", async () => {
  harness.start.mockResolvedValueOnce({ _tag: "Failure" });
  open();
  enter("test-replacement-key");
  await act(async () => button("Save and retry").click());
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(
    "Key saved. Could not retry. Try again.",
  );
  expect(document.querySelector("input")).toBeNull();
  await act(async () => button("Retry").click());
  expect(harness.replace).toHaveBeenCalledOnce();
  expect(harness.start).toHaveBeenCalledTimes(2);
});
it("clears a dismissed key and does not retry a save completed after closing", async () => {
  const save = deferred<{ _tag: "Success" }>();
  harness.replace.mockReturnValueOnce(save.promise);
  open();
  enter("test-replacement-key");
  await act(async () => button("Save and retry").click());
  act(() => button("Cancel").click());
  await act(async () => save.resolve({ _tag: "Success" }));
  expect(harness.start).not.toHaveBeenCalled();
  act(() => button("Replace API key").click());
  expect(document.querySelector("input")?.value).toBe("");
});

it("hides recovery when the shell queues newer work and does not retry an obsolete run", async () => {
  const save = deferred<{ _tag: "Success" }>();
  harness.replace.mockReturnValueOnce(save.promise);
  open();
  enter("test-replacement-key");
  await act(async () => button("Save and retry").click());
  harness.latest = { runId: RunId.make("newer"), status: "queued" };
  render();
  expect(button("Replace API key")).toBeUndefined();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => save.resolve({ _tag: "Success" }));
  expect(harness.start).not.toHaveBeenCalled();
});
