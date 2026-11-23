// @vitest-environment jsdom

import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { getTerminalFocusOwner } from "../lib/terminalFocus";

const state = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { allowed: false, ready, release };
});

vi.mock("../state/session", () => ({ useEnvironmentScope: () => state.allowed }));
vi.mock("./ThreadTerminalDrawer", async () => {
  await state.ready;
  return { default: () => <textarea aria-label="Terminal input" autoFocus /> };
});

import LazyThreadTerminalDrawer from "./LazyThreadTerminalDrawer";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let composer: HTMLTextAreaElement | undefined;
afterEach(async () => {
  await act(() => root?.unmount());
  state.release();
  container?.remove();
  composer?.remove();
  vi.unstubAllGlobals();
});

it("claims writable terminal focus and drops typing while its chunk is delayed", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  composer = document.createElement("textarea");
  composer.value = "Unsent draft";
  document.body.append(container, composer);
  root = createRoot(container);
  const composerKeys: string[] = [];
  composer.addEventListener("keydown", (event) => composerKeys.push(event.key));
  composer.focus();
  const noop = () => {};
  const props: ComponentProps<typeof LazyThreadTerminalDrawer> = {
    threadRef: { environmentId: EnvironmentId.make("qa"), threadId: ThreadId.make("thread") },
    threadId: ThreadId.make("thread"),
    cwd: "/workspace",
    visible: true,
    height: 320,
    terminalIds: ["terminal"],
    activeTerminalId: "terminal",
    terminalGroups: [],
    activeTerminalGroupId: "",
    focusRequestId: 1,
    onSplitTerminal: noop,
    onSplitTerminalVertical: noop,
    onNewTerminal: noop,
    onActiveTerminalChange: noop,
    onCloseTerminal: noop,
    onHeightChange: noop,
    onAddTerminalContext: noop,
    keybindings: [],
  };
  const render = async (changes: Partial<typeof props> = {}) => {
    await act(() => root!.render(<LazyThreadTerminalDrawer {...props} {...changes} />));
  };

  await render();
  expect(document.activeElement).toBe(composer);
  state.allowed = true;
  await render({ visible: false });
  expect(document.activeElement).toBe(composer);
  await render();
  expect(document.activeElement).toBe(container.querySelector("aside"));
  expect(getTerminalFocusOwner()).toBe("drawer");
  const key = new KeyboardEvent("keydown", { key: "x", bubbles: true, cancelable: true });
  await act(() => document.activeElement!.dispatchEvent(key));
  expect(key.defaultPrevented).toBe(true);
  expect(composerKeys).toEqual([]);
  expect(composer.value).toBe("Unsent draft");
  const paste = new Event("paste", { bubbles: true, cancelable: true });
  await act(() => document.activeElement!.dispatchEvent(paste));
  expect(paste.defaultPrevented).toBe(true);
  for (const options of [{ key: "Tab" }, { key: "j", metaKey: true }]) {
    const shortcut = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...options });
    await act(() => document.activeElement!.dispatchEvent(shortcut));
    expect(shortcut.defaultPrevented).toBe(false);
  }

  composer.focus();
  await render();
  expect(document.activeElement).toBe(composer);
  await render({ focusRequestId: 2 });
  expect(getTerminalFocusOwner()).toBe("drawer");
  composer.focus();
  await render({ mode: "panel", focusRequestId: 3 });
  expect(getTerminalFocusOwner()).toBe("right-panel");

  await act(async () => {
    state.release();
    await import("./ThreadTerminalDrawer");
  });
  expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  expect(document.activeElement).toBe(container.querySelector('[aria-label="Terminal input"]'));
  expect(composer.value).toBe("Unsent draft");
});
