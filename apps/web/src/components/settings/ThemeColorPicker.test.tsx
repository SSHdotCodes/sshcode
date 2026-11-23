// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ThemeColorField } from "./ThemeColorPicker";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
it.each(["#11223380", "oklch(30% 0 0 / 50%)"])(
  "preserves alpha when editing the hex field for %s",
  async (value) => {
    const change = vi.fn();
    act(() => root.render(<ThemeColorField role="canvas" value={value} onChange={change} />));
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Choose Background color"]')!.click(),
    );
    const input = document.querySelector<HTMLInputElement>(
      '[aria-label="Background picker hex value"]',
    )!;
    expect(input).not.toBeNull();
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
        input,
        "#ABCDEF",
      );
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(change).toHaveBeenLastCalledWith("canvas", "#abcdef80");
  },
);
