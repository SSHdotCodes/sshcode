// @vitest-environment jsdom
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { ExistingThreadSettingsRouteSession } from "./ThreadSettingsSheet";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import { AgentsFooter, NewSubagentForm } from "./NewSubagentForm";

const state = vi.hoisted(() => ({
  session: null as ExistingThreadSettingsRouteSession | null,
  config: new Map<string, { providers: never[]; settings?: unknown }>([["env", { providers: [] }]]),
  shell: { latestRun: null, subagentsEnabled: false },
  canOperate: true,
  command: vi.fn(async () => ({ _tag: "Success" })),
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "shell" ? state.shell : atom === "config" ? state.config : null,
}));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => state.canOperate }));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: () => "detail" },
  threadEnvironment: { startSubagent: "start" },
  environmentThreadShells: { threadShellAtom: () => "shell" },
}));
vi.mock("../../state/server", () => ({
  environmentServerConfigsAtom: "config",
  serverEnvironment: { chatControlsCommand: "controls" },
}));
vi.mock("../../state/atom-registry", () => ({ appAtomRegistry: { get: () => [] } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.command }));
vi.mock("./ThreadSettingsSheet", () => {
  const presentation = {
    present: (session: ExistingThreadSettingsRouteSession) => {
      state.session = session;
    },
    clear: (owner: string) => {
      if (state.session?.ownerId === owner) state.session = null;
    },
  };
  return { useExistingThreadSettingsRoutePresentation: () => presentation };
});
vi.mock("../../lib/useCoarseNow", () => ({ useCoarseNow: () => 0 }));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => [],
  groupByProvider: () => [],
}));
vi.mock("./newSubagentModels", () => ({
  newSubagentCandidates: () => [{ selection: { instanceId: "auto", model: "default" } }],
}));
vi.mock("../../lib/providerOptions", () => ({
  modelTraits: () => ({}),
  resolveProviderOptionDescriptors: () => [],
}));
vi.mock("@react-navigation/native", async () => {
  const { useEffect } = await import("react");
  return {
    StackActions: { push: () => ({}) },
    useFocusEffect: (onFocus: () => void) => useEffect(onFocus, [onFocus]),
    useNavigation: () => ({ dispatch: () => {} }),
  };
});
vi.mock("react-native", () => ({
  Keyboard: { dismiss: () => {} },
  View: "div",
  ScrollView: ({ children }: { children: ReactNode }) => children,
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children: ReactNode;
    onPress: () => void;
    accessibilityLabel: string;
  }) => (
    <button aria-label={accessibilityLabel} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("expo-haptics", () => ({ selectionAsync: () => {} }));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("react-native-keyboard-controller", () => ({ useKeyboardState: () => false }));
vi.mock("../../components/AppText", () => ({ AppText: "span", AppTextInput: () => null }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ControlPill", () => ({ ControlPill: () => null }));
vi.mock("../../components/FastModeBolt", () => ({ FastModeBolt: () => null }));
vi.mock("../../components/ListRowLayout", () => ({ ListRowLayout: () => null }));
vi.mock("../../components/ListSection", () => ({
  ListSection: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/ThemedSwitch", () => ({
  ThemedSwitch: ({
    value,
    disabled,
    onValueChange,
  }: {
    value: boolean;
    disabled?: boolean;
    onValueChange: (value: boolean) => void;
  }) => (
    <button
      role="switch"
      aria-checked={value}
      disabled={disabled}
      onClick={() => onValueChange(!value)}
    />
  ),
}));

it("follows another device turning subagents off after this phone turned them on", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = (enabled: boolean) =>
    act(() => {
      state.shell = { latestRun: null, subagentsEnabled: enabled };
      root.render(
        <AgentsFooter
          environmentId={EnvironmentId.make("env")}
          threadId={ThreadId.make("thread")}
          onNewSubagent={() => {}}
        />,
      );
    });
  try {
    render(false);
    const toggle = container.querySelector("button")!;
    await act(async () => toggle.click());
    expect(state.command).toHaveBeenCalledOnce();
    render(true);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    render(false);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
  } finally {
    act(() => root.unmount());
  }
});

it("shows the switch off and locked while Settings > Agents has subagents at None", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  state.shell = { latestRun: null, subagentsEnabled: true };
  state.config = new Map([
    ["env", { providers: [], settings: { agentBehavior: { subagents: "none" } } }],
  ]);
  state.command.mockClear();
  try {
    act(() =>
      root.render(
        <AgentsFooter
          environmentId={EnvironmentId.make("env")}
          threadId={ThreadId.make("thread")}
          onNewSubagent={() => {}}
        />,
      ),
    );
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.textContent).toContain("Off in Settings › Agents");
    await act(async () => toggle.click());
    expect(state.command).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
    state.config = new Map([["env", { providers: [] }]]);
  }
});

it("leaves read-only connections without a control that promises to change the chat", () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  state.canOperate = false;
  try {
    act(() =>
      root.render(
        <AgentsFooter
          environmentId={EnvironmentId.make("env")}
          threadId={ThreadId.make("thread")}
          onNewSubagent={() => {}}
        />,
      ),
    );
    expect(container.querySelector('[role="switch"]')).toBeNull();
  } finally {
    act(() => root.unmount());
    state.canOperate = true;
  }
});

function openModelPicker() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  const root = createRoot(container);
  act(() =>
    root.render(
      <NewSubagentForm
        environmentId={EnvironmentId.make("env")}
        threadId={ThreadId.make("thread")}
        onClose={() => {}}
      />,
    ),
  );
  act(() => container.querySelector<HTMLButtonElement>('button[aria-label^="Model:"]')!.click());
  return root;
}

it("releases the active picker when navigation removes its form", () => {
  const root = openModelPicker();
  expect(state.session?.selectedModel?.model).toBe("default");
  act(() => root.unmount());
  expect(state.session).toBeNull();
});

it("keeps the named account and its model options when the subagent picker reopens", () => {
  const root = openModelPicker();
  const instanceId = ProviderInstanceId.make("second-account");
  const selection = { instanceId, model: "picked", options: [{ id: "effort", value: "high" }] };
  try {
    act(() =>
      state.session!.onSelectModel(
        {
          key: "second-account:picked",
          label: "Picked",
          subtitle: "",
          providerKey: instanceId,
          providerLabel: "Second account",
          providerDriver: "codex",
          isDefault: false,
          isLegacy: false,
          capabilities: null,
          selection,
        },
        true,
      ),
    );
    act(() =>
      state.session!.onUpdateOptionSelections([...selection.options, { id: "fast", value: true }]),
    );
    expect(state.session).toMatchObject({
      accountPinned: true,
      selectedModel: { ...selection, options: [...selection.options, { id: "fast", value: true }] },
    });
  } finally {
    act(() => root.unmount());
  }
});
