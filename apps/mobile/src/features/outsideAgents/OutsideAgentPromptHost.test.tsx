// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import type { OutsideAgentSignIn } from "@t3tools/contracts";

vi.mock("../../state/entities", () => ({ useServerConfigs: vi.fn() }));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: vi.fn() }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: vi.fn() }));
vi.mock("../../components/AppText", () => ({
  AppText: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("react-native", () => ({
  Modal: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    onPress,
    disabled,
    children,
  }: {
    onPress: () => void;
    disabled?: boolean;
    children: ReactNode;
  }) => (
    <button disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  TextInput: ({
    value,
    onChangeText,
    editable,
    accessibilityLabel,
  }: {
    value: string;
    onChangeText: (text: string) => void;
    editable: boolean;
    accessibilityLabel: string;
  }) => (
    <input
      aria-label={accessibilityLabel}
      disabled={!editable}
      value={value}
      onChange={(event) => onChangeText(event.currentTarget.value)}
    />
  ),
}));

import { OutsideAgentSheet } from "./OutsideAgentPromptHost";

const planted: OutsideAgentSignIn = {
  id: "planted",
  code: "4821",
  clientName: "Claude - enter 4821",
  redirectHost: "attacker.test",
  requestedAt: 1,
  expiresAt: 9999999999999,
};
const own: OutsideAgentSignIn = {
  ...planted,
  id: "own",
  code: "0042",
  clientName: "My app",
  redirectHost: "my-app.test",
  requestedAt: 2,
};
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
});
async function mount() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const answer = vi.fn(async () => true);
  const render = async (pending: OutsideAgentSignIn[]) => {
    await act(async () =>
      root.render(<OutsideAgentSheet pending={pending} onAnswer={answer} onLater={() => {}} />),
    );
  };
  await render([planted, own]);
  const input = container.querySelector("input")!;
  const type = async (value: string) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const click = async (label: string) => {
    const button = Array.from(container.querySelectorAll("button")).find(
      (item) => item.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => button!.click());
  };
  return { container, input, type, click, answer, render };
}

it("shows only a waiting count before a code matches, including no-match and partial codes", async () => {
  const view = await mount();
  expect(view.input.value).toBe("");
  expect(view.container.textContent).toContain("2 sign-ins waiting");
  for (const value of [
    planted.clientName,
    planted.redirectHost,
    planted.code,
    own.clientName,
    own.redirectHost,
    own.code,
  ])
    expect(view.container.textContent).not.toContain(value);
  await view.type("004");
  expect(view.container.textContent).not.toContain(own.clientName);
  await view.type("9999");
  expect(view.container.textContent).toContain(
    "No sign-in has that code. Check the page in your browser.",
  );
  expect(view.container.textContent).not.toContain(planted.clientName);
  expect(
    Array.from(view.container.querySelectorAll("button")).map((button) => button.textContent),
  ).toEqual(["Not now"]);
  expect(view.answer).not.toHaveBeenCalled();
});

it("reveals only the match, and Allow sends the code the owner typed", async () => {
  const view = await mount();
  await view.type("00 42");
  expect(view.input.value).toBe("0042");
  expect(view.container.textContent).toContain(own.clientName);
  expect(view.container.textContent).toContain(own.redirectHost);
  expect(view.container.textContent).toContain("Access: Supervised");
  expect(view.container.textContent).not.toContain(planted.clientName);
  expect(view.container.textContent).not.toContain(planted.redirectHost);
  expect(view.answer).not.toHaveBeenCalled();
  await view.click("Allow");
  expect(view.answer).toHaveBeenCalledExactlyOnceWith({
    _tag: "approve",
    id: own.id,
    access: "approval-required",
    code: "0042",
  });
  expect(view.input.value).toBe("");
  expect(view.container.textContent).not.toContain(own.clientName);
});

it("hides expired or replaced matches and denies without a code", async () => {
  const view = await mount();
  await view.type("0042");
  await view.render([planted, { ...own, id: "replacement", code: "1234" }]);
  expect(view.container.textContent).not.toContain(own.clientName);
  await view.type("1234");
  await view.click("Deny");
  expect(view.answer).toHaveBeenCalledExactlyOnceWith({ _tag: "deny", id: "replacement" });
});
