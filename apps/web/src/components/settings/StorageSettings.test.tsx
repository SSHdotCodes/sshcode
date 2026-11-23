// @vitest-environment jsdom
import { RegistryProvider } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ThreadId,
  type StorageCleanupReport,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_SERVER_SETTINGS,
  run: vi.fn(),
  report: null as StorageCleanupReport | null,
  maintenanceSupported: true,
}));

vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  const report = Atom.make(() => ({ _tag: "Success", value: state.report, waiting: false }));
  const allowed = Atom.make(true);
  return {
    serverEnvironment: {
      storageCleanupReport: () => report,
      runStorageCleanup: { permissionAtom: () => allowed },
    },
  };
});
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => {
    const environment = {
      environmentId: "env",
      label: "Machine",
      serverConfig: {
        settings: state.settings,
        environment: {
          capabilities: {
            storageCleanup: true,
            storageCleanupRun: true,
            ...(state.maintenanceSupported ? { storageMaintenance: true } : {}),
            settledWorktreeCleanup: true,
          },
        },
      },
    };
    return {
      scope: { kind: "environment" },
      environments: [environment],
      connectedEnvironments: [environment],
      targets: [],
      target: null,
    };
  },
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: () => state.settings,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => vi.fn(),
  useClearScopedSettings: () => vi.fn(),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => children,
  SettingsSection: ({ children }: { children: ReactNode }) => children,
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description: ReactNode;
    control: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      {description}
      {control}
    </div>
  ),
  SettingResetButton: () => null,
  useRelativeTimeTick: () => undefined,
  useSettingsSearchTargetId: () => null,
  useSettingsSearchTarget: () => undefined,
}));
vi.mock("../ui/toast", () => ({ toastManager: { add: vi.fn() } }));

import { StorageSettingsPanel } from "./StorageSettings";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settings = {
    ...DEFAULT_SERVER_SETTINGS,
    storageCleanup: {
      worktreeKeepWhen: "uncommitted-changes",
      worktreeAfterDays: null,
      worktreeSettledAfterDays: null,
      worktreeOnMerge: false,
      worktreeOnDelete: false,
      worktreeUnchanged: false,
      browserArtifactsAfterDays: null,
      logsAfterDays: null,
    },
    projectSettingsOverrides: {},
  };
  state.report = null;
  state.maintenanceSupported = true;
  state.run.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () =>
    root.render(
      <RegistryProvider>
        <StorageSettingsPanel />
      </RegistryProvider>,
    ),
  );
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Delete now",
  )!;
}

it.each(["machine-wide immediate", "project custom"])(
  "runs cleanup when only %s settled retention is enabled",
  async (scope) => {
    if (scope === "machine-wide immediate") {
      state.settings = {
        ...state.settings,
        storageCleanup: { ...state.settings.storageCleanup, worktreeSettledAfterDays: 0 },
      };
    } else {
      state.settings = {
        ...state.settings,
        projectSettingsOverrides: {
          [ProjectId.make("project")]: {
            worktreeCleanup: {
              mode: "custom",
              rules: { ...state.settings.storageCleanup, worktreeSettledAfterDays: 7 },
            },
          },
        },
      };
    }
    const report: StorageCleanupReport = {
      trigger: "manual",
      startedAt: "2026-10-14T12:00:00.000Z",
      finishedAt: "2026-10-14T12:00:01.000Z",
      entries: [],
      counts: { removed: 0, kept: 0, failed: 0 },
      omittedCount: 0,
      bytesFreed: 0,
    };
    let complete!: (result: { _tag: "Success"; value: StorageCleanupReport }) => void;
    state.run.mockImplementation(() => new Promise((resolve) => (complete = resolve)));
    const button = await render();

    expect(button.disabled).toBe(false);
    await act(async () => button.click());
    expect(state.run).toHaveBeenCalledExactlyOnceWith({ environmentId: "env", input: {} });
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe("Deleting…");

    await act(async () => complete({ _tag: "Success", value: report }));
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe("Delete now");
  },
);

it("keeps cleanup disabled when settled retention and all other rules are off", async () => {
  const button = await render();

  expect(button.disabled).toBe(true);
  await act(async () => button.click());
  expect(state.run).not.toHaveBeenCalled();
});

it("allows a storage preview with retention off and does not run maintenance without selection", async () => {
  const report: StorageCleanupReport = {
    trigger: "manual",
    startedAt: "2026-10-14T12:00:00.000Z",
    finishedAt: "2026-10-14T12:00:01.000Z",
    entries: [],
    counts: { removed: 0, kept: 0, failed: 0 },
    omittedCount: 0,
    bytesFreed: 0,
  };
  state.run.mockResolvedValue({ _tag: "Success", value: report });
  await render();
  const review = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Review storage",
  )!;
  expect(review.disabled).toBe(false);
  expect(state.run).not.toHaveBeenCalled();
  await act(async () => review.click());
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env",
    input: { action: "preview" },
  });
});

it("hides maintenance actions for older servers so preview cannot fall back to legacy deletion", async () => {
  state.maintenanceSupported = false;
  await render();
  expect(
    Array.from(container.querySelectorAll("button")).some(
      (button) => button.textContent === "Review storage",
    ),
  ).toBe(false);
  expect(state.run).not.toHaveBeenCalled();
});

it("shows cancellation counts, full worktree paths and database requirements before owner actions", async () => {
  state.report = {
    trigger: "manual",
    startedAt: "2026-10-14T12:00:00.000Z",
    finishedAt: "2026-10-14T12:00:01.000Z",
    entries: [],
    counts: { removed: 0, kept: 0, failed: 0 },
    omittedCount: 0,
    bytesFreed: 0,
    maintenance: {
      previewId: "preview-1",
      staleQueuedRunCount: 441,
      database: {
        databaseBytes: 14 * 1024 ** 3,
        freelistBytes: 4 * 1024 ** 3,
        walBytes: 32 * 1024 ** 2,
        estimatedGainBytes: 4 * 1024 ** 3 + 32 * 1024 ** 2,
        freeDiskBytes: 1024 ** 3,
        requiredFreeBytes: 16 * 1024 ** 3,
        mode: "vacuum",
        canReclaim: false,
      },
    },
  };
  state.run.mockResolvedValue({ _tag: "Success", value: state.report });
  await render();
  const cancel = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Cancel 441 queued runs",
  )!;
  const reclaim = Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Reclaim space",
  )!;
  expect(container.textContent).toContain("441 stale queued runs");
  expect(container.textContent).toContain("messages visible in conversation history");
  expect(container.textContent).toContain("Free pages:");
  expect(container.textContent).toContain("required:");
  expect(reclaim.disabled).toBe(true);
  expect(state.run).not.toHaveBeenCalled();
  await act(async () => cancel.click());
  expect(state.run).toHaveBeenCalledExactlyOnceWith({
    environmentId: "env",
    input: { action: "cancel-stale-queued-runs", previewId: "preview-1" },
  });
});

it("shows an orphan's full path and size while keeping thread row titles unchanged", async () => {
  state.settings = {
    ...state.settings,
    storageCleanup: { ...state.settings.storageCleanup, worktreeSettledAfterDays: 0 },
  };
  state.report = {
    trigger: "manual",
    startedAt: "2026-10-14T12:00:00.000Z",
    finishedAt: "2026-10-14T12:00:01.000Z",
    entries: [
      {
        kind: "worktree",
        outcome: "kept",
        path: "/worktrees/repo/orphan",
        threadId: null,
        threadTitle: null,
        reason: "No thread uses this folder, and it isn't a git worktree",
        bytes: 6600000,
        files: null,
      },
      {
        kind: "worktree",
        outcome: "kept",
        path: "/worktrees/repo/thread-checkout",
        threadId: ThreadId.make("thread"),
        threadTitle: "Thread title",
        reason: "Thread is running or has pending work",
        bytes: null,
        files: null,
      },
    ],
    counts: { removed: 0, kept: 2, failed: 0 },
    omittedCount: 0,
    bytesFreed: 0,
  };
  await render();
  const lastRun = Array.from(container.querySelectorAll("button")).find((button) =>
    button.textContent?.includes("Last run"),
  )!;
  await act(async () => lastRun.click());
  const titles = Array.from(container.querySelectorAll("h3"), (heading) => heading.textContent);
  expect(titles).toContain("/worktrees/repo/orphan");
  expect(titles).toContain("thread-checkout");
  expect(titles).not.toContain("/worktrees/repo/thread-checkout");
  expect(container.textContent).toContain(
    "No thread uses this folder, and it isn't a git worktree",
  );
  expect(container.textContent).toContain("6.29 MB");
  expect(container.textContent).toContain("0 B recovered.");
});
