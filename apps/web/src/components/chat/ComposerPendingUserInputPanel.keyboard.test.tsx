// @vitest-environment jsdom

import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import type { PendingUserInput } from "../../session-logic";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

vi.mock("../ChatMarkdown", () => ({ default: () => null }));

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("question-shortcuts"),
  createdAt: "2026-10-31T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live",
  questions: [
    {
      id: "question",
      header: "Rollout",
      question: "How should this ship?",
      options: [{ label: "Incremental", description: "One module at a time" }],
      multiSelect: true,
    },
  ],
};

it("lets shadow-root editors take digit keys while the question shortcut works outside", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const host = document.createElement("div");
  const outside = document.createElement("button");
  const shadow = host.attachShadow({ mode: "open" });
  const editor = document.createElement("div");
  editor.setAttribute("contenteditable", "true");
  editor.tabIndex = 0;
  const findHost = document.createElement("div");
  const find = document.createElement("input");
  findHost.attachShadow({ mode: "open" }).append(find);
  shadow.append(editor, findHost);
  document.body.append(container, host, outside);
  const root = createRoot(container);
  const onToggleOption = vi.fn();
  const pressDigit = (element: HTMLElement) => {
    element.focus();
    const event = new KeyboardEvent("keydown", {
      key: "1",
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    act(() => {
      element.dispatchEvent(event);
    });
    return event.defaultPrevented;
  };

  try {
    act(() =>
      root.render(
        <ComposerPendingUserInputPanel
          pendingUserInputs={[prompt]}
          cwd={undefined}
          threadRef={{
            environmentId: EnvironmentId.make("env"),
            threadId: ThreadId.make("thread"),
          }}
          respondingRequestIds={[]}
          answers={{}}
          questionIndex={0}
          onToggleOption={onToggleOption}
          onAdvance={vi.fn()}
          onDismiss={vi.fn()}
        />,
      ),
    );
    expect(pressDigit(editor)).toBe(false);
    expect(pressDigit(find)).toBe(false);
    expect(onToggleOption).not.toHaveBeenCalled();

    expect(pressDigit(outside)).toBe(true);
    expect(onToggleOption).toHaveBeenCalledExactlyOnceWith("question", "Incremental");
  } finally {
    act(() => root.unmount());
    container.remove();
    host.remove();
    outside.remove();
    vi.unstubAllGlobals();
  }
});
