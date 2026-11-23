// @vitest-environment jsdom
import { ProviderDriverKind } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ModelPickerRunsIn, type ModelPickerRunsInRoute } from "./ModelPickerRunsIn";

let root: Root;
let container: HTMLDivElement;
const pick = vi.fn();
const setup = vi.fn();
const route = (
  key: string,
  selected = false,
  disabledReason: string | null = null,
): ModelPickerRunsInRoute => ({
  key,
  label: key,
  selected,
  disabledReason,
  driverKind: ProviderDriverKind.make("codex"),
  displayName: "Codex",
});
function render(routes: ModelPickerRunsInRoute[], withSetup = false) {
  act(() =>
    root.render(
      <ModelPickerRunsIn
        modelName="Test"
        routes={routes}
        onPick={pick}
        {...(withSetup ? { onOpenSetup: setup } : {})}
      />,
    ),
  );
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    value: vi.fn(),
    configurable: true,
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete (Element.prototype as Partial<Element>).scrollIntoView;
  vi.unstubAllGlobals();
});

it("enters at the first enabled route when the selected route is blocked", () => {
  render([route("blocked", true, "Unavailable"), route("first"), route("second")]);
  const entry = container.querySelector<HTMLButtonElement>('[role="radio"][tabindex="0"]')!;
  expect(entry?.textContent).toContain("first");
  entry.focus();
  act(() =>
    entry.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    ),
  );
  expect(document.activeElement?.textContent).toContain("second");
  act(() => (document.activeElement as HTMLButtonElement).click());
  expect(pick).toHaveBeenCalledExactlyOnceWith("second");
});

it("keeps the selected enabled route as the only tab stop", () => {
  render([route("first"), route("selected", true)]);
  const entries = container.querySelectorAll<HTMLButtonElement>('[role="radio"][tabindex="0"]');
  expect(entries).toHaveLength(1);
  entries[0]!.focus();
  expect(document.activeElement?.textContent).toContain("selected");
});

it("lets a selected setup route remain keyboard reachable", () => {
  render([{ ...route("setup", true, "Sign in"), canOpenSetup: true }, route("first")], true);
  const entry = container.querySelector<HTMLButtonElement>('[role="radio"][tabindex="0"]')!;
  expect(entry.disabled).toBe(false);
  act(() => entry.click());
  expect(setup).toHaveBeenCalledExactlyOnceWith("setup");
});

it("shows what each of the user's accounts has left and where new chats start", () => {
  act(() =>
    root.render(
      <ModelPickerRunsIn
        modelName="Test"
        routes={[
          { ...route("Max 1"), room: "6% left" },
          { ...route("Max 2", true), room: "93% left" },
          route("OpenCode"),
        ]}
        onPick={pick}
        note="New chats start on Max 2: it has the most left to use before its reset."
      />,
    ),
  );
  const rows = [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  expect(rows.map((row) => row.textContent)).toEqual(["Max 16% left", "Max 293% left", "OpenCode"]);
  expect(container.querySelector("[data-model-picker-account-note]")?.textContent).toBe(
    "New chats start on Max 2: it has the most left to use before its reset.",
  );
  act(() => rows[0]!.click());
  expect(pick).toHaveBeenCalledWith("Max 1");
});

it("keeps an account's name on a line of its own, with what it has left under it", () => {
  act(() =>
    root.render(
      <ModelPickerRunsIn
        modelName="Test"
        routes={[
          { ...route("Home"), room: "51% left · resets Mon" },
          { ...route("Work", true), room: "97% left · resets Nov 24" },
        ]}
        onPick={pick}
      />,
    ),
  );
  for (const row of container.querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
    const name = row.querySelector("[data-model-picker-route-name]")!;
    const room = row.querySelector("[data-model-picker-route-room]")!;
    // Beside the name, a long reading squeezed the account name down to "…" or to nothing.
    expect(name.textContent).toMatch(/^(Home|Work)$/);
    expect(room.parentElement).toBe(row);
    expect(name.parentElement).not.toBe(row);
    expect(name.parentElement!.contains(room)).toBe(false);
  }
});

it("has no account note without one", () => {
  render([route("first", true), route("second")]);
  expect(container.querySelector("[data-model-picker-account-note]")).toBeNull();
});
