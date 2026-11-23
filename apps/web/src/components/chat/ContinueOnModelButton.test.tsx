// @vitest-environment jsdom
import { ProviderInstanceId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { ContinueOnModelButton } from "./ContinueOnModelButton";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const claude = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
  label: "Claude Opus 5.5",
  providerLabel: "Claude",
};
const grok = {
  instanceId: ProviderInstanceId.make("grok_grok_build"),
  model: "grok-4.7",
  label: "Grok 4.7",
  providerLabel: "Grok Build",
};

it("continues on the first choice in one click and offers the rest", () => {
  const onContinue = vi.fn();
  act(() =>
    root.render(
      <ContinueOnModelButton candidates={[claude, grok]} busy={false} onContinue={onContinue} />,
    ),
  );
  const primary = [...host.querySelectorAll("button")].find((button) =>
    button.textContent?.includes("Continue on Claude Opus 5.5"),
  );
  expect(primary).toBeDefined();
  act(() => primary!.click());
  expect(onContinue).toHaveBeenCalledWith(claude);
  expect(host.querySelector('[aria-label="Continue on another model"]')).not.toBeNull();
});

it("shows progress and blocks a second send while continuing", () => {
  const onContinue = vi.fn();
  act(() =>
    root.render(<ContinueOnModelButton candidates={[claude]} busy onContinue={onContinue} />),
  );
  const primary = host.querySelector("button")!;
  expect(primary.textContent).toBe("Continuing…");
  expect(primary.disabled).toBe(true);
  expect(host.querySelector('[aria-label="Continue on another model"]')).toBeNull();
});

it("renders nothing without a choice", () => {
  act(() =>
    root.render(<ContinueOnModelButton candidates={[]} busy={false} onContinue={vi.fn()} />),
  );
  expect(host.innerHTML).toBe("");
});
