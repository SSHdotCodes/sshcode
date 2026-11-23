// @vitest-environment jsdom
import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ChatColumn } from "./ChatColumn";

let root: Root;
let container: HTMLDivElement;
function Layout({ maximized, showInput = true }: { maximized: boolean; showInput?: boolean }) {
  const panelRef = useRef<HTMLDivElement>(null);
  return (
    <>
      <ChatColumn maximized={maximized} panelRef={panelRef}>
        {showInput ? <input aria-label="Composer" /> : null}
      </ChatColumn>
      <div ref={panelRef} tabIndex={-1}>
        <div data-active-tab="true">
          <button data-right-panel-activate-tab>Browser</button>
        </div>
      </div>
    </>
  );
}
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

it("makes the collapsed chat inert, focuses the panel, and restores the composer", () => {
  act(() => root.render(<Layout maximized={false} />));
  const composer = container.querySelector("input")!;
  composer.focus();
  act(() => root.render(<Layout maximized />));
  expect(container.querySelector("[data-chat-column-maximized-away]")!.hasAttribute("inert")).toBe(
    true,
  );
  expect(document.activeElement).toBe(container.querySelector("[data-right-panel-activate-tab]"));
  act(() => root.render(<Layout maximized={false} />));
  expect(container.querySelector("[data-chat-column-maximized-away]")!.hasAttribute("inert")).toBe(
    false,
  );
  expect(document.activeElement).toBe(composer);
});

it("can restore focus when the original control was removed while maximized", () => {
  act(() => root.render(<Layout maximized={false} />));
  container.querySelector("input")!.focus();
  act(() => root.render(<Layout maximized />));
  act(() => root.render(<Layout maximized={false} showInput={false} />));
  expect(document.activeElement).toBe(container.querySelector("[data-chat-column-maximized-away]"));
});

it("focuses the panel when the chat initially mounts maximized", () => {
  act(() => root.render(<Layout maximized />));
  expect(document.activeElement).toBe(container.querySelector("[data-right-panel-activate-tab]"));
});
