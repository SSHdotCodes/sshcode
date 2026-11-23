// @vitest-environment jsdom
import { ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("./ModelPickerContent", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ModelPickerContent")>()),
  ModelPickerContent: () => (
    <div>
      <div data-model-picker-content>
        <div data-scroll-region="models" />
      </div>
      <div data-model-picker-side>
        <div data-scroll-region="routes" />
        <div data-scroll-region="reasoning" />
      </div>
    </div>
  ),
}));
import { ProviderModelPicker } from "./ProviderModelPicker";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root.render(
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={ProviderInstanceId.make("codex")}
        model="test"
        lockedProvider={null}
        instanceEntries={[]}
        modelOptionsByInstance={new Map()}
        onInstanceModelChange={() => {}}
        open
      />,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("excludes the open model picker from Electron window dragging", () => {
  const popup = document.querySelector("[data-model-picker-popup]");
  expect(popup?.classList.contains("[-webkit-app-region:no-drag]")).toBe(true);
});

it.each(["wheel", "touchmove"])(
  "allows %s in every picker column but blocks the background",
  (type) => {
    for (const region of ["models", "routes", "reasoning"]) {
      const target = document.querySelector(`[data-scroll-region="${region}"]`)!;
      expect(target).not.toBeNull();
      const event = new Event(type, { bubbles: true, cancelable: true });
      target.dispatchEvent(event);
      expect(event.defaultPrevented, region).toBe(false);
    }
    const background = new Event(type, { bubbles: true, cancelable: true });
    document.body.dispatchEvent(background);
    expect(background.defaultPrevented).toBe(true);
  },
);
