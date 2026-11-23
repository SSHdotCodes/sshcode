// @vitest-environment jsdom
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { CLAUDE_RC_TAB } from "@t3tools/contracts";
import { DiscordServerRail } from "./DiscordNavigation";

vi.mock("../ui/sidebar", () => ({ useSidebar: () => ({ toggleSidebar: vi.fn() }) }));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({
    render,
    children,
  }: {
    render: ReactElement<{ children?: ReactNode }>;
    children: ReactNode;
  }) => cloneElement(render, {}, children),
  TooltipPopup: () => null,
}));

it("appends Terminal after user servers without server editing or drop actions", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  const select = vi.fn();
  const menu = vi.fn();
  const props = {
    servers: [
      {
        tab: {
          key: "work",
          name: "Work",
          threadKeys: new Set<string>(),
          attention: false,
          working: false,
        },
        unread: false,
        needsYou: 0,
      },
    ],
    selected: "",
    onSelect: select,
    onCreate: vi.fn(),
    onContextMenu: menu,
    home: { unread: false, needsYou: 0 },
    dropTarget: null,
    ref: null,
    canCreate: true,
  };
  await act(() => root.render(<DiscordServerRail {...props} />));
  const servers = [...container.querySelectorAll<HTMLButtonElement>("button[data-server]")];
  expect(servers.map((server) => server.getAttribute("aria-label"))).toEqual([
    "Home",
    "Work",
    "Terminal",
  ]);
  const terminal = servers.at(-1)!;
  expect(terminal.hasAttribute("data-chat-tab-drop")).toBe(false);
  await act(() => terminal.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true })));
  expect(menu).not.toHaveBeenCalled();
  await act(() => terminal.click());
  expect(select).toHaveBeenCalledWith(CLAUDE_RC_TAB);
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});
