// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { CasualVoiceControl } from "./CasualVoiceControl";

const configure = vi.fn(async () => true);
const thinkingLevel = {
  id: "thinkingLevel",
  label: "Thinking level",
  type: "select" as const,
  options: [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High", isDefault: true },
  ],
};
const models = [
  { instanceId: "fake", model: "first", name: "First model", optionDescriptors: [thinkingLevel] },
  { instanceId: "fake", model: "second", name: "Second model", optionDescriptors: [thinkingLevel] },
];
let mode = "hybrid";
vi.mock("./useCasualVoice", () => ({
  useCasualVoice: () => ({
    state: {
      enabled: true,
      backend: { kind: "local", url: "http://127.0.0.1:9/v1/", model: "local-model" },
      cloudBackend: {
        kind: "provider",
        modelSelection: {
          instanceId: ProviderInstanceId.make("fake"),
          model: "first",
        },
      },
      mode,
      saveTraining: true,
      models,
    },
    configure,
    allowed: true,
    backendAllowed: true,
    refresh: vi.fn(),
  }),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  mode = "hybrid";
  configure.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("renders the mode, changes it, and picks a cloud model at medium effort", async () => {
  await act(async () =>
    root.render(
      createElement(CasualVoiceControl, {
        environmentId: EnvironmentId.make("primary"),
        threadId: ThreadId.make("chat"),
      }),
    ),
  );
  expect(host.textContent).toContain("Steer replies use the cloud model.");
  expect(host.textContent).toContain("save cloud rewrites for training");
  const modeSelect = host.querySelector('[aria-label="Casual voice mode"]') as HTMLSelectElement;
  expect(modeSelect.value).toBe("hybrid");
  await act(async () => {
    modeSelect.value = "cloud";
    modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(configure).toHaveBeenCalledWith({ mode: "cloud" });
  mode = "cloud";
  await act(async () =>
    root.render(
      createElement(CasualVoiceControl, {
        environmentId: EnvironmentId.make("primary"),
        threadId: ThreadId.make("chat"),
      }),
    ),
  );
  expect(host.textContent).toContain("This sends your style examples to the cloud provider.");
  const modelSelect = host.querySelector('[aria-label="Cloud model"]') as HTMLSelectElement;
  const effortSelect = host.querySelector('[aria-label="Cloud effort"]') as HTMLSelectElement;
  expect(effortSelect.value).toBe("medium");
  await act(async () => {
    modelSelect.value = JSON.stringify(["fake", "second"]);
    modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(configure).toHaveBeenCalledWith({
    cloudBackend: {
      kind: "provider",
      styleFile: "",
      modelSelection: {
        instanceId: ProviderInstanceId.make("fake"),
        model: "second",
        options: [{ id: "thinkingLevel", value: "medium" }],
      },
    },
  });
});
