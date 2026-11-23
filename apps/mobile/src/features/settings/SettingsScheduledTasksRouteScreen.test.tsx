// @vitest-environment jsdom
import { RegistryContext } from "@effect/atom-react";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { Children, mocks } = vi.hoisted(() => ({
  Children: ({ children }: { children?: ReactNode }) => children,
  mocks: { platform: "ios", upsert: vi.fn(), alert: vi.fn(), tasks: [] as ScheduledTask[] },
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return mocks.platform;
    },
  },
  Alert: { alert: mocks.alert },
  AppState: { addEventListener: () => ({ remove: () => {} }) },
  View: Children,
  TextInput: () => null,
  Pressable: ({ children, onPress }: { children?: ReactNode; onPress: () => void }) => (
    <button onClick={onPress}>{children}</button>
  ),
}));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ isFocused: () => false, setOptions: () => {} }),
  useFocusEffect: () => {},
  usePreventRemove: () => {},
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@expo/ui/community/datetime-picker", () => ({
  DateTimePicker: ({
    onValueChange,
  }: {
    onValueChange: (event: object, selected: Date) => void;
  }) => (
    <button onClick={() => onValueChange({}, new Date(2026, 10, 21, 6, 30))}>Confirm time</button>
  ),
}));
vi.mock("../../components/AppText", () => ({ AppText: Children }));
vi.mock("../../components/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/EnvironmentMachineSymbol", () => ({
  EnvironmentMachineSymbol: () => null,
  ENVIRONMENT_MACHINE_SYMBOLS: {},
}));
vi.mock("../../components/ControlPill", () => ({
  ControlPillMenu: ({
    actions,
    onPressAction,
  }: {
    actions: readonly { id: string; title: string }[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
  }) =>
    actions.map(({ id, title }) => (
      <button key={id} onClick={() => onPressAction({ nativeEvent: { event: id } })}>
        Select {title}
      </button>
    )),
}));
vi.mock("../../components/ScreenScrollView", () => ({ ScreenScrollView: Children }));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: Children }));
vi.mock("./components/SettingsSection", () => ({ SettingsSection: Children }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  useSettingsEnvironmentMenu: () => null,
}));
vi.mock("./components/ScheduledTaskPromptField", () => ({ ScheduledTaskPromptField: () => null }));
vi.mock("../layout/workspace/useSelectWorkspaceDetail", () => ({
  useSelectWorkspaceDetail: () => vi.fn(),
}));
vi.mock("../../state/threads", () => ({ threadFamilies: {} }));
vi.mock("../../lib/copyTextWithHaptic", () => ({ tryCopyTextWithHaptic: vi.fn() }));
vi.mock("../voice-input/useVoiceInputController", () => ({
  useVoiceInputController: () => ({ blocksSubmission: false }),
}));
vi.mock("../../components/SegmentedControl", () => ({
  SegmentedControl: ({
    options,
    onSelect,
  }: {
    options: readonly { value: string; label: string }[];
    onSelect: (value: string) => void;
  }) =>
    options.map(({ value, label }) => (
      <button key={value} onClick={() => onSelect(value)}>
        {label}
      </button>
    )),
}));
vi.mock("../../components/ThemedSwitch", () => ({
  ThemedSwitch: ({
    value,
    onValueChange,
  }: {
    value: boolean;
    onValueChange: (value: boolean) => void;
  }) => <button onClick={() => onValueChange(!value)}>Toggle enabled</button>,
}));
vi.mock("../../state/entities", () => ({
  useProjects: () => [
    { environmentId: "environment", id: "project", title: "Project" },
    { environmentId: "target", id: "target-project", title: "Target project" },
  ],
  useServerConfigs: () => new Map(),
  useEnvironmentServerConfig: () => null,
  useThreadShell: () => null,
}));
vi.mock("./settings-environment-filter", () => ({
  useSettingsEnvironmentFilter: () => ({
    selectedTargets: [{ environmentId: "environment", label: "Environment" }],
    availableTargets: [
      { environmentId: "environment", label: "Environment" },
      { environmentId: "target", label: "Target" },
    ],
    selectedProjectKey: null,
    projectGroups: [],
  }),
}));
vi.mock("../../lib/modelOptions", () => ({
  buildModelOptions: () => [],
  resolveDefaultableModelSelection: () => null,
  resolveNewTaskModelSelection: () => null,
}));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => true,
  usePreparedConnection: () => ({ _tag: "None" }),
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    scheduledTasksLive: () => ({}),
    upsertScheduledTask: { permissionAtom: () => Atom.make(true) },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: { tasks: mocks.tasks, threads: [] } }),
}));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.upsert }));

import { appAtomRegistry } from "../../state/atom-registry";
import { editDraft } from "./scheduledTaskDraft";
import { ScheduledTaskEditorProvider } from "./scheduled-task-editor";
import {
  scheduledTaskEditorSessionAtom,
  startScheduledTaskEditor,
} from "./scheduled-task-editor-state";
import { SettingsScheduledTaskEditRouteScreen } from "./SettingsScheduledTasksRouteScreen";

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.alert.mockReset();
  mocks.upsert.mockReset();
  mocks.upsert.mockResolvedValue({ _tag: "Success" });
  const task: ScheduledTask = {
    id: ScheduledTaskId.make("task"),
    title: "Task",
    prompt: "Prompt",
    enabled: true,
    schedule: { type: "fixed_time", timeOfDay: "05:00" },
    projectId: ProjectId.make("project"),
    threadId: null,
    workspaceStrategy: { type: "root" },
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "model",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "mobile",
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
  mocks.tasks = [task];
  const draft = editDraft(task);
  startScheduledTaskEditor({
    environmentId: EnvironmentId.make("environment"),
    environmentLabel: "Environment",
    draft: { ...draft, schedule: { ...draft.schedule, intervalMinutes: "60" } },
  });
  act(() =>
    root.render(
      <RegistryContext.Provider value={appAtomRegistry}>
        <ScheduledTaskEditorProvider>
          <SettingsScheduledTaskEditRouteScreen />
        </ScheduledTaskEditorProvider>
      </RegistryContext.Provider>,
    ),
  );
});
afterEach(() => {
  act(() => root.unmount());
  mocks.platform = "ios";
  appAtomRegistry.set(scheduledTaskEditorSessionAtom, null);
});
function button(label: string) {
  const element = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === label,
  );
  if (!element) throw new Error(`Missing button: ${label}`);
  return element;
}
it.each(["android", "ios"])("handles time confirmation on %s", async (platform) => {
  mocks.platform = platform;
  const timeRow = Array.from(container.querySelectorAll("button")).find((item) =>
    item.textContent?.startsWith("Time"),
  );
  expect(timeRow).toBeDefined();
  act(() => timeRow?.click());
  act(() => button("Confirm time").click());
  expect(container.textContent?.includes("Confirm time")).toBe(platform === "ios");
  await act(async () => button("Save changes").click());
  expect(mocks.upsert).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({ schedule: expect.objectContaining({ timeOfDay: "06:30" }) }),
    }),
  );
});

describe("scheduled task batched edits", () => {
  it("submits the selected interval when saved before React commits", async () => {
    await act(async () => {
      button("Interval").click();
      button("Save changes").click();
    });
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment",
      input: expect.objectContaining({
        id: "task",
        requireExisting: true,
        schedule: { type: "interval", everyMs: 3_600_000 },
      }),
    });
  });
  it("retains the interval when enabled changes before React commits", async () => {
    act(() => {
      button("Interval").click();
      button("Toggle enabled").click();
    });
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current?.draft.schedule.mode).toBe(
      "interval",
    );
    await act(async () => button("Save changes").click());
    expect(mocks.alert).not.toHaveBeenCalled();
    expect(mocks.upsert).toHaveBeenCalledExactlyOnceWith({
      environmentId: "environment",
      input: expect.objectContaining({
        id: "task",
        requireExisting: true,
        enabled: false,
        schedule: { type: "interval", everyMs: 3_600_000 },
      }),
    });
  });
  it("keeps the target project when an old picker fires after changing environments", () => {
    const editor = appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current;
    if (!editor) throw new Error("Missing editor");
    act(() => startScheduledTaskEditor({ ...editor, draft: { ...editor.draft, task: null } }));
    act(() => {
      button("Select Target").click();
      button("Interval").click();
      button("Select Project").click();
    });
    expect(appAtomRegistry.get(scheduledTaskEditorSessionAtom)?.current).toMatchObject({
      environmentId: "target",
      draft: { projectId: "target-project", schedule: { mode: "interval" } },
    });
  });
});
