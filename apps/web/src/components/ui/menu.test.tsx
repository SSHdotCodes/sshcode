// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { closeOpenMenus, Menu, MenuItem, MenuPopup, MenuTrigger } from "./menu";

describe("Menu navigation lifecycle", () => {
  let renderer: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    renderer = createRoot(container);
    await act(() => {
      renderer.render(
        <Menu defaultOpen>
          <MenuTrigger>Open</MenuTrigger>
          <MenuPopup>
            <MenuItem>Item</MenuItem>
          </MenuPopup>
        </Menu>,
      );
    });
  });

  afterEach(async () => {
    await act(() => renderer.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("closes when the app navigates programmatically", async () => {
    const trigger = container.querySelector<HTMLButtonElement>('[data-slot="menu-trigger"]')!;
    expect(document.querySelector('[role="menu"]')).not.toBeNull();

    await act(() => closeOpenMenus());

    expect(document.querySelector('[role="menu"]')).toBeNull();
  });
});
