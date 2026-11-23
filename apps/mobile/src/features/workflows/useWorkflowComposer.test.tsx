// @vitest-environment jsdom
import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, WorkflowId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import type { ComposerDraft } from "../../state/use-composer-drafts";
import { workflowComposerRecord } from "./workflowComposer";

const mocks = vi.hoisted(() => ({
  beta: true,
  permission: true,
  start: vi.fn(),
  alert: vi.fn(),
  dispatch: vi.fn(),
  clear: vi.fn(),
  setContext: vi.fn(),
  setText: vi.fn(),
  draft: { text: "", attachments: [] } as ComposerDraft,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => mocks.permission }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ dispatch: mocks.dispatch }),
  StackActions: { push: (name: string, params: object) => ({ name, params }) },
}));
vi.mock("react-native", () => ({ Alert: { alert: mocks.alert } }));
vi.mock("./state", () => ({
  useWorkflowsEnabled: () => [mocks.beta],
  startWorkflow: { permissionAtom: () => Symbol("permission") },
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.start }));
vi.mock("../../state/use-composer-drafts", () => ({
  getComposerDraftSnapshot: () => mocks.draft,
  clearComposerDraftContent: (...args: unknown[]) => mocks.clear(...args),
  setComposerDraftContext: (...args: unknown[]) => mocks.setContext(...args),
  setComposerDraftText: (...args: unknown[]) => mocks.setText(...args),
}));
import { useWorkflowComposer } from "./useWorkflowComposer";

const environmentId = EnvironmentId.make("phone-host");
const threadId = ThreadId.make("normal-chat");
const workflow = { id: WorkflowId.make("team"), name: "Team" };
let root: Root;
let current: ReturnType<typeof useWorkflowComposer>;
function Probe() {
  const value = useWorkflowComposer({
    environmentId,
    threadId,
    draftKey: "draft",
    connected: true,
    available: true,
  });
  useLayoutEffect(() => {
    current = value;
  });
  return null;
}
async function render() {
  await act(async () => {
    root.render(<Probe />);
  });
}
function selectedDraft() {
  const record = workflowComposerRecord(workflow);
  mocks.draft = {
    text: `${formatComposerContextReference(record)} Build it`,
    attachments: [],
    context: { version: 1, records: [record] },
  };
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  mocks.beta = true;
  mocks.permission = true;
  mocks.draft = { text: "hello", attachments: [] };
  mocks.start.mockResolvedValue({ _tag: "Success", value: { runId: "run-1" } });
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("workflow composer send", () => {
  it("leaves ordinary sends and beta-off drafts untouched", async () => {
    await render();
    expect(await current.interceptSend()).toBe(false);
    selectedDraft();
    mocks.beta = false;
    await render();
    expect(await current.interceptSend()).toBe(false);
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
  });
  it("opens the picker for a typed command without sending anything", async () => {
    mocks.draft = { ...mocks.draft, text: "/workflow Build it" };
    await render();
    await act(async () => {
      expect(await current.interceptSend()).toBe(true);
    });
    expect(current.pickerOpen).toBe(true);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("starts in the same chat, strips the chip, and clears only the submitted draft", async () => {
    selectedDraft();
    const draft = mocks.draft;
    await render();
    await current.interceptSend();
    expect(mocks.start).toHaveBeenCalledWith({
      environmentId,
      input: { workflowId: workflow.id, chatThreadId: threadId, task: "Build it" },
    });
    expect(mocks.clear).toHaveBeenCalledWith("draft", { expectedContent: draft });
    expect(mocks.dispatch).toHaveBeenCalledWith({
      name: "Workflows",
      params: { environmentId, runId: "run-1" },
    });
  });
  it("coalesces double taps until the first start finishes", async () => {
    selectedDraft();
    let finish!: (value: unknown) => void;
    mocks.start.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    await render();
    const first = current.interceptSend();
    expect(await current.interceptSend()).toBe(true);
    expect(mocks.start).toHaveBeenCalledTimes(1);
    finish({ _tag: "Success", value: { runId: "run-1" } });
    expect(await first).toBe(true);
  });

  it("preserves the draft when starting fails or permission is missing", async () => {
    selectedDraft();
    mocks.permission = false;
    await render();
    await current.interceptSend();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.clear).not.toHaveBeenCalled();
    mocks.permission = true;
    mocks.start.mockRejectedValueOnce(new Error("disconnected"));
    await render();
    expect(await current.interceptSend()).toBe(true);
    expect(mocks.alert).toHaveBeenLastCalledWith("Could not start workflow", "disconnected");
    expect(mocks.clear).not.toHaveBeenCalled();
  });
});
