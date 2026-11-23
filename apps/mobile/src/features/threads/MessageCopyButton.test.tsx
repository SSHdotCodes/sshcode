// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ copy: vi.fn(async (_text: string) => true) }));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: harness.copy }));
vi.mock("../prompt-links/prompt-link-actions", () => ({ copyPromptLink: vi.fn() }));
vi.mock("../../components/ControlPill", () => ({
  ControlPillMenu: (props: {
    children: ReactNode;
    actions: Array<{ id: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) => (
    <div>
      {props.children}
      {props.actions.map((action) => (
        <button
          key={action.id}
          onClick={() => props.onPressAction({ nativeEvent: { event: action.id } })}
        >
          {action.title}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("../../components/CopyTextButton", () => ({
  CopyTextButton: () => <button>Copy message</button>,
}));

import { MessageCopyButton } from "./MessageCopyButton";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.copy.mockClear();
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(() => act(() => root.unmount()));

it.each(["", " \n\t "])(
  "does not expose copy or quote actions for empty message text %j",
  (text) => {
    act(() =>
      root.render(<MessageCopyButton text={text} onQuote={vi.fn()} promptLink tintColor="#fff" />),
    );
    expect(container.querySelectorAll("button")).toHaveLength(0);
    expect(harness.copy).not.toHaveBeenCalled();
  },
);

it("copies the original Markdown of a text message", async () => {
  const markdown = "**Result**\n\n```ts\nconst n = 1;\n```";
  act(() => root.render(<MessageCopyButton text={markdown} tintColor="#fff" />));
  const action = [...container.querySelectorAll("button")].find(
    (button) => button.textContent === "Copy Markdown",
  )!;
  await act(async () => action.click());
  expect(harness.copy).toHaveBeenCalledExactlyOnceWith(markdown);
});
