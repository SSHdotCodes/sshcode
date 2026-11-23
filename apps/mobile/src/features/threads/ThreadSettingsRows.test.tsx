// @vitest-environment jsdom
import { act, createElement, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { ProviderInstanceId } from "@t3tools/contracts";

vi.mock("react-native", () => ({
  View: (props: { children?: ReactNode; className?: string }) =>
    createElement("div", { className: props.className }, props.children),
  Pressable: (props: {
    children?: ReactNode;
    className?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    accessibilityState?: { checked?: boolean };
    onPress?: () => void;
    disabled?: boolean;
  }) =>
    createElement(
      "button",
      {
        className: props.className,
        role: props.accessibilityRole,
        "aria-label": props.accessibilityLabel,
        "aria-checked": props.accessibilityState?.checked,
        onClick: props.onPress,
        disabled: props.disabled,
      },
      props.children,
    ),
}));
vi.mock("../../components/AppText", () => ({
  AppText: (props: { children?: ReactNode; numberOfLines?: number }) =>
    createElement("span", { "data-lines": props.numberOfLines }, props.children),
}));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));

import { ModelRow } from "./ThreadSettingsRows";
import type { ModelOption } from "../../lib/modelOptions";

const option: ModelOption = {
  key: "codex:long-model",
  label: "A model with a long and unambiguous display name",
  subtitle: "Provider account with more detail",
  providerKey: "codex",
  providerLabel: "Codex",
  providerDriver: "codex",
  isDefault: true,
  isLegacy: true,
  capabilities: null,
  selection: { instanceId: ProviderInstanceId.make("codex"), model: "long-model" },
};
let root: Root;
let container: HTMLDivElement;
function Probe({ credit = false }: { credit?: boolean }) {
  const [selected, setSelected] = useState(false);
  return (
    <ModelRow
      option={
        credit
          ? {
              ...option,
              providerRecentFailure: {
                kind: "billing_error",
                outOfCredit: true,
                occurredAt: "2026-11-03T20:00:00.000Z",
                message: "Budget exhausted.",
              },
            }
          : option
      }
      selected={selected}
      onPress={() => setSelected(true)}
      isFavorite={false}
      favoritesLoaded
      onToggleFavorite={() => {}}
      isFirst
      isLast
    />
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  act(() => root.render(<Probe />));
});
afterEach(() => act(() => root.unmount()));

describe("iPhone model rows", () => {
  it("highlights a tapped row and exposes its selection to VoiceOver", () => {
    const row = container.querySelector('[role="radio"]')!;
    expect(row.getAttribute("aria-checked")).toBe("false");
    expect(row.parentElement?.className).not.toContain("bg-secondary");
    act(() => row.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(row.getAttribute("aria-checked")).toBe("true");
    expect(row.parentElement?.className).toContain("bg-secondary");
  });

  it("gives long names two lines and moves badges out of the title line", () => {
    const title = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === option.label,
    )!;
    const badge = [...container.querySelectorAll("span")].find(
      (span) => span.textContent === "Default",
    )!;
    expect(title.dataset.lines).toBe("2");
    expect(title.parentElement).toBe(badge.parentElement?.parentElement?.parentElement);
    expect(badge.parentElement?.parentElement?.className).toContain("flex-wrap");
    expect(container.querySelector('[role="radio"]')?.getAttribute("aria-label")).toContain(
      option.label,
    );
  });
});

it("shows remembered credit exhaustion while keeping the phone model selectable", () => {
  act(() => root.render(<Probe credit />));
  expect(container.textContent).toContain("Out of credit since");
  expect(container.textContent).toContain(": Budget exhausted.");
  const row = container.querySelector<HTMLButtonElement>('[role="radio"]')!;
  expect(row.disabled).toBe(false);
  act(() => row.click());
  expect(row.getAttribute("aria-checked")).toBe("true");
});
