// @vitest-environment jsdom
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { ComposerModelControl } from "./ComposerModelControl";
import { useModelListSelection } from "../lib/modelOptions";

vi.mock("react-native", () => ({
  View: (props: { children?: React.ReactNode }) => <span>{props.children}</span>,
}));
vi.mock("./ComposerToolbar", () => ({
  ComposerInlineControl: (props: {
    label: string;
    accessibilityLabel: string;
    trailingAccessory?: React.ReactNode;
  }) => (
    <button aria-label={props.accessibilityLabel}>
      {props.label}
      {props.trailingAccessory}
    </button>
  ),
}));
vi.mock("./FastModeBolt", () => ({ FastModeBolt: () => null }));
vi.mock("./EffortGauge", () => ({ EffortGauge: () => null }));

it("updates an open phone's model selector selection and composer label after a Mac pick", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  const root = createRoot(host);
  const instanceId = ProviderInstanceId.make("claudeAgent");
  const phoneChoice: ModelSelection = { instanceId, model: "claude-fable-5-2" };
  const macChoice: ModelSelection = {
    instanceId,
    model: "claude-opus-5-5",
    options: [{ id: "effort", value: "high" }],
  };
  let pickerSelection: ModelSelection | null = null;
  const capabilities = {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select" as const,
        currentValue: "medium",
        options: [
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
        ],
      },
    ],
  };
  function Probe(props: { selection: ModelSelection; label: string }) {
    // Both the real settings sheet and composer build their picker around this hook.
    const selection = useModelListSelection(props.selection);
    useLayoutEffect(() => {
      pickerSelection = selection;
    }, [selection]);
    return (
      <ComposerModelControl
        capabilities={capabilities}
        selection={props.selection}
        label={props.label}
        onPress={() => {}}
      />
    );
  }
  try {
    act(() => root.render(<Probe selection={phoneChoice} label="Claude Fable 5.2" />));
    expect(pickerSelection).toBe(phoneChoice);
    expect(host.textContent).toContain("Fable 5.2");
    // Update the mounted component, without navigating, remounting, or sending.
    act(() => root.render(<Probe selection={macChoice} label="Claude Opus 5.5" />));
    expect(pickerSelection).toBe(macChoice);
    expect(host.textContent).toBe("Opus 5.5");
    expect(host.querySelector("button")?.getAttribute("aria-label")).toContain(
      "Opus 5.5, Effort: High",
    );
    expect(host.textContent).not.toContain("Fable");
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
