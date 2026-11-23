// @vitest-environment jsdom
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

import { useModelListSelection } from "./modelOptions";

it("keeps the model list's selection when only its options change", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const seen: Array<ModelSelection | null> = [];
  function Probe(props: { readonly selection: ModelSelection }) {
    seen.push(useModelListSelection(props.selection));
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const instanceId = ProviderInstanceId.make("codex");
  const high = { instanceId, model: "gpt", options: [{ id: "effort", value: "high" }] };
  const low = { instanceId, model: "gpt", options: [{ id: "effort", value: "low" }] };
  const other = { instanceId, model: "gpt-mini" };
  await act(async () => root.render(createElement(Probe, { selection: high })));
  await act(async () => root.render(createElement(Probe, { selection: low })));
  await act(async () => root.render(createElement(Probe, { selection: other })));
  expect(seen[1]).toBe(seen[0]);
  expect(seen[2]).toBe(other);
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});
