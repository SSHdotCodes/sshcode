// @vitest-environment jsdom

import { EnvironmentId } from "@t3tools/contracts";
import { act, cloneElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  settled: false,
  model: {
    resetPaths: vi.fn(),
    batch: vi.fn(),
    setGitStatus: vi.fn(),
    isSearchOpen: () => false,
    subscribe: () => () => {},
  },
  directory: {
    entries: [{ path: "README.md", kind: "file" }],
    ready: true,
    error: null,
    isPending: false,
    loadingDirectories: new Set<string>(),
    load: vi.fn(),
    refresh: vi.fn(),
  },
}));
vi.mock("@pierre/trees/react", async () => {
  const { useState } = await import("react");
  return {
    FileTree: () => <div role="tree">README.md</div>,
    useFileTree: () => ({ model: state.model }),
    useFileTreeSelector: () => false,
    useFileTreeSearch: () => {
      const [value, setValue] = useState("");
      return { value, setValue, close: () => setValue(""), matchingPaths: [] };
    },
  };
});
vi.mock("./useDirectoryEntries", () => ({ useDirectoryEntries: () => state.directory }));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false }),
}));
vi.mock("~/state/projects", () => ({ projectEnvironment: { searchEntries: () => "search" } }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data: atom && state.settled ? { entries: [] } : null,
    isSuccess: Boolean(atom) && state.settled,
    isPending: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("~/state/orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("~/state/vcs", () => ({ vcsEnvironment: {} }));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "light" }) }));
vi.mock("~/composerHandleContext", () => ({ useComposerHandleContext: () => null }));
vi.mock("~/fileContextMenu", () => ({ useFileContextMenu: () => ({}) }));
vi.mock("~/components/ui/toast", () => ({ toastManager: {} }));
vi.mock("~/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

import FileBrowserPanel from "./FileBrowserPanel";

it("waits through debounce and initial fetch before showing no results for the current query", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.settled = false;
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const panel = (
    <FileBrowserPanel
      environmentId={EnvironmentId.make("local")}
      cwd="/repo"
      projectName="Project"
      selectedPath={null}
      selectedPathRevealId={0}
      onOpenFile={() => {}}
      workspaceMutationId={null}
    />
  );
  const type = async (value: string) =>
    act(async () => {
      const input = host.querySelector("input")!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  try {
    await act(async () => root.render(panel));
    await type("missing");
    expect(host.textContent).toContain("Searching files…");
    expect(host.textContent).not.toContain("No files found");
    await act(async () => {
      vi.advanceTimersByTime(119);
    });
    expect(host.textContent).not.toContain("No files found");
    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(host.textContent).not.toContain("No files found");
    state.settled = true;
    await act(async () => root.render(cloneElement(panel)));
    expect(host.textContent).toContain("No files found");
    await type("another-query");
    expect(host.textContent).not.toContain("No files found");
    expect(host.textContent).toContain("Searching files…");
  } finally {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
