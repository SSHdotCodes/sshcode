import type { EnvironmentId, OrchestrationV2ShellSnapshot } from "@t3tools/contracts";
import type { EnvironmentShellState } from "@t3tools/client-runtime/state/shell";
import {
  enabledEnvironmentIds,
  type EnvironmentCatalogState,
} from "@t3tools/client-runtime/state/connections";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import type { Persistence } from "@t3tools/client-runtime/platform";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { threadNeedsYou } from "../lib/thread-summaries";

export type PreviewCounts = ReadonlyMap<string, Persistence.ShellPreviewCounts | null>;

export function workspaceThreadCounts(
  threads: ReadonlyArray<EnvironmentThreadShell>,
  previews: PreviewCounts,
) {
  const complete = threads.filter((thread) => !previews.has(thread.environmentId));
  let working = complete.filter(isThreadWorking).length;
  let needsYou = complete.filter((thread) => threadNeedsYou(thread)).length;
  for (const counts of previews.values()) {
    if (counts === null) return null;
    working += counts.working;
    needsYou += counts.needsYou;
  }
  return { working, needsYou };
}

/** Only the Home presentation opts into partial rows; command state stays complete. */
export function createShellPreviewPresentation(input: {
  readonly catalogAtom: Atom.Atom<EnvironmentCatalogState>;
  readonly stateAtom: (id: EnvironmentId) => Atom.Atom<EnvironmentShellState>;
  readonly snapshotAtom: (id: EnvironmentId) => Atom.Atom<OrchestrationV2ShellSnapshot | null>;
  readonly previewAtom: (
    id: EnvironmentId,
  ) => Atom.Atom<Option.Option<Persistence.EnvironmentShellPreview>>;
}) {
  // Retire a failed cold-start preview across retries, retaining only a boolean.
  const failedHydrationAtom = Atom.family((id: EnvironmentId) =>
    Atom.make((get): boolean => {
      if (Option.getOrElse(get.self<boolean>(), () => false)) return true;
      const state = get(input.stateAtom(id));
      return Option.isNone(state.snapshot) && Option.isSome(state.error);
    }).pipe(Atom.keepAlive),
  );
  const snapshotAtom = Atom.family((id: EnvironmentId) =>
    Atom.make((get) => {
      // Mount authoritative hydration before reading its display-only companion.
      const complete = get(input.snapshotAtom(id));
      if (get(failedHydrationAtom(id))) return complete;
      return complete ?? Option.getOrNull(get(input.previewAtom(id)));
    }),
  );
  let previousIds: ReadonlySet<EnvironmentId> = new Set();
  const readOnlyEnvironmentIdsAtom = Atom.make((get): ReadonlySet<EnvironmentId> => {
    const ids = new Set<EnvironmentId>();
    for (const id of enabledEnvironmentIds(get(input.catalogAtom))) {
      if (Option.isNone(get(input.stateAtom(id)).snapshot)) ids.add(id);
    }
    if (ids.size === previousIds.size && [...ids].every((id) => previousIds.has(id)))
      return previousIds;
    previousIds = ids;
    return ids;
  });
  let previousCounts: PreviewCounts = new Map();
  const countsAtom = Atom.make((get): PreviewCounts => {
    const counts = new Map<string, Persistence.ShellPreviewCounts | null>();
    for (const id of get(readOnlyEnvironmentIdsAtom)) {
      if (get(failedHydrationAtom(id))) continue;
      counts.set(id, Option.getOrNull(get(input.previewAtom(id)))?.previewCounts ?? null);
    }
    if (
      counts.size === previousCounts.size &&
      [...counts].every(([id, value]) => previousCounts.get(id) === value)
    )
      return previousCounts;
    previousCounts = counts;
    return counts;
  });
  return { snapshotAtom, readOnlyEnvironmentIdsAtom, countsAtom };
}
