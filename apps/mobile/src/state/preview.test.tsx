// @vitest-environment jsdom
import {
  EnvironmentId,
  ThreadId,
  type PreviewEvent,
  type PreviewListResult,
} from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RegistryContext } from "@effect/atom-react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({
  listReads: 0,
  listRefreshes: 0,
  cachedListResult: null as AsyncResult.AsyncResult<PreviewListResult, never> | null,
  listAtom: null as Atom.Writable<AsyncResult.AsyncResult<PreviewListResult, never>, void> | null,
  eventsAtom: null as Atom.Atom<AsyncResult.AsyncResult<PreviewEvent, never>> | null,
}));

vi.mock("../connection/runtime", () => ({
  connectionAtomRuntime: {
    atom: () => Atom.make(AsyncResult.initial()),
  },
}));
vi.mock("./query", () => ({
  useEnvironmentQuery: () => ({ data: null, error: null, refresh: () => {} }),
}));
vi.mock("./session", () => ({
  environmentSession: { preparedConnectionValueAtom: () => Atom.make(null) },
  usePreparedConnection: () => null,
}));
vi.mock("@t3tools/client-runtime/state/preview", () => ({
  createPreviewEnvironmentAtoms: () => ({
    list: () => {
      if (harness.listAtom === null) {
        const current = harness.cachedListResult ?? AsyncResult.initial<PreviewListResult, never>();
        const listResultAtom = Atom.make(current);
        harness.listAtom = Atom.writable(
          (get) => {
            harness.listReads += 1;
            return get(listResultAtom);
          },
          (ctx) => {
            ctx.set(
              listResultAtom,
              harness.cachedListResult ?? AsyncResult.initial<PreviewListResult, never>(),
            );
          },
          () => {
            harness.listRefreshes += 1;
          },
        );
      }
      return harness.listAtom;
    },
    events: () => {
      harness.eventsAtom ??= Atom.make(AsyncResult.initial<PreviewEvent, never>());
      return harness.eventsAtom;
    },
  }),
}));

import { useThreadServerBrowserTabs } from "./preview";

let root: Root | null = null;

function renderWithRegistry(registry: AtomRegistry.AtomRegistry, element: React.ReactElement) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root ??= createRoot(document.createElement("div"));
  act(() =>
    root!.render(<RegistryContext.Provider value={registry}>{element}</RegistryContext.Provider>),
  );
}

function Probe(props: { readonly threadId: ThreadId }) {
  useThreadServerBrowserTabs({
    environmentId: EnvironmentId.make("env-1"),
    threadId: props.threadId,
    enabled: true,
  });
  return null;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  harness.listReads = 0;
  harness.listRefreshes = 0;
  harness.listAtom = null;
  harness.eventsAtom = null;
  harness.cachedListResult = null;
});

describe("useThreadServerBrowserTabs", () => {
  it("does not trigger a duplicate refresh when listAtom is not yet cached on cold chat open", async () => {
    const registry = AtomRegistry.make();
    renderWithRegistry(registry, <Probe threadId={ThreadId.make("thread-cold")} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.listReads).toBe(1);
    expect(harness.listRefreshes).toBe(0);
    registry.dispose();
  });

  it("refreshes once in a microtask when listAtom already holds a cached snapshot", async () => {
    harness.cachedListResult = AsyncResult.success({
      serverEpoch: "epoch-1",
      revision: 1,
      sessions: [],
    });
    const registry = AtomRegistry.make();
    renderWithRegistry(registry, <Probe threadId={ThreadId.make("thread-warm")} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(harness.listReads).toBe(1);
    expect(harness.listRefreshes).toBe(1);
    registry.dispose();
  });
});
