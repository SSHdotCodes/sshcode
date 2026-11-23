// @vitest-environment jsdom
import {
  EnvironmentId,
  ProviderInstanceId,
  type OrchestrationV2ThreadProjection,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import {
  modelManagerTestProjection,
  modelManagerTestQuestion,
  modelManagerTestThreadId,
} from "../../../../../packages/client-runtime/src/modelManagerBoxTestFixtures";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  request: vi.fn(async (_input: unknown) => ({
    _tag: "Success" as const,
    value: { threadId: "models:saved", delivery: "started" as const, runId: "models-run" },
  })),
  projection: null as OrchestrationV2ThreadProjection | null,
  helper: null as ScopedThreadRef | null,
  answer: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Pressable: ({
    children,
    accessibilityLabel,
    onPress,
    disabled,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
  }) => (
    <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
      {children}
    </button>
  ),
  TextInput: (props: {
    accessibilityLabel?: string;
    value: string;
    onChangeText: (text: string) => void;
  }) => (
    <input
      aria-label={props.accessibilityLabel}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/AppActivityIndicator", () => ({ AppActivityIndicator: () => null }));
vi.mock("../../components/ControlPillMenu", () => ({
  ControlPillMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => harness.helper }));
vi.mock("../../state/server", () => ({
  serverEnvironment: { requestModelChange: { kind: "request" } },
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../../state/threads", () => ({
  environmentThreadShells: { modelManagerThreadRefAtom: () => ({}) },
  threadEnvironment: { respondToApproval: {}, respondToUserInput: {} },
  useEnvironmentThread: () => ({
    data: harness.projection ? Option.some(harness.projection) : Option.none(),
    error: Option.none(),
    status: "live",
  }),
}));
vi.mock("./SecretRequestCard", () => ({ SecretRequestCard: () => <div>Private key request</div> }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind?: string }) =>
    command.kind === "request" ? harness.request : harness.answer,
}));

import { ModelManagerCard } from "./ModelManagerCard";

let host: HTMLDivElement;
let root: Root;
const environmentId = EnvironmentId.make("local");
const harnesses = [
  {
    instanceId: ProviderInstanceId.make("codex"),
    driver: "codex",
    enabled: true,
    label: "Codex",
  },
  {
    instanceId: ProviderInstanceId.make("opencode"),
    driver: "opencode",
    enabled: true,
    label: "OpenCode",
  },
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  harness.projection = modelManagerTestProjection();
  harness.helper = null;
  harness.answer.mockResolvedValue({ _tag: "Success" });
  host = document.createElement("div");
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function buttonNamed(text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(text),
  );
  if (!button) throw new Error(`No button "${text}" in: ${host.textContent}`);
  return button;
}

it("adds a searched model to the general harness and follows the Models chat", async () => {
  const render = () =>
    root.render(
      <ModelManagerCard
        environmentId={environmentId}
        harnesses={harnesses}
        browsingInstanceId={null}
        searchedModel={{
          ref: { source: "openrouter", id: "tencent/hy4" },
          query: "https://openrouter.ai/tencent/hy4",
        }}
      />,
    );
  act(render);
  expect(host.textContent).toContain("No harness lists tencent/hy4 yet.");
  expect(host.textContent).toContain("OpenCode");

  await act(async () => buttonNamed("Add tencent/hy4").click());
  expect(harness.request).toHaveBeenCalledWith({
    environmentId,
    input: {
      text: "Add https://openrouter.ai/tencent/hy4",
      instanceId: "opencode",
    },
  });
  expect(host.textContent).toContain("Checking the config");
  expect(host.textContent).toContain("Running cat opencode.json");
  expect(host.textContent).not.toContain("Open chat");

  const input = host.querySelector<HTMLInputElement>('input[aria-label="Reply to Models"]')!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(
      input,
      "remove hy4",
    );
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => buttonNamed("Send").click());
  expect(harness.request).toHaveBeenLastCalledWith({
    environmentId,
    input: { text: "remove hy4", instanceId: "opencode" },
  });
  harness.projection = modelManagerTestProjection("completed");
  act(render);
  expect(host.textContent).toContain("Done. Models refresh in a moment.");
  expect(host.textContent).not.toContain("Running cat");
});

it("sends a typed removal to the picked harness", async () => {
  act(() =>
    root.render(
      <ModelManagerCard
        environmentId={environmentId}
        harnesses={harnesses}
        browsingInstanceId="codex"
        searchedModel={null}
      />,
    ),
  );
  act(() => buttonNamed("Add or remove models").click());
  const input = host.querySelector("input")!;
  act(() => {
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, "remove hy4");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => buttonNamed("Go").click());
  expect(harness.request).toHaveBeenCalledWith({
    environmentId,
    input: { text: "remove hy4", instanceId: "codex" },
  });
});

it("restores the helper and answers its question inside the phone card", async () => {
  harness.helper = { environmentId, threadId: modelManagerTestThreadId };
  harness.projection = modelManagerTestQuestion();
  act(() =>
    root.render(
      <ModelManagerCard
        environmentId={environmentId}
        harnesses={harnesses}
        browsingInstanceId={null}
        searchedModel={null}
      />,
    ),
  );
  expect(host.textContent).toContain("Enable this model?");
  expect(buttonNamed("Answer").disabled).toBe(true);
  act(() => buttonNamed("Enable").click());
  await act(async () => buttonNamed("Answer").click());
  expect(harness.answer).toHaveBeenCalledWith({
    environmentId,
    input: {
      threadId: modelManagerTestThreadId,
      requestId: "models-question",
      answers: { next: "enable-id" },
    },
  });
});
