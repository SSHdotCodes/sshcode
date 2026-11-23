// @vitest-environment jsdom
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ThreadErrorBanner } from "./ThreadErrorBanner";
import { ProviderStatusBanner } from "./ProviderStatusBanner";

let root: Root;
let container: HTMLDivElement;
const error = "The provider disconnected.\n" + "Details for troubleshooting. ".repeat(20);
const status: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "error",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-08T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  message: error,
};
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
it.each(["thread", "provider"])(
  "lets keyboard users expand and select the full %s error",
  (kind) => {
    act(() =>
      root.render(
        kind === "thread" ? (
          <ThreadErrorBanner error={error} />
        ) : (
          <ProviderStatusBanner status={status} onDismiss={() => {}} />
        ),
      ),
    );
    const toggle = [...container.querySelectorAll("button")].find(
      (node) => node.textContent === "Show full error",
    )!;
    expect(toggle).toBeDefined();
    toggle.focus();
    expect(document.activeElement).toBe(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle.click());
    const text = document.getElementById(toggle.getAttribute("aria-controls")!)!;
    expect(text.textContent).toBe(error);
    expect(text.classList.contains("line-clamp-3")).toBe(false);
    const range = document.createRange();
    range.selectNodeContents(text);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    expect(window.getSelection()!.toString()).toBe(error);
    act(() => toggle.click());
    expect(text.classList.contains("line-clamp-3")).toBe(true);
  },
);
