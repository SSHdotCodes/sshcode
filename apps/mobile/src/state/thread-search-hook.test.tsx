// @vitest-environment jsdom
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const search = vi.hoisted(() => ({
  results: new Map<string, { matches: unknown[]; isLoading: boolean; failed: boolean }>(),
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: {
    key?: string;
    empty?: { matches: unknown[]; isLoading: boolean; failed: boolean };
  }) =>
    atom.empty ?? search.results.get(atom.key!) ?? { matches: [], isLoading: true, failed: false },
}));
vi.mock("effect/reactivity", () => ({
  Atom: {
    make: (value: { matches: unknown[]; isLoading: boolean; failed: boolean }) => ({
      pipe: () => ({ empty: value }),
    }),
    withLabel: () => (atom: unknown) => atom,
  },
  AsyncResult: {},
}));
vi.mock("@t3tools/client-runtime/state/thread-search", () => ({
  createThreadSearchResultsAtomFamily: () => (key: string) => ({ key }),
  makeThreadSearchKey: (_ids: unknown, query: string) => query,
}));
vi.mock("./session", () => ({}));
vi.mock("./presentation", () => ({}));
vi.mock("./atom-registry", () => ({}));
vi.mock("./orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("./projects", () => ({}));
vi.mock("./query", () => ({}));
vi.mock("./vcs", () => ({}));
vi.mock("./pull-requests", () => ({}));
vi.mock("./queryTargets", () => ({}));
vi.mock("@t3tools/shared/composerPullRequestMatches", () => ({}));
vi.mock("@t3tools/client-runtime/state/filesystem", () => ({}));
vi.mock("@t3tools/client-runtime/work-log/item-detail", () => ({}));

import { useThreadSearch } from "./queries";

const environmentIds = [EnvironmentId.make("mac")];
const match = { environmentId: environmentIds[0], threadId: ThreadId.make("found-in-messages") };
let root: Root;
let container: HTMLDivElement;
type SearchView = ReturnType<typeof useThreadSearch>;
const seen: SearchView[] = [];
const latest = () => seen.at(-1);

function Probe(props: { readonly query: string; readonly onRender: (view: SearchView) => void }) {
  props.onRender(useThreadSearch(environmentIds, props.query));
  return null;
}

const show = (query: string) =>
  act(() => root.render(<Probe query={query} onRender={(view) => seen.push(view)} />));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  search.results.clear();
  container = document.createElement("div");
  root = createRoot(container);
  seen.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

it("keeps the last message matches while the next query is typed and searched", () => {
  search.results.set("log", { matches: [match], isLoading: false, failed: false });
  show("log");
  act(() => vi.advanceTimersByTime(75));
  expect(latest()?.matches).toEqual([match]);

  // Debouncing, then loading the longer query: the earlier answer stays.
  show("logi");
  expect(latest()).toEqual({ matches: [match], isPending: true, failed: false });
  act(() => vi.advanceTimersByTime(75));
  expect(latest()).toEqual({ matches: [match], isPending: true, failed: false });

  // One machine has answered while another is still searching: show its
  // matches now.
  const partial = { environmentId: environmentIds[0], threadId: ThreadId.make("fast-mac") };
  search.results.set("logi", { matches: [partial], isLoading: true, failed: false });
  show("logi");
  expect(latest()).toEqual({ matches: [partial], isPending: true, failed: false });

  search.results.set("login", { matches: [], isLoading: false, failed: false });
  show("login");
  act(() => vi.advanceTimersByTime(75));
  expect(latest()).toEqual({ matches: [], isPending: false, failed: false });

  // Clearing the search forgets the answer instead of offering it later.
  show("");
  expect(latest()?.matches).toEqual([]);
  expect(seen.length).toBeLessThan(20);
});
