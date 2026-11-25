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
            { id: "ultracode", label: "Ultracode" },
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
// End moves to the slider's last stop, Ultracode.
function pickTop() {
  const slider = host.querySelector<HTMLInputElement>("input[type=range]")!;
  act(() => slider.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
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
  pickTop();
  expect(updateModel).toHaveBeenCalledWith([
    { id: "reasoningEffort", value: "ultracode" },
    { id: "fastMode", value: true },
  ]);
  expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.activeProvider).toBeNull();
  render([{ id: "reasoningEffort", value: "low" }]);
  expect(host.querySelector("input[type=range]")?.getAttribute("aria-valuetext")).toBe("Low");
  expect(useComposerDraftStore.getState().getComposerDraft(threadRef)?.prompt).toBe(
    "text being typed",
  );
});

it("puts Ultracode on the slider as its last stop", () => {
  render([{ id: "reasoningEffort", value: "medium" }]);
  expect(host.querySelector("[role=radio]")).toBeNull();
  const slider = host.querySelector<HTMLInputElement>("input[type=range]")!;
  expect(slider.getAttribute("aria-valuetext")).toBe("Medium");
  expect(slider.getAttribute("max")).toBe("3");
  pickTop();
  expect(updateModel).toHaveBeenCalledWith(
    expect.arrayContaining([{ id: "reasoningEffort", value: "ultracode" }]),
  );
});

it("keeps new chat effort local and remembers its sticky default", () => {
  render([], true);
  pickTop();
  expect(updateModel).not.toHaveBeenCalled();
  const draft = useComposerDraftStore.getState().getComposerDraft(draftId);
  expect(draft?.modelSelectionByProvider[instanceId]?.options).toContainEqual({
    id: "reasoningEffort",
    value: "ultracode",
  });
  expect(
    useComposerDraftStore.getState().stickyOptionsByModelByProvider[instanceId]?.["gpt-5.4"],
  ).toContainEqual({ id: "reasoningEffort", value: "ultracode" });
});
