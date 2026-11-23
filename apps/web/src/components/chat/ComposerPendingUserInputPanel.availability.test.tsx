// @vitest-environment jsdom
import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { PendingUserInput } from "../../session-logic";

vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("request"),
  createdAt: "2026-10-16T00:00:00.000Z",
  dismissible: true,
  responseCapability: "live",
  questions: [
    {
      id: "approach",
      header: "Approach",
      question: "Which approach?",
      options: [{ label: "Incremental", description: "One module at a time" }],
      multiSelect: false,
    },
  ],
};
let root: Root;
let container: HTMLDivElement;
const onToggleOption = vi.fn();
const onAdvance = vi.fn();
const onDismiss = vi.fn();

function render(responseCapability = prompt.responseCapability, responding = false) {
  act(() =>
    root.render(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[{ ...prompt, responseCapability }]}
        cwd="/repo"
        threadRef={{ environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") }}
        respondingRequestIds={responding ? [prompt.requestId] : []}
        answers={{}}
        questionIndex={0}
        onToggleOption={onToggleOption}
        onAdvance={onAdvance}
        onDismiss={onDismiss}
      />,
    ),
  );
}
function option() {
  return Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Incremental"),
  )!;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("cannot select or advance a question that is no longer resumable", () => {
  render("not_resumable");
  expect(option().disabled).toBe(true);
  act(() => option().click());
  act(() => vi.advanceTimersByTime(200));
  expect(onToggleOption).not.toHaveBeenCalled();
  expect(onAdvance).not.toHaveBeenCalled();
});

it.each(["not_resumable", "responding"] as const)(
  "cancels delayed advance when a question becomes %s",
  (state) => {
    render();
    act(() => option().click());
    expect(onToggleOption).toHaveBeenCalledOnce();
    render(state === "responding" ? "live" : state, state === "responding");
    act(() => vi.advanceTimersByTime(200));
    expect(onAdvance).not.toHaveBeenCalled();
  },
);

it("does not submit a selected answer while dismissing the question", () => {
  render();
  act(() => option().click());
  act(() => container.querySelector<HTMLElement>("[data-pending-user-input-dismiss]")!.click());
  expect(onDismiss).toHaveBeenCalledWith(prompt.requestId);
  act(() => vi.advanceTimersByTime(200));
  expect(onAdvance).not.toHaveBeenCalled();
});

it.each(["dialog", "alertdialog", "menu", "listbox", "floating"])(
  "leaves number keys inside a %s to that surface",
  (role) => {
    render();
    const surface = document.createElement("div");
    if (role === "floating") surface.dataset.chatComposerFloatingLayer = "true";
    else surface.setAttribute("role", role);
    const control = document.createElement("button");
    surface.append(control);
    document.body.append(surface);
    act(() =>
      control.dispatchEvent(
        new KeyboardEvent("keydown", { key: "1", bubbles: true, cancelable: true }),
      ),
    );
    act(() => vi.advanceTimersByTime(200));
    surface.remove();
    expect(onToggleOption).not.toHaveBeenCalled();
    expect(onAdvance).not.toHaveBeenCalled();
  },
);

it.each(["repeat", "isComposing", "defaultPrevented"])("ignores a %s number-key event", (kind) => {
  render();
  const event = new KeyboardEvent("keydown", {
    key: "1",
    bubbles: true,
    cancelable: true,
    repeat: kind === "repeat",
    isComposing: kind === "isComposing",
  });
  if (kind === "defaultPrevented") event.preventDefault();
  act(() => document.body.dispatchEvent(event));
  act(() => vi.advanceTimersByTime(200));
  expect(onAdvance).not.toHaveBeenCalled();
});

it("still selects a question by number from the transcript", () => {
  render();
  act(() => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "1", bubbles: true })));
  act(() => vi.advanceTimersByTime(200));
  expect(onToggleOption).toHaveBeenCalledWith("approach", "Incremental");
  expect(onAdvance).toHaveBeenCalledOnce();
});

it.each(["click", "Enter", " "])("cannot dismiss a submitting question with %s", (key) => {
  render("live", true);
  const dismiss = container.querySelector<HTMLElement>("[data-pending-user-input-dismiss]")!;
  act(() => {
    if (key === "click") dismiss.click();
    else
      dismiss.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
  expect(onDismiss).not.toHaveBeenCalled();
  expect(
    container.querySelector("[data-pending-user-input-toggle]")!.getAttribute("aria-expanded"),
  ).toBe("true");
});

it("dismisses from a sibling native button without toggling the disclosure", () => {
  render();
  const dismiss = container.querySelector<HTMLButtonElement>("[data-pending-user-input-dismiss]")!;
  expect(dismiss.tagName).toBe("BUTTON");
  expect(dismiss.closest("[data-pending-user-input-toggle]")).toBeNull();
  act(() => dismiss.click());
  expect(onDismiss).toHaveBeenCalledExactlyOnceWith(prompt.requestId);
  expect(
    container.querySelector("[data-pending-user-input-toggle]")!.getAttribute("aria-expanded"),
  ).toBe("true");
});
