import { afterEach, expect, it } from "vite-plus/test";
import type { Persistence } from "@t3tools/client-runtime/platform";
import { makeThreadShellFixture } from "../test-fixtures";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { EMPTY_SHELL_STATE, type EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentCatalogState } from "@t3tools/client-runtime/state/connections";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { v2ShellSnapshot } from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { createShellPreviewPresentation, workspaceThreadCounts } from "./shell-preview";

const registries: AtomRegistry.AtomRegistry[] = [];
afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

it("keeps interrupted-write preview rows read-only and outside authoritative command state", () => {
  const registry = AtomRegistry.make();
  registries.push(registry);
  const id = EnvironmentId.make("mac");
  const other = EnvironmentId.make("other");
  const state = Atom.family((_id: EnvironmentId) =>
    Atom.make<EnvironmentShellState>(EMPTY_SHELL_STATE),
  );
  const preview = Atom.family((_id: EnvironmentId) =>
    Atom.make<Option.Option<Persistence.EnvironmentShellPreview>>(Option.some(v2ShellSnapshot)),
  );
  const snapshot = Atom.family((id: EnvironmentId) =>
    Atom.make((get) => Option.getOrNull(get(state(id)).snapshot)),
  );
  const catalog = Atom.make<EnvironmentCatalogState>({
    isReady: true,
    entries: new Map([
      [id, { enabled: true } as never],
      [other, { enabled: true } as never],
    ]),
  });
  const display = createShellPreviewPresentation({
    catalogAtom: catalog,
    stateAtom: state,
    snapshotAtom: snapshot,
    previewAtom: preview,
  });
  expect(registry.get(display.snapshotAtom(id))).toBe(v2ShellSnapshot);
  expect(Option.isNone(registry.get(state(id)).snapshot)).toBe(true);
  expect(registry.get(display.readOnlyEnvironmentIdsAtom).has(id)).toBe(true);
  expect(registry.get(display.countsAtom).get(id)).toBeNull();
  const counts = { visibleChats: 500, needsYou: 140, unread: true, working: 20, pendingInput: 130 };
  registry.set(preview(id), Option.some({ ...v2ShellSnapshot, previewCounts: counts }));
  expect(registry.get(display.countsAtom).get(id)).toBe(counts);
  expect(registry.get(display.countsAtom).get(other)).toBeNull();
  // Deleted/archived old row and a moved chat are absent/replaced in the complete cache.
  const complete = {
    ...v2ShellSnapshot,
    threads: [
      { ...v2ShellSnapshot.threads[0]!, id: ThreadId.make("moved-chat"), title: "Current project" },
    ],
  };
  registry.set(state(id), {
    ...EMPTY_SHELL_STATE,
    status: "cached",
    snapshot: Option.some(complete),
  });
  expect(registry.get(display.snapshotAtom(id))).toBe(complete);
  expect(registry.get(display.readOnlyEnvironmentIdsAtom).has(id)).toBe(false);
  expect(registry.get(display.countsAtom).has(id)).toBe(false);
  expect(registry.get(display.readOnlyEnvironmentIdsAtom).has(other)).toBe(true);
});

it("drops an offline failed-hydration preview and its counts across retries without enabling commands", () => {
  const registry = AtomRegistry.make();
  registries.push(registry);
  const id = EnvironmentId.make("offline");
  const state = Atom.family((_id: EnvironmentId) =>
    Atom.make<EnvironmentShellState>(EMPTY_SHELL_STATE),
  );
  const counts = { visibleChats: 500, needsYou: 140, unread: true, working: 20, pendingInput: 130 };
  const cached = { ...v2ShellSnapshot, previewCounts: counts };
  const preview = Atom.family((_id: EnvironmentId) =>
    Atom.make<Option.Option<Persistence.EnvironmentShellPreview>>(Option.some(cached)),
  );
  const snapshot = Atom.family((id: EnvironmentId) =>
    Atom.make((get) => Option.getOrNull(get(state(id)).snapshot)),
  );
  const display = createShellPreviewPresentation({
    catalogAtom: Atom.make<EnvironmentCatalogState>({
      isReady: true,
      entries: new Map([[id, { enabled: true } as never]]),
    }),
    stateAtom: state,
    snapshotAtom: snapshot,
    previewAtom: preview,
  });
  expect(registry.get(display.snapshotAtom(id))).toBe(cached);
  expect(registry.get(display.countsAtom).get(id)).toBe(counts);
  expect(registry.get(display.readOnlyEnvironmentIdsAtom).has(id)).toBe(true);

  registry.set(state(id), {
    ...EMPTY_SHELL_STATE,
    error: Option.some("Could not synchronize environment data."),
  });
  expect(registry.get(display.snapshotAtom(id))).toBeNull();
  expect(registry.get(display.countsAtom).has(id)).toBe(false);
  expect(registry.get(display.readOnlyEnvironmentIdsAtom).has(id)).toBe(true);
  expect(Option.isNone(registry.get(state(id)).snapshot)).toBe(true);

  // A retry clears the error before full hydration; the stale preview stays gone.
  registry.set(state(id), EMPTY_SHELL_STATE);
  expect(registry.get(display.snapshotAtom(id))).toBeNull();
  expect(registry.get(display.countsAtom).has(id)).toBe(false);
  expect(registry.get(display.readOnlyEnvironmentIdsAtom).has(id)).toBe(true);

  // Only a complete authoritative snapshot can restore rows and interactions.
  registry.set(state(id), {
    ...EMPTY_SHELL_STATE,
    status: "cached",
    snapshot: Option.some(v2ShellSnapshot),
  });
  expect(registry.get(display.snapshotAtom(id))).toBe(v2ShellSnapshot);
  expect(registry.get(display.readOnlyEnvironmentIdsAtom).has(id)).toBe(false);
});

it("uses cached complete workspace counts without double counting preview rows, and hides legacy unknown totals", () => {
  const id = EnvironmentId.make("preview");
  const other = EnvironmentId.make("complete");
  const counts = { visibleChats: 500, needsYou: 140, unread: true, working: 20, pendingInput: 130 };
  const previewRow = makeThreadShellFixture({ environmentId: id, hasPendingApprovals: true });
  const fullRow = makeThreadShellFixture({ environmentId: other, hasPendingUserInput: true });
  expect(workspaceThreadCounts([previewRow, fullRow], new Map([[id, counts]]))).toEqual({
    working: 20,
    needsYou: 141,
  });
  expect(workspaceThreadCounts([previewRow, fullRow], new Map([[id, null]]))).toBeNull();
  expect(workspaceThreadCounts([fullRow], new Map())).toEqual({ working: 0, needsYou: 1 });
});

it("counts a child's question once on the visible parent chat", () => {
  const parent = makeThreadShellFixture({ pendingSubagentRequest: "user_input" });
  expect(workspaceThreadCounts([parent], new Map())).toEqual({ working: 0, needsYou: 1 });
});
