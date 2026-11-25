// @vitest-environment jsdom
import {
  EnvironmentId,
  ThreadId,
  type OrchestrationV2SearchThreadInput,
  type OrchestrationV2SearchThreadResult,
} from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { threadFindMode } from "./thread-find";
import { useMobileThreadFind } from "./useMobileThreadFind";

const server = vi.hoisted(() => ({
  request: vi.fn((target: { input: OrchestrationV2SearchThreadInput }) => target),
  response: null as OrchestrationV2SearchThreadResult | null,
  next: null as OrchestrationV2SearchThreadResult | null,
  pending: false,
  refreshes: 0,
}));

vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: { threadFind: server.request, threadFindProgressive: server.request },
}));
vi.mock("../../state/queries", () => ({ useDebouncedValue: (query: string) => query }));
vi.mock("../../state/query", async () => {
  const { useState } = await import("react");
  return {
    useEnvironmentQuery: (atom: unknown) => {
      const [, rerender] = useState(0);
      return {
        data: atom ? server.response : null,
        error: null,
        isPending: Boolean(atom && server.pending),
        refresh: () => {
          server.refreshes++;
          server.response = server.next;
          rerender((count) => count + 1);
        },
      };
    },
  };
});

const environmentId = EnvironmentId.make("mac");
const threadId = ThreadId.make("chat");
const readAnchor = () => ({ entryId: "visible", occurrence: 0 });
const reveal = vi.fn();
const readInput = () => server.request.mock.lastCall?.[0].input;
let root: Root;
let view: ReturnType<typeof useMobileThreadFind>;

function Harness(props: { readonly revision: object }) {
  view = useMobileThreadFind({
    environmentId,
    threadId,
    progressive: true,
    contentRevision: props.revision,
    readAnchor,
    onReveal: reveal,
  });
  return null;
}
const renderRevision = (revision: object) =>
  act(() => root.render(<Harness revision={revision} />));

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  server.request.mockClear();
  reveal.mockClear();
  server.pending = false;
  server.refreshes = 0;
  server.response = { snapshotSequence: 1, activeIndex: 0, match: null, totalMatches: 0 };
  server.next = null;
  root = createRoot(document.createElement("div"));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("searches from the viewport and refreshes No matches after a throttled content change", () => {
  renderRevision({});
  act(() => view.changeQuery("needle"));
  expect(readInput()?.start).toEqual(readAnchor());
  expect(view.result?.totalMatches).toBe(0);

  server.next = {
    snapshotSequence: 3,
    activeIndex: 0,
    totalMatches: 1,
    match: { entryId: "new-message", occurrence: 0, runId: null },
  };
  renderRevision({});
  act(() => vi.advanceTimersByTime(150));
  renderRevision({});
  act(() => vi.advanceTimersByTime(149));
  expect(server.refreshes).toBe(0);
  act(() => vi.advanceTimersByTime(1));
  expect(server.refreshes).toBe(1);
  expect(view.result?.totalMatches).toBe(1);
  expect(reveal).toHaveBeenLastCalledWith("new-message");
});

it("rebases a content refresh on the selected occurrence without jumping again", () => {
  server.response = {
    snapshotSequence: 1,
    activeIndex: 1,
    totalMatches: 3,
    match: { entryId: "selected", occurrence: 1, runId: null },
  };
  renderRevision({});
  act(() => view.changeQuery("needle"));
  expect(reveal).toHaveBeenCalledTimes(1);
  renderRevision({});
  act(() => vi.advanceTimersByTime(300));
  expect(readInput()?.start).toEqual({ entryId: "selected", occurrence: 1 });
  expect(readInput()?.offset).toBeUndefined();
  expect(reveal).toHaveBeenCalledTimes(1);
});

it("does not restart a progressive scan while it is still in flight", () => {
  server.pending = true;
  renderRevision({});
  act(() => view.changeQuery("needle"));
  const revision = {};
  renderRevision(revision);
  act(() => vi.advanceTimersByTime(300));
  expect(server.refreshes).toBe(0);
  server.pending = false;
  renderRevision(revision);
  expect(server.refreshes).toBe(1);
});

it("offers Find in chat only when supported and opts into progressive results explicitly", () => {
  expect(threadFindMode(null)).toBeNull();
  expect(threadFindMode({ threadFindProgressive: true })).toBeNull();
  expect(threadFindMode({ threadFind: false })).toBeNull();
  expect(threadFindMode({ threadFind: true })).toBe("single");
  expect(threadFindMode({ threadFind: true, threadFindProgressive: true })).toBe("progressive");
});
