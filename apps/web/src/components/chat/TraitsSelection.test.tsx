// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { ModelPickerReasoningColumn } from "./ModelPickerReasoningColumn";

const updateModel = vi.hoisted(() => vi.fn());

const instanceId = ProviderInstanceId.make("codex");
const threadRef = { environmentId: EnvironmentId.make("remote"), threadId: ThreadId.make("chat") };
const draftId = DraftId.make("new-chat");
const models = [
  {
    slug: "gpt-5.4",
    name: "GPT",
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select" as const,
          currentValue: "medium",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High" },
          ],
        },
        { id: "fastMode", label: "Fast", type: "boolean" as const, currentValue: true },
      ],
    },
  },
];
let root: Root;
let host: HTMLDivElement;
function render(options: ReadonlyArray<ProviderOptionSelection>, isNew = false) {
  act(() =>
    root.render(
      <ModelPickerReasoningColumn
        provider={ProviderDriverKind.make("codex")}
        instanceId={instanceId}
        models={models}
        model="gpt-5.4"
        modelLabel="GPT"
        prompt="text being typed"
        onPromptChange={() => {}}
        planModeEnabled={false}
        modelOptions={options}
        {...(isNew ? { draftId } : { threadRef, onModelOptionsChange: updateModel })}
      />,
    ),
  );
}
function pickHigh() {
  act(() => host.querySelectorAll<HTMLButtonElement>("[role=radio]")[2]!.click());
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  updateModel.mockClear();
  host = document.createElement("div");
  root = createRoot(host);
  useComposerDraftStore.setState({ draftsByThreadKey: {} });
});
afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
});

it("saves effort to the shared thread, follows a remote option change, and keeps text", () => {
  useComposerDraftStore.getState().setPrompt(threadRef, "text being typed");
  render([
    { id: "reasoningEffort", value: "medium" },
    { id: "fastMode", value: true },
  ]);
  pickHigh();
  expect(updateModel).toHaveBeenCalledWith([
    { id: "reasoningEffort", value: "high" },
    { id: "fastMode", value: true },
  ]);
  expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.activeProvider).toBeNull();
  render([{ id: "reasoningEffort", value: "low" }]);
  expect(host.querySelector("[role=radio][aria-checked=true]")?.textContent).toContain("Low");
  expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
    "text being typed",
  );
});

it("keeps new chat effort local and remembers its sticky default", () => {
  render([], true);
  pickHigh();
  expect(updateModel).not.toHaveBeenCalled();
  const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
  expect(draft?.modelSelectionByProvider[instanceId]?.options).toContainEqual({
    id: "reasoningEffort",
    value: "high",
  });
  expect(
    useComposerDraftStore.getState().stickyOptionsByModelByProvider[instanceId]?.["gpt-5.4"],
  ).toContainEqual({ id: "reasoningEffort", value: "high" });
});
