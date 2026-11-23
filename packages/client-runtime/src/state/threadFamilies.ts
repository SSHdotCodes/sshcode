import {
  ORCHESTRATION_V2_WS_METHODS,
  EnvironmentId,
  isLiveSubagentShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadFamily,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type * as EnvironmentRegistry from "../connection/registry.ts";
import { EnvironmentRpcUnavailableError, request } from "../rpc/client.ts";
import { arrayElementsEqual } from "./entities.ts";
import { createEnvironmentQueryAtomFamily } from "./runtime.ts";
import type { EnvironmentShellState } from "./shell.ts";

const FamilyKeyJson = Schema.fromJsonString(Schema.Tuple([EnvironmentId, Schema.NullOr(ThreadId)]));
const decodeFamilyKey = Schema.decodeSync(FamilyKeyJson);
const encodeFamilyKey = Schema.encodeSync(FamilyKeyJson);

const EMPTY_FAMILY: OrchestrationV2ThreadFamily = { snapshotSequence: 0, threads: [] };
const EMPTY_MOUNTS: ReadonlyMap<ThreadId, number> = new Map();
// Generation 0 is the cached shell from before this session's first authoritative snapshot. A read
// for it would be thrown away once that snapshot lands, so it waits instead.
const AWAITING_AUTHORITATIVE_SHELL = AsyncResult.initial<never, never>(true);

/** Whether a family read can decide anything yet. Only a settled read can prove a thread is gone. */
export type ThreadFamilyRead = "pending" | "failed" | "settled";

export function threadFamilyRead(
  result: AsyncResult.AsyncResult<OrchestrationV2ThreadFamily, unknown>,
): ThreadFamilyRead {
  // A failure whose retry is in flight is pending, so callers do not restart that retry.
  if (result.waiting) return "pending";
  if (AsyncResult.isFailure(result)) return "failed";
  return AsyncResult.isSuccess(result) ? "settled" : "pending";
}

/**
 * Family rows the shell does not have. A shell row is at least as new as any family copy, since
 * shell deltas carry every change; a family copy read before the shell removed that thread is
 * stale.
 */
export function threadFamilyRowsMissingFromShell(input: {
  readonly shellThreads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly families: ReadonlyArray<OrchestrationV2ThreadFamily>;
  readonly removedAt: ReadonlyMap<ThreadId, number>;
}): ReadonlyArray<OrchestrationV2ThreadShell> {
  if (input.families.length === 0) return [];
  const present = new Set<ThreadId>(input.shellThreads.map((thread) => thread.id));
  const missing = new Map<ThreadId, { thread: OrchestrationV2ThreadShell; sequence: number }>();
  for (const family of input.families) {
    for (const thread of family.threads) {
      if (present.has(thread.id)) continue;
      if ((input.removedAt.get(thread.id) ?? -1) >= family.snapshotSequence) continue;
      if ((missing.get(thread.id)?.sequence ?? -1) >= family.snapshotSequence) continue;
      missing.set(thread.id, { thread, sequence: family.snapshotSequence });
    }
  }
  return Array.from(missing.values(), ({ thread }) => thread);
}

/**
 * Shells that omit idle subagent children (`omitIdleSubagents`) leave those rows to thread
 * families: the active subagent tree that shares a thread's `lineage.rootThreadId`. A view, or a
 * queued message, mounts the family it needs; it is read once per shell generation. Family rows
 * merge behind shell rows and are never persisted. Shell deltas still carry every change, so a
 * changed child always arrives as a shell row, which wins.
 */
export function createThreadFamilyAtoms<R, ER, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  shellStateAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentShellState, E>>,
) {
  const shellStateValue = (state: AsyncResult.AsyncResult<EnvironmentShellState, E>) =>
    Option.getOrNull(AsyncResult.value(state));
  const generationAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => shellStateValue(get(shellStateAtom(environmentId)))?.generation ?? 0).pipe(
      Atom.withLabel(`environment-shell-generation:${environmentId}`),
    ),
  );

  // The generation is part of the key, so a read from before the latest authoritative snapshot is
  // never used again, even while a new read is pending or failed.
  const familyQueryAtom = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:thread-family",
    staleTimeMs: Number.POSITIVE_INFINITY,
    idleTtlMs: 60_000,
    execute: Effect.fn("ThreadFamilies.read")(function* (input: {
      readonly threadId: ThreadId | null;
      readonly generation: number;
    }) {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const session = yield* SubscriptionRef.get(supervisor.session);
      if (Option.isNone(session)) {
        return yield* new EnvironmentRpcUnavailableError({
          environmentId: supervisor.target.environmentId,
          message: "The environment has no session.",
        });
      }
      // A config failure fails the read: an empty family would read as "the thread is gone".
      const config = yield* session.value.initialConfig;
      // Servers without families send every child in the shell, so absent means gone.
      if (config.shellThreadFamilies !== true) return EMPTY_FAMILY;
      if (input.threadId === null && config.shellAppOwnedSubagentOmission !== true) {
        return EMPTY_FAMILY;
      }
      return yield* request(
        ORCHESTRATION_V2_WS_METHODS.getThreadFamily,
        input.threadId === null ? { all: true } : { threadId: input.threadId },
      );
    }),
  });
  const queryFor = (environmentId: EnvironmentId, threadId: ThreadId | null, generation: number) =>
    familyQueryAtom({ environmentId, input: { threadId, generation } });

  const familyAtom = Atom.family((key: string) => {
    const [environmentId, threadId] = decodeFamilyKey(key);
    return Atom.make((get) => {
      const generation = get(generationAtom(environmentId));
      return generation === 0
        ? AWAITING_AUTHORITATIVE_SHELL
        : get(queryFor(environmentId, threadId, generation));
    }).pipe(Atom.withLabel(`environment-thread-family:${key}`));
  });
  const familyKey = (environmentId: EnvironmentId, threadId: ThreadId | null) =>
    encodeFamilyKey([environmentId, threadId]);

  /** Reads the current generation's family again, so a failed read does not last the session. */
  const refresh = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => {
    const generation = registry.get(generationAtom(environmentId));
    if (generation !== 0) registry.refresh(queryFor(environmentId, threadId, generation));
  };

  const mountsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(EMPTY_MOUNTS).pipe(
      Atom.keepAlive,
      Atom.withLabel(`environment-thread-family-mounts:${environmentId}`),
    ),
  );

  /** Keeps a thread's family in the merged rows until the returned release runs. */
  const mount = (
    registry: AtomRegistry.AtomRegistry,
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ): (() => void) => {
    const atom = mountsAtom(environmentId);
    const mounts = registry.get(atom);
    registry.set(atom, new Map(mounts).set(threadId, (mounts.get(threadId) ?? 0) + 1));
    // Mounting again after a failure retries instead of keeping the failure until reconnect.
    if (
      threadFamilyRead(registry.get(familyAtom(familyKey(environmentId, threadId)))) === "failed"
    ) {
      refresh(registry, environmentId, threadId);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = new Map(registry.get(atom));
      const count = (next.get(threadId) ?? 0) - 1;
      if (count > 0) next.set(threadId, count);
      else next.delete(threadId);
      registry.set(atom, next);
    };
  };

  // A child can wake after the snapshot without changing its idle ancestors. Recover the
  // missing links for request propagation and the Discord list from just that child's family.
  const omittedThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const state = shellStateValue(get(shellStateAtom(environmentId)));
      const snapshot = state && Option.getOrNull(state.snapshot);
      return snapshot?.idleAppOwnedSubagentsOmitted ? snapshot.threads : null;
    }),
  );
  const removedAtAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => shellStateValue(get(shellStateAtom(environmentId)))?.removedAt),
  );
  const missingRootsAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => {
      const roots = new Set<ThreadId>();
      const threads = get(omittedThreadsAtom(environmentId));
      if (threads === null) return roots;
      const removedAt = get(removedAtAtom(environmentId));
      let byId: Map<ThreadId, OrchestrationV2ThreadShell> | undefined;
      const walked = new Set<ThreadId>();
      for (const thread of threads) {
        if (!isLiveSubagentShell(thread) && thread.status !== "failed") continue;
        // A gap anywhere between a waiting child and its lead hides the lead's badge, so
        // walk up from the child rather than stopping at its immediate parent.
        let current = thread;
        while (current.lineage.relationshipToParent === "subagent" && !walked.has(current.id)) {
          walked.add(current.id);
          const { parentThreadId, parentEnvironmentId } = current.lineage;
          if (parentThreadId === null || parentEnvironmentId !== undefined) break;
          byId ??= new Map(threads.map((row) => [row.id, row]));
          const parent = byId.get(parentThreadId);
          if (parent === undefined) {
            if (!removedAt?.has(parentThreadId)) roots.add(current.lineage.rootThreadId);
            break;
          }
          current = parent;
        }
      }
      return roots;
    }),
  );

  const snapshotAtom = Atom.family((environmentId: EnvironmentId) => {
    let previous: {
      readonly snapshot: OrchestrationV2ShellSnapshot;
      readonly removedAt: ReadonlyMap<ThreadId, number>;
      readonly families: ReadonlyArray<OrchestrationV2ThreadFamily>;
      readonly merged: OrchestrationV2ShellSnapshot;
    } | null = null;
    return Atom.make((get): OrchestrationV2ShellSnapshot | null => {
      const state = shellStateValue(get(shellStateAtom(environmentId)));
      const snapshot = state === null ? null : Option.getOrNull(state.snapshot);
      const mounts = get(mountsAtom(environmentId));
      if (snapshot === null || state === null) return snapshot;
      const missing = get(missingRootsAtom(environmentId));
      const roots = mounts.size === 0 ? missing : new Set([...missing, ...mounts.keys()]);
      if (roots.size === 0) return snapshot;
      const families = Array.from(roots).flatMap((threadId) => {
        const family = Option.getOrNull(
          AsyncResult.value(get(familyAtom(familyKey(environmentId, threadId)))),
        );
        return family === null ? [] : [family];
      });
      // Most shell updates move only the cursor. With the same rows, removals and families, keep
      // the merged rows so thread lists skip their rebuild.
      const unchanged =
        previous !== null &&
        previous.snapshot.threads === snapshot.threads &&
        previous.removedAt === state.removedAt &&
        arrayElementsEqual(previous.families, families);
      if (unchanged && previous !== null && previous.snapshot === snapshot) return previous.merged;
      let merged: OrchestrationV2ShellSnapshot;
      if (unchanged && previous !== null) {
        merged =
          previous.merged === previous.snapshot
            ? snapshot
            : { ...snapshot, threads: previous.merged.threads };
      } else {
        const extras = threadFamilyRowsMissingFromShell({
          shellThreads: snapshot.threads,
          removedAt: state.removedAt,
          families,
        });
        merged =
          extras.length === 0
            ? snapshot
            : { ...snapshot, threads: [...snapshot.threads, ...extras] };
      }
      previous = { snapshot, removedAt: state.removedAt, families, merged };
      return merged;
    }).pipe(Atom.withLabel(`environment-snapshot-with-families:${environmentId}`));
  });

  const allSnapshotAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get): OrchestrationV2ShellSnapshot | null => {
      const snapshot = get(snapshotAtom(environmentId));
      if (snapshot?.idleAppOwnedSubagentsOmitted !== true) return snapshot;
      const state = shellStateValue(get(shellStateAtom(environmentId)));
      const family = Option.getOrNull(
        AsyncResult.value(get(familyAtom(familyKey(environmentId, null)))),
      );
      if (family === null || state === null) return snapshot;
      const extras = threadFamilyRowsMissingFromShell({
        shellThreads: snapshot.threads,
        removedAt: state.removedAt,
        families: [family],
      });
      return extras.length === 0
        ? snapshot
        : { ...snapshot, threads: [...snapshot.threads, ...extras] };
    }).pipe(Atom.withLabel(`environment-snapshot-with-all-subagents:${environmentId}`)),
  );

  return {
    /** The shell snapshot plus the rows of every mounted family. */
    snapshotAtom,
    /** On-demand rows for a picker spanning every family in an environment. */
    allSnapshotAtom,
    allFamilyAtom: (environmentId: EnvironmentId) => familyAtom(familyKey(environmentId, null)),
    /** The current generation's family read, for decisions that need a settled answer. */
    familyAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      familyAtom(familyKey(environmentId, threadId)),
    mount,
    refresh,
  };
}
