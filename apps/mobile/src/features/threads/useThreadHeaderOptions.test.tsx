// @vitest-environment jsdom
vi.mock("../../state/use-privacy-mode", () => ({
  usePrivacyMode: () => false,
  usePrivacyLabel: () => (_kind: string, _id: string, label: string) => label,
}));
import { DEFAULT_HARNESS_THEME_SETTINGS } from "@t3tools/shared/harnessThemes";
import { resolveMobileHarnessTheme } from "../../lib/harnessThemes";
import type { VcsStatusResult } from "@t3tools/contracts";
import type { ThreadHeaderItem } from "../../lib/threadHeaderItems";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

// Native header item factories are only read when options are applied, so the fake
// navigation snapshots the right items at each setOptions, as native-stack does.
const harness = vi.hoisted(() => ({
  setOptionsCalls: 0,
  lastOptions: {} as Record<string, unknown>,
  appearance: {
    hasHarnessTheme: false,
    themeVariables: {} as Record<string, string>,
    themeAppearance: "light" as "light" | "dark",
    threadHeaderItems: ["sideChat", "git"] as readonly ThreadHeaderItem[],
  },
  splitView: false,
  isPad: false,
  nativeColumns: false,
  renderedRightItems: [] as Array<ReadonlyArray<Record<string, unknown>>>,
  navigatedRoutes: [] as string[],
}));

vi.mock("@react-navigation/native", () => {
  const navigation = {
    canGoBack: () => true,
    dispatch: () => {},
    goBack: () => {},
    navigate: (route: string) => {
      harness.navigatedRoutes.push(route);
    },
    addListener: () => () => {},
    setOptions: (options: { unstable_headerRightItems?: () => Array<Record<string, unknown>> }) => {
      harness.lastOptions = options;
      harness.setOptionsCalls += 1;
      harness.renderedRightItems.push(options.unstable_headerRightItems?.() ?? []);
    },
  };
  return {
    StackActions: { replace: () => ({}) },
    useNavigation: () => navigation,
  };
});
vi.mock("../../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => () => {} }));

vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
vi.mock("../discord/useUiMode", () => ({ useUiMode: () => ["default", () => {}] }));
vi.mock("react-native", () => ({
  Alert: { alert: () => {} },
  Linking: {},
  Platform: {
    OS: "ios",
    get isPad() {
      return harness.isPad;
    },
  },
}));
vi.mock("../../native/NativeWorkspaceColumns", () => ({
  useNativeWorkspaceColumnsSupported: () => harness.nativeColumns,
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({
    layout: { usesSplitView: harness.splitView },
    panes: { primarySidebarVisible: false, auxiliaryPaneVisible: false },
    togglePrimarySidebar: () => {},
    toggleAuxiliaryPane: () => {},
  }),
}));
vi.mock("../layout/native-mail-search-toolbar", () => ({
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED: true,
  createNativeMailSearchToolbarItem: () => ({}),
}));
vi.mock("../settings/appearance/AppearancePreferencesProvider", () => ({
  useAppearancePreferences: () => harness.appearance,
}));
vi.mock("../computer-use/useComputerUseStatus", () => ({
  useComputerUseStatus: () => null,
}));

import { ThreadHeader } from "./ThreadHeader";

const projectScripts: never[] = [];

function status(
  files: ReadonlyArray<string>,
  overrides: Partial<VcsStatusResult> = {},
): VcsStatusResult {
  return {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "master",
    hasWorkingTreeChanges: files.length > 0,
    workingTree: {
      files: files.map((path) => ({ path, insertions: 0, deletions: 0 })),
      insertions: 0,
      deletions: 0,
    },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  } as unknown as VcsStatusResult;
}

// Mirrors the route screen: every render passes fresh gitControls callbacks.
function Header(props: {
  readonly gitStatus: VcsStatusResult | null;
  readonly title?: string;
  readonly onMergeBack?: () => void;
  readonly usesNativeHeaderGlass?: boolean;
}) {
  return (
    <ThreadHeader
      title={props.title ?? "Thread"}
      subtitle=""
      usesNativeHeaderGlass={props.usesNativeHeaderGlass ?? true}
      sideChat={{ label: "Open side chat", onOpen: () => {} }}
      gitControls={{
        environmentId: "environment-1",
        threadId: "thread-1",
        currentBranch: "master",
        gitStatus: props.gitStatus,
        gitOperationLabel: null,
        onPull: async () => {},
        onRunAction: async () => null,
        canOpenTerminal: true,
        canOperateTerminal: true,
        canOpenFiles: true,
        projectScripts,
        terminalSessions: [],
        onOpenTerminal: () => {},
        onOpenNewTerminal: () => {},
        onRunProjectScript: async () => {},
        onMergeBack: props.onMergeBack,
      }}
      hasThreadCwd
      hasWorkspaceRoot
      fileInspectorSupported={false}
      inspectorMode={null}
      onToggleInspector={() => {}}
      onOpenGitInspector={() => {}}
      onOpenFilesInspector={() => {}}
    />
  );
}

function renderedGitMenuItems(): Array<{
  description?: unknown;
  label?: unknown;
  onPress?: () => void;
}> {
  const items = harness.renderedRightItems.at(-1) ?? [];
  const git = items.find((item) => item.identifier === "thread-right-git") as
    | { menu: { items: Array<{ description?: unknown; label?: unknown; onPress?: () => void }> } }
    | undefined;
  return git?.menu.items ?? [];
}

function renderedGitStatusDescription(): unknown {
  return renderedGitMenuItems()[0]?.description;
}

let root: Root | null = null;

function render(element: React.ReactElement) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root ??= createRoot(document.createElement("div"));
  act(() => root!.render(element));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.lastOptions = {};
  harness.appearance = {
    hasHarnessTheme: false,
    themeVariables: {},
    themeAppearance: "light",
    threadHeaderItems: ["sideChat", "git"],
  };
  harness.splitView = false;
  harness.isPad = false;
  harness.nativeColumns = false;
  harness.setOptionsCalls = 0;
  harness.renderedRightItems = [];
  harness.navigatedRoutes = [];
});

describe("ThreadHeader", () => {
  it("updates native chrome when switching harnesses and clears overrides when disabled", () => {
    for (const driver of ["grok", "claudeAgent"]) {
      const scope = resolveMobileHarnessTheme(
        DEFAULT_HARNESS_THEME_SETTINGS,
        driver,
        "light",
        "ios",
      )!;
      harness.appearance = {
        ...harness.appearance,
        hasHarnessTheme: true,
        themeVariables: scope.themeVariables,
        themeAppearance: scope.themeAppearance,
      };
      render(<Header gitStatus={status([])} />);
      expect(harness.lastOptions.headerTintColor).toBe(
        scope.themeVariables["--color-header-foreground"],
      );
      expect(harness.lastOptions.headerStyle).toEqual({
        backgroundColor: scope.themeVariables["--color-header"],
      });
      expect(harness.lastOptions.statusBarStyle).toBe(
        scope.themeAppearance === "dark" ? "light" : "dark",
      );
    }
    harness.appearance = {
      ...harness.appearance,
      hasHarnessTheme: false,
      themeVariables: {},
      themeAppearance: "light",
    };
    render(<Header gitStatus={status([])} />);
    expect(harness.lastOptions).toHaveProperty("headerStyle", undefined);
    expect(harness.lastOptions).toHaveProperty("headerTintColor", undefined);
    expect(harness.lastOptions).toHaveProperty("contentStyle", undefined);
  });
  it("re-applies native header items when Git status changes", () => {
    render(<Header gitStatus={status([])} />);
    expect(renderedGitStatusDescription()).toBe("Clean");

    // A refreshed status (e.g. after reconnect) must reach the Git popover even
    // though nothing else in the header changed.
    render(<Header gitStatus={status(["audit.txt"])} />);
    expect(renderedGitStatusDescription()).toBe("1 changed");

    render(<Header gitStatus={status([])} />);
    expect(renderedGitStatusDescription()).toBe("Clean");
  });

  it("does not re-apply options for re-renders with equivalent header content", () => {
    render(<Header gitStatus={status([])} />);
    const applied = harness.setOptionsCalls;

    // Streaming re-renders the route with fresh callbacks and equal Git content.
    for (let index = 0; index < 20; index += 1) {
      render(<Header gitStatus={status([])} />);
    }
    expect(harness.setOptionsCalls).toBe(applied);
  });

  it("re-applies menu actions when the default ref changes behind the same label", async () => {
    // An unpushed commit on a branch with an open PR shows "Push" whether or not the
    // branch is the default one, but only the default branch asks for confirmation.
    const pushable = (isDefaultRef: boolean) =>
      status([], {
        isDefaultRef,
        aheadCount: 1,
        hasPrimaryRemote: true,
        pr: { state: "open", url: "https://example.com/pr/1" },
      } as Partial<VcsStatusResult>);
    render(<Header gitStatus={pushable(false)} />);
    expect(renderedGitMenuItems()[1]?.label).toBe("Push");

    render(<Header gitStatus={pushable(true)} />);
    expect(renderedGitMenuItems()[1]?.label).toBe("Push");
    await act(async () => renderedGitMenuItems()[1]?.onPress?.());
    expect(harness.navigatedRoutes).toEqual(["GitConfirm"]);
  });

  it.each([
    { name: "iPhone", splitView: false, isPad: false, glass: true, nativeColumns: false },
    { name: "iPhone columns", splitView: false, isPad: false, glass: true, nativeColumns: true },
    { name: "iPad split view", splitView: true, isPad: true, glass: true, nativeColumns: true },
    { name: "older iOS", splitView: false, isPad: false, glass: false, nativeColumns: false },
  ])(
    "updates visible shortcuts without empty slots on $name",
    ({ splitView, isPad, glass, nativeColumns }) => {
      harness.splitView = splitView;
      harness.isPad = isPad;
      harness.nativeColumns = nativeColumns;
      const shortcutIds = () =>
        (harness.renderedRightItems.at(-1) ?? [])
          .filter(
            (item) =>
              String(item.identifier).startsWith("thread-right-") &&
              item.identifier !== "thread-right-new-task",
          )
          .map((item) => item.identifier);

      render(<Header gitStatus={status([])} usesNativeHeaderGlass={glass} />);
      expect(shortcutIds()).toEqual(["thread-right-git", "thread-right-side-chat"]);

      harness.appearance.threadHeaderItems = ["sideChat", "git", "files", "terminal"];
      render(<Header gitStatus={status([])} usesNativeHeaderGlass={glass} />);
      expect(shortcutIds()).toContain("thread-right-files");
      expect(shortcutIds()).toContain("thread-right-terminal");

      harness.appearance.threadHeaderItems = ["files"];
      render(<Header gitStatus={status([])} usesNativeHeaderGlass={glass} />);
      expect(shortcutIds()).toEqual(["thread-right-files"]);

      harness.appearance.threadHeaderItems = [];
      const mergeBack = vi.fn();
      render(
        <Header gitStatus={status([])} usesNativeHeaderGlass={glass} onMergeBack={mergeBack} />,
      );
      expect(shortcutIds()).toEqual(["thread-right-merge-back"]);
      const mergeItem = harness.renderedRightItems
        .at(-1)
        ?.find((item) => item.identifier === "thread-right-merge-back") as
        | { onPress: () => void }
        | undefined;
      act(() => mergeItem?.onPress());
      expect(mergeBack).toHaveBeenCalledOnce();

      render(<Header gitStatus={status([])} usesNativeHeaderGlass={glass} />);
      expect(shortcutIds()).toEqual([]);
      expect(harness.renderedRightItems.at(-1)?.some((item) => item.type === "spacing")).toBe(
        false,
      );
    },
  );
});
