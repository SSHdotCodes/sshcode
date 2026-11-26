// @vitest-environment jsdom
import { act, createRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import { useSidebarChatTabSelection } from "./useSidebarChatTabSelection";
import { SidebarChatTabs } from "./SidebarChatTabs";

vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { chatListTabsEnabledAtom: Atom.make<boolean | null>(true) };
});
import { chatListTabsEnabledAtom } from "../../state/server";

vi.mock("../ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => children,
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: React.ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("~/hooks/usePrivacyMode", () => ({
  usePrivacyMode: () => false,
  usePrivacyLabel: () => (_kind: string, _id: string, label: string) => label,
}));
vi.mock("~/lib/observeResize", () => ({ observeResize: () => () => {} }));

afterEach(() => vi.restoreAllMocks());

it("navigates tabs with a roving tab stop and opens actions from the keyboard", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const menu = vi.fn();
  const tabs = ["one", "two"].map((name) => ({
    key: name,
    name,
    threadKeys: new Set<string>(),
    attention: false,
    working: false,
  }));
  function App() {
    const [selected, select] = useState("");
    return (
      <SidebarChatTabs
        enabled
        ref={createRef()}
        tabs={tabs}
        selected={selected}
        dropTarget={null}
        renaming={null}
        onSelect={select}
        onContextMenu={menu}
        onRename={() => {}}
        onRenameEnd={() => {}}
      />
    );
  }
  await act(() => root.render(<App />));
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(buttons.map((button) => button.textContent)).toEqual(["All", "one", "two", "Terminal"]);
  expect(buttons.map((button) => button.tabIndex)).toEqual([0, -1, -1, -1]);
  buttons[0]!.focus();
  await act(() =>
    buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
  );
  expect(document.activeElement).toBe(buttons[3]);
  expect(buttons.map((button) => button.tabIndex)).toEqual([-1, -1, -1, 0]);
  await act(() =>
    buttons[3]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
  );
  expect(document.activeElement).toBe(buttons[2]);
  await act(() =>
    buttons[2]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true }),
    ),
  );
  expect(menu).toHaveBeenCalledWith(tabs[1], expect.any(Object));
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("keeps Terminal last, outside tab actions and chat drop targets", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const menu = vi.fn();
  const tabs = [
    {
      key: "mine",
      name: "My chats",
      threadKeys: new Set<string>(),
      attention: false,
      working: false,
    },
  ];
  const props = {
    enabled: true,
    ref: createRef<HTMLDivElement>(),
    tabs,
    selected: "",
    dropTarget: null,
    renaming: null,
    onSelect: vi.fn(),
    onContextMenu: menu,
    onRename: vi.fn(),
    onRenameEnd: vi.fn(),
  };
  await act(() => root.render(<SidebarChatTabs {...props} />));
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  expect(buttons.map((button) => button.textContent)).toEqual(["All", "My chats", "Terminal"]);
  const terminal = buttons.at(-1)!;
  expect(terminal.hasAttribute("data-chat-tab-drop")).toBe(false);
  await act(() =>
    terminal.dispatchEvent(new KeyboardEvent("keydown", { key: "ContextMenu", bubbles: true })),
  );
  expect(menu).not.toHaveBeenCalled();
  buttons[0]!.focus();
  await act(() =>
    buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
  );
  expect(document.activeElement).toBe(terminal);
  await act(() => root.render(<SidebarChatTabs {...props} tabs={[]} />));
  expect(
    [...container.querySelectorAll('[role="tab"]')].map((button) => button.textContent),
  ).toEqual(["All", "Terminal"]);
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("resets the saved folder and releases Ctrl+Tab when chat list tabs are disabled", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  HTMLElement.prototype.scrollIntoView = vi.fn();
  const registry = AtomRegistry.make();
  const preference = chatListTabsEnabledAtom as Atom.Writable<boolean | null>;
  const container = document.createElement("div");
  const root = createRoot(container);
  const tabs = [
    { key: "work", name: "Work", threadKeys: new Set<string>(), attention: false, working: false },
  ];
  function App() {
    const { enabled, selected, select } = useSidebarChatTabSelection();
    return (
      <SidebarChatTabs
        ref={null}
        enabled={enabled}
        selected={selected}
        tabs={tabs}
        dropTarget={null}
        renaming={null}
        onSelect={select}
        onRename={() => {}}
        onRenameEnd={() => {}}
        onContextMenu={() => {}}
      />
    );
  }
  try {
    await act(() =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <App />
        </RegistryContext.Provider>,
      ),
    );
    const cycle = () =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, cancelable: true }),
      );
    await act(() => {
      expect(cycle()).toBe(false);
    });
    const active = () => container.querySelector('[aria-selected="true"]')?.textContent;
    expect(active()).toBe("Work");
    await act(() => registry.set(preference, false));
    expect(active()).toBe("All");
    expect(cycle()).toBe(true);
    await act(() => registry.set(preference, true));
    expect(active()).toBe("All");
  } finally {
    await act(() => root.unmount());
    registry.dispose();
    localStorage.removeItem("t3code:sidebar-chat-tab:v1");
    vi.unstubAllGlobals();
  }
});
