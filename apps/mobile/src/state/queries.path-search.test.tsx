// @vitest-environment jsdom
import { AuthFilesystemReadScope, EnvironmentId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  sessionAtom: {},
  searchEntriesAtom: {},
  searchEntries: vi.fn((): unknown => mocks.searchEntriesAtom),
  listRefs: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("./session", () => ({
  environmentSession: { sessionStateAtom: () => mocks.sessionAtom },
}));
vi.mock("./presentation", () => ({
  useEnvironmentPresentation: () => ({
    isReady: true,
    presentation: { connection: { phase: "connected", error: null } },
  }),
}));
vi.mock("./pull-requests", () => ({ composerPullRequests: {} }));
vi.mock("./projects", () => ({
  projectEnvironment: { searchEntries: mocks.searchEntries },
}));
vi.mock("./atom-registry", () => ({ appAtomRegistry: { refresh: mocks.refresh } }));
vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./vcs", () => ({ vcsEnvironment: { listRefs: mocks.listRefs } }));
vi.mock("./threads", () => ({ olderSettledThreads: {}, threadFamilies: {} }));
vi.mock("./query", () => ({
  useEnvironmentQuery: (atom: unknown) => ({
    data:
      atom === mocks.sessionAtom
        ? { authenticated: true, scopes: [AuthFilesystemReadScope] }
        : atom === mocks.searchEntriesAtom
          ? { entries: [{ path: "src/only-in-original.ts", kind: "file" }] }
          : null,
    error: null,
    isPending: false,
    refresh: () => {},
  }),
}));

import { useComposerPathSearch, type ComposerPathSearchTarget } from "./queries";

function setup() {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  mocks.searchEntries.mockClear();
  const root = createRoot(document.createElement("div"));
  let latest: ReturnType<typeof useComposerPathSearch> | null = null;
  function Probe({ target }: { readonly target: ComposerPathSearchTarget }) {
    latest = useComposerPathSearch(target);
    return null;
  }

  return {
    get result() {
      return latest;
    },
    render(target: ComposerPathSearchTarget) {
      act(() => root.render(<Probe target={{ ...target }} />));
    },
    [Symbol.dispose]() {
      act(() => root.unmount());
      vi.useRealTimers();
    },
  };
}

const target = {
  environmentId: EnvironmentId.make("test-environment"),
  cwd: "/repo",
  query: "src",
};

it("browses workspace entries on a bare mention and stops when the trigger is gone", () => {
  using harness = setup();
  harness.render({ ...target, query: null });
  expect(mocks.searchEntries).not.toHaveBeenCalled();

  harness.render({ ...target, query: "" });
  act(() => vi.advanceTimersByTime(200));
  expect(mocks.searchEntries).toHaveBeenLastCalledWith({
    environmentId: target.environmentId,
    input: { cwd: target.cwd, query: "", limit: 20 },
  });
  expect(harness.result?.entries).toHaveLength(1);

  harness.render({ ...target, query: null });
  expect(harness.result?.entries).toEqual([]);
  mocks.searchEntries.mockClear();
  act(() => vi.advanceTimersByTime(200));
  expect(mocks.searchEntries).not.toHaveBeenCalled();
});

it.each([
  { field: "environment", changed: { ...target, environmentId: EnvironmentId.make("other") } },
  { field: "project directory", changed: { ...target, cwd: "/other" } },
])("reports settled results as pending when the $field changes", ({ changed }) => {
  using harness = setup();
  harness.render(target);
  act(() => vi.advanceTimersByTime(200));
  expect(harness.result?.isPending).toBe(false);
  expect(harness.result?.entries).toHaveLength(1);

  harness.render(changed);
  expect(harness.result?.isPending).toBe(true);
  expect(harness.result?.entries).toEqual([]);
});
