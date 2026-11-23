// @vitest-environment jsdom

import { ProviderInstanceId } from "@t3tools/contracts";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ComposerAddMenu } from "./ComposerAddMenu";
import { ProviderModelPicker } from "./ProviderModelPicker";

vi.mock("./ModelPickerContent", () => ({
  resolveModelPickerSelectedModel: () => undefined,
  ModelPickerContent: () => <input aria-label="Search models" autoFocus />,
}));
vi.mock("./ChatGptSharingControl", () => ({ ChatGptSharingControl: () => null }));

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function ComposerControls() {
  const [comparing, setComparing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const instanceId = ProviderInstanceId.make("codex");
  return (
    <>
      <ComposerAddMenu
        showAttachFiles
        comparisonEnabled={comparing}
        comparisonDisabled={false}
        onAttachFiles={() => {}}
        onComparisonChange={(enabled) => {
          setComparing(enabled);
          if (enabled) setPickerOpen(true);
        }}
      />
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model="gpt-6.1"
        lockedProvider={null}
        instanceEntries={[]}
        modelOptionsByInstance={new Map()}
        {...(comparing ? { selectedModels: [{ instanceId, model: "gpt-6.1" }] } : {})}
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onInstanceModelChange={() => {}}
      />
    </>
  );
}

function addTrigger() {
  return container.querySelector<HTMLButtonElement>('[aria-label="Add menu"]')!;
}

function menuItem(label: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent === label,
  );
  if (!item) throw new Error(`Missing menu item: ${label}`);
  return item;
}

async function key(element: HTMLElement, value: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: value, bubbles: true }));
    element.dispatchEvent(new KeyboardEvent("keyup", { key: value, bubbles: true }));
  });
}

describe("ComposerAddMenu", () => {
  it.each(["keyboard", "pointer"])(
    "hands focus to the comparison picker after %s activation and lets it be turned off",
    async (interaction) => {
      await act(async () => root.render(<ComposerControls />));
      await act(async () => addTrigger().focus());
      if (interaction === "keyboard") {
        await key(addTrigger(), "ArrowDown");
        await key(menuItem("Attach files"), "ArrowDown");
        expect(document.activeElement).toBe(menuItem("Compare models"));
        await key(menuItem("Compare models"), "Enter");
      } else {
        await act(async () => addTrigger().click());
        await act(async () => menuItem("Compare models").click());
      }

      const search = document.querySelector<HTMLInputElement>('[aria-label="Search models"]');
      expect(search).not.toBeNull();
      expect(document.activeElement).toBe(search);
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(container.textContent).toContain("Compare: gpt-6.1");

      await key(search!, "Escape");
      await act(async () => addTrigger().click());
      await act(async () => menuItem("Stop comparing").click());
      expect(container.textContent).not.toContain("Compare:");
      expect(document.activeElement).toBe(addTrigger());
    },
  );
});

it("offers an existing chat's switch in a Quest thread panel and leaves it in Agents on desktop", async () => {
  const change = vi.fn();
  const menu = (key: string) => (
    <ComposerAddMenu
      key={key}
      existingThread
      showAttachFiles={false}
      comparisonEnabled={false}
      comparisonDisabled={false}
      onAttachFiles={() => {}}
      onComparisonChange={() => {}}
      subagentsEnabled={false}
      onSubagentsChange={change}
    />
  );
  const switchItem = () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')].find((item) =>
      item.textContent?.includes("Subagents"),
    );
  await act(async () => root.render(menu("desktop")));
  await act(async () => addTrigger().click());
  expect(switchItem()).toBeUndefined();
  window.history.replaceState(null, "", "?sshcodePanel=thread");
  try {
    await act(async () => root.render(menu("quest")));
    await act(async () => addTrigger().click());
    await act(async () => switchItem()!.click());
    expect(change).toHaveBeenCalledWith(true);
  } finally {
    window.history.replaceState(null, "", "/");
    window.sessionStorage.removeItem("sshcodePanel");
  }
});
