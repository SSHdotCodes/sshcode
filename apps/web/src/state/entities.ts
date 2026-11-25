import { useMemo } from "react";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentProject,
  EnvironmentThread,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import {
  EMPTY_THREAD_HISTORY_META,
  threadDetailToShell,
  type EnvironmentThreadStatus,
  type ThreadHistoryMeta,
} from "@t3tools/client-runtime/state/threads";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ScopedProjectRef, ScopedThreadRef, ServerConfig } from "@t3tools/contracts";
import type { EnvironmentId, OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentProjects } from "./projects";
import { environmentServerConfigsAtom } from "./server";
import {
  allEnvironmentProjectSnapshotsReadyAtom,
  allEnvironmentShellsBootstrappedAtom,
  environmentShellLoadedAtom,
  environmentShell,
} from "./shell";
import {
  createdChatShellAtom,
  environmentThreadDetails,
  environmentThreadShells,
  threadFamilies,
  threadPickerShells,
} from "./threads";
import { waitForAtomValue } from "./waitForAtomValue";

const EMPTY_THREAD_REFS: ReadonlyArray<ScopedThreadRef> = Object.freeze([]);
const EMPTY_VISIBLE_TURN_ITEMS: ReadonlyArray<OrchestrationV2ProjectedTurnItem> = Object.freeze([]);

const EMPTY_PROJECT_ATOM = Atom.make<EnvironmentProject | null>(null).pipe(
  Atom.withLabel("web-project:empty"),
);
const SHELL_NOT_LOADED_ATOM = Atom.make(false).pipe(Atom.withLabel("web-shell-loaded:none"));
const EMPTY_THREAD_REFS_ATOM = Atom.make(EMPTY_THREAD_REFS).pipe(
  Atom.withLabel("web-thread-refs:empty"),
);
const EMPTY_THREAD_SHELLS_ATOM = Atom.make<ReadonlyArray<EnvironmentThreadShell>>(
  Object.freeze([]),
).pipe(Atom.withLabel("web-thread-shells:empty"));
const EMPTY_THREAD_SHELL_ATOM = Atom.make<EnvironmentThreadShell | null>(null).pipe(
  Atom.withLabel("web-thread-shell:empty"),
);
const EMPTY_THREAD_PROJECTION_ATOM = Atom.make<EnvironmentThread | null>(null).pipe(
  Atom.withLabel("web-thread-projection:empty"),
);
const EMPTY_THREAD_STATUS_ATOM = Atom.make<EnvironmentThreadStatus>("empty").pipe(
  Atom.withLabel("web-thread-status:empty"),
);
const EMPTY_VISIBLE_TURN_ITEMS_ATOM = Atom.make(EMPTY_VISIBLE_TURN_ITEMS).pipe(
  Atom.withLabel("web-thread-visible-turn-items:empty"),
);
const EMPTY_THREAD_HISTORY_ATOM = Atom.make<ThreadHistoryMeta>(EMPTY_THREAD_HISTORY_META).pipe(
  Atom.withLabel("web-thread-history:empty"),
);

const activeEnvironmentIdAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("web-active-environment-id"),
);

export function useActiveEnvironmentId(): EnvironmentId | null {
  return useAtomValue(activeEnvironmentIdAtom);
}

export function setActiveEnvironmentId(environmentId: EnvironmentId | null): void {
  appAtomRegistry.set(activeEnvironmentIdAtom, environmentId);
}

export function useThreadRefs(): ReadonlyArray<ScopedThreadRef> {
  return useAtomValue(environmentThreadShells.threadRefsAtom);
}

export function useEnvironmentThreadRefs(
  environmentId: EnvironmentId | null,
): ReadonlyArray<ScopedThreadRef> {
  return useAtomValue(
    environmentId === null
      ? EMPTY_THREAD_REFS_ATOM
      : environmentThreadShells.environmentThreadRefsAtom(environmentId),
  );
}

export function useProjects(): ReadonlyArray<EnvironmentProject> {
  return useAtomValue(environmentProjects.projectsAtom);
}

export function useServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return useAtomValue(environmentServerConfigsAtom);
}

/** Every thread shell. Pass `enabled: false` to read a stable empty list and
    skip re-rendering on each shell update while the caller does not need them. */
export function useThreadShells(
  enabled = true,
  includeIdleSubagents = false,
): ReadonlyArray<EnvironmentThreadShell> {
  return useAtomValue(
    enabled
      ? (includeIdleSubagents ? threadPickerShells : environmentThreadShells).threadShellsAtom
      : EMPTY_THREAD_SHELLS_ATOM,
  );
}

export function useAllEnvironmentShellsBootstrapped(): boolean {
  return useAtomValue(allEnvironmentShellsBootstrappedAtom);
}

/** Whether one machine's chat list has arrived, whatever the others are doing. */
export function useEnvironmentShellLoaded(environmentId: EnvironmentId | null): boolean {
  const atom = useMemo(
    () =>
      environmentId === null ? SHELL_NOT_LOADED_ATOM : environmentShellLoadedAtom(environmentId),
    [environmentId],
  );
  return useAtomValue(atom);
}

export function useAllEnvironmentProjectSnapshotsReady(): boolean {
  return useAtomValue(allEnvironmentProjectSnapshotsReadyAtom);
}

export function useThreadShellsForProjectRefs(
  refs: ReadonlyArray<ScopedProjectRef>,
  includeIdleSubagents = false,
): ReadonlyArray<EnvironmentThreadShell> {
  const shells = includeIdleSubagents ? threadPickerShells : environmentThreadShells;
  return useAtomValue(shells.threadShellsForProjectRefsAtom(refs));
}

/** Load omitted project chats before an action that chooses among all of them. */
export async function loadProjectThreadShells(ref: ScopedProjectRef) {
  const state = appAtomRegistry.get(environmentShell.stateValueAtom(ref.environmentId));
  if (
    state.generation > 0 &&
    state.snapshot._tag === "Some" &&
    state.snapshot.value.idleAppOwnedSubagentsOmitted === true
  ) {
    await Effect.runPromise(
      AtomRegistry.getResult(appAtomRegistry, threadFamilies.allFamilyAtom(ref.environmentId), {
        suspendOnWaiting: true,
      }).pipe(Effect.ignore),
    );
  }
  return appAtomRegistry.get(threadPickerShells.threadShellsForProjectRefsAtom([ref]));
}

export function useProject(ref: ScopedProjectRef | null): EnvironmentProject | null {
  return useAtomValue(ref === null ? EMPTY_PROJECT_ATOM : environmentProjects.projectAtom(ref));
}

export function useThreadShell(
  ref: ScopedThreadRef | null,
  loadMissing = false,
): EnvironmentThreadShell | null {
  const shell = useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : environmentThreadShells.threadShellAtom(ref),
  );
  const detail = useThreadProjection(loadMissing && shell === null ? ref : null);
  return useMemo(
    () =>
      shell ?? (ref && detail ? threadDetailToShell(ref.environmentId, detail.projection) : null),
    [shell, ref, detail],
  );
}

const linkedThreadShellAtom = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) => {
    const shell = get(environmentThreadShells.threadShellAtom(ref));
    if (shell !== null) return shell;
    const state = get(environmentShell.stateValueAtom(ref.environmentId));
    if (
      state.snapshot._tag === "None" ||
      (state.snapshot.value.idleAppOwnedSubagentsOmitted !== true &&
        state.snapshot.value.idleSubagentsOmitted !== true)
    )
      return null;
    const row = get(createdChatShellAtom(ref));
    return row?.archivedAt === null && row.deletedAt === null
      ? presentThreadShell(ref.environmentId, row)
      : null;
  });
});

/** Read only the linked shell when the target belongs to a family elsewhere in the list. */
export function useLinkedThreadShell(ref: ScopedThreadRef | null): EnvironmentThreadShell | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_SHELL_ATOM : linkedThreadShellAtom(threadKey(ref)),
  );
}

export function useChildThreadInputs(ref: ScopedThreadRef | null) {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_SHELLS_ATOM : environmentThreadShells.childThreadInputsAtom(ref),
  );
}

export function useThreadProjection(ref: ScopedThreadRef | null): EnvironmentThread | null {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_PROJECTION_ATOM : environmentThreadDetails.threadAtom(ref),
  );
}

export function useThreadStatus(ref: ScopedThreadRef | null): EnvironmentThreadStatus {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_STATUS_ATOM : environmentThreadDetails.statusAtom(ref),
  );
}

export function useThreadHistory(ref: ScopedThreadRef | null): ThreadHistoryMeta {
  return useAtomValue(
    ref === null ? EMPTY_THREAD_HISTORY_ATOM : environmentThreadDetails.historyAtom(ref),
  );
}

export function resolveThreadDetailRef(
  ref: ScopedThreadRef | null,
  options: {
    shellExists: boolean;
    waitForShell: boolean;
  },
): ScopedThreadRef | null {
  return ref !== null && (!options.waitForShell || options.shellExists) ? ref : null;
}

/** Draft IDs are reserved locally. Neither lookup may load detail before creation. */
export function useThreadBootstrap(
  ref: ScopedThreadRef | null,
  options: { readonly waitForShell: boolean },
) {
  const shell = useThreadShell(ref, !options.waitForShell);
  return {
    shell,
    detailRef: resolveThreadDetailRef(ref, {
      shellExists: shell !== null,
      waitForShell: options.waitForShell,
    }),
  };
}

export function useThreadVisibleTurnItems(
  ref: ScopedThreadRef | null,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  return useAtomValue(
    ref === null
      ? EMPTY_VISIBLE_TURN_ITEMS_ATOM
      : environmentThreadDetails.visibleTurnItemsAtom(ref),
  );
}

export function readProject(ref: ScopedProjectRef): EnvironmentProject | null {
  return appAtomRegistry.get(environmentProjects.projectAtom(ref));
}

export function readProjects(): ReadonlyArray<EnvironmentProject> {
  return appAtomRegistry.get(environmentProjects.projectsAtom);
}

/** Resolves when the project event reaches the live client store. */
export function waitForProject(
  ref: ScopedProjectRef,
  timeoutMs = 10_000,
): Promise<EnvironmentProject> {
  const current = readProject(ref);
  if (current !== null) return Promise.resolve(current);

  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("The project did not appear in the desktop app."));
    }, timeoutMs);
    const finish = (project: EnvironmentProject | null) => {
      if (project === null) return;
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(project);
    };
    unsubscribe = appAtomRegistry.subscribe(environmentProjects.projectAtom(ref), finish);
    finish(readProject(ref));
  });
}

/**
 * Resolves once a deleted project leaves the live client store. The delete
 * command returns before the shell stream does, so anything that picks a
 * project in between (the index route's draft landing) still sees it.
 */
export function waitForProjectRemoval(ref: ScopedProjectRef, timeoutMs = 5_000): Promise<boolean> {
  return waitForAtomValue({
    registry: appAtomRegistry,
    atom: environmentProjects.projectAtom(ref),
    predicate: (project) => project === null,
    timeoutMs,
  });
}

export function readThreadShell(ref: ScopedThreadRef): EnvironmentThreadShell | null {
  return appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
}

export function waitForThreadShell(ref: ScopedThreadRef, timeoutMs = 5_000): Promise<boolean> {
  return waitForAtomValue({
    registry: appAtomRegistry,
    atom: environmentThreadShells.threadShellAtom(ref),
    predicate: (thread) => thread !== null,
    timeoutMs,
  });
}

/** Whether the environment hosts preview tabs in its own browser (`runtime: "server"`),
    so clients without Electron can still use the Browser panel. */
export function useEnvironmentSupportsServerBrowser(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return (
    environmentId !== null &&
    configs.get(environmentId)?.environment.capabilities.serverBrowser === true
  );
}

export function readEnvironmentSupportsServerBrowser(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .serverBrowser === true
  );
}

export function readEnvironmentSupportsTitleRegeneration(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadTitleRegeneration === true
  );
}

/** Whether the environment's server understands thread.pin/unpin.
    Same version-skew contract as settlement. */
export function readEnvironmentSupportsPinning(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinning === true
  );
}

/** Whether the environment's server understands thread.pin.reorder (and
    orderKey on thread.pin). Same version-skew contract as settlement. */
export function readEnvironmentSupportsPinReorder(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadPinReorder === true
  );
}

/** Whether the environment's server understands thread.auto-settle.set.
    Same version-skew contract as settlement. */
export function readEnvironmentSupportsAutoSettleOptOut(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadAutoSettleOptOut === true
  );
}

export function readEnvironmentSupportsActiveReorder(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadActiveReorder === true
  );
}

/** Whether the environment's server understands thread.settle/unsettle.
    False for pre-settlement servers (capability defaults false on decode),
    so clients under version skew fall back instead of erroring. */
export function readEnvironmentSupportsSettlement(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSettlement === true
  );
}

/** Whether the environment's server understands thread.snooze/unsnooze.
    Same version-skew contract as settlement. */
export function readEnvironmentSupportsSnooze(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadSnooze === true
  );
}

/** Whether the environment's server understands thread.visit/mark-unread and
    projects lastVisitedAt on thread shells. Same version-skew contract as
    settlement: against older servers, clients keep the browser-local visited
    state instead. */
export function readEnvironmentSupportsVisitedTracking(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .threadVisitedTracking === true
  );
}

export function readEnvironmentThreadRefs(
  environmentId: EnvironmentId,
): ReadonlyArray<ScopedThreadRef> {
  return appAtomRegistry.get(environmentThreadShells.environmentThreadRefsAtom(environmentId));
}

export function readThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  return appAtomRegistry.get(environmentThreadShells.threadShellsAtom);
}
