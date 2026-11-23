import {
  OrchestrationV2ThreadShell,
  ThreadPullRequestLink,
  type OrchestrationProjectShell,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ShellStreamItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

const sameThreadShell = Schema.toEquivalence(OrchestrationV2ThreadShell);
const sameLinks = Schema.toEquivalence(Schema.UndefinedOr(Schema.Array(ThreadPullRequestLink)));

/** Whether two rows' pull request links are equal, including both absent. */
export function sameThreadPullRequests(
  left: OrchestrationV2ThreadShell["pullRequests"],
  right: OrchestrationV2ThreadShell["pullRequests"],
): boolean {
  return left === right || sameLinks(left, right);
}

/**
 * Keep the previous object for each row a full snapshot left unchanged, so the list only
 * re-renders rows that changed. Links are compared apart from the rest of the row because a
 * deferred snapshot arrives without them; such a row keeps its links until they fill in.
 */
export function reuseUnchangedThreadShells(
  previous: OrchestrationV2ShellSnapshot | null,
  next: OrchestrationV2ShellSnapshot,
): OrchestrationV2ShellSnapshot {
  if (previous === null || previous.threads.length === 0) return next;
  const previousById = new Map(previous.threads.map((thread) => [thread.id, thread] as const));
  let reused = 0;
  const threads = next.threads.map((thread) => {
    const prior = previousById.get(thread.id);
    if (prior === undefined) return thread;
    const candidate =
      thread.pullRequests === undefined && prior.pullRequests !== undefined
        ? { ...thread, pullRequests: prior.pullRequests }
        : thread;
    if (!sameThreadShell(prior, candidate)) return thread;
    reused += 1;
    return prior;
  });
  return reused === 0 ? next : { ...next, threads };
}

function upsertById<T extends { readonly id: unknown }>(
  items: ReadonlyArray<T>,
  item: T,
): ReadonlyArray<T> {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) return [...items, item];
  return items.map((candidate, candidateIndex) => (candidateIndex === index ? item : candidate));
}

function retainRepositoryIdentity(
  previous: OrchestrationProjectShell | undefined,
  next: OrchestrationProjectShell,
): OrchestrationProjectShell {
  if (
    next.repositoryIdentity == null &&
    previous?.repositoryIdentity != null &&
    previous.workspaceRoot === next.workspaceRoot
  ) {
    return { ...next, repositoryIdentity: previous.repositoryIdentity };
  }
  return next;
}

export interface MergeShellSnapshotOptions {
  /**
   * Metadata-only enrichment refresh: structure and sequence never change;
   * listed roots accept identity exactly (including null).
   * Omit this options object for authoritative HTTP/initial WebSocket snapshots.
   */
  readonly resolvedRepositoryIdentityRoots: ReadonlyArray<string>;
}

/**
 * Merge an incoming full shell snapshot into prior client state.
 *
 * Authoritative snapshots (no options) replace structure and sequence even when
 * lower than cache, while retaining a prior non-null identity when the candidate
 * is still unresolved/null for the same root.
 *
 * Enrichment snapshots (options present) only patch repository identity for
 * matching current projects and box fields (`boxName`, `latestRequest`, `boxFace`, `chatTab`,
 * long-running placement, activity, and the subagents switch) for
 * matching current threads. They never replace projects, threads, archives,
 * or sequence, regardless of the incoming snapshot sequence.
 */
export function mergeShellSnapshotProjects(
  previous: OrchestrationV2ShellSnapshot | null | undefined,
  next: OrchestrationV2ShellSnapshot,
  options?: MergeShellSnapshotOptions,
): OrchestrationV2ShellSnapshot {
  if (previous === null || previous === undefined) {
    return next;
  }

  const isEnrichment = options !== undefined;
  const resolvedRootSet = isEnrichment ? new Set(options.resolvedRepositoryIdentityRoots) : null;

  if (isEnrichment) {
    const nextById = new Map(next.projects.map((project) => [project.id, project] as const));
    // Box names from the server's local model ride enrichment frames too: they patch only
    // the box fields of threads this client already has.
    const namedById = new Map(next.threads.map((thread) => [thread.id, thread] as const));
    return {
      ...previous,
      threads:
        namedById.size === 0
          ? previous.threads
          : previous.threads.map((thread) => {
              const named = namedById.get(thread.id);
              return named === undefined ||
                (named.boxName === thread.boxName &&
                  named.latestRequest === thread.latestRequest &&
                  named.boxFace === thread.boxFace &&
                  sameChatTab(named.chatTab, thread.chatTab) &&
                  sameComparison(named.comparison, thread.comparison) &&
                  sameChatControls(named, thread))
                ? thread
                : {
                    ...thread,
                    boxName: named.boxName,
                    latestRequest: named.latestRequest,
                    boxFace: named.boxFace,
                    chatTab: named.chatTab,
                    comparison: named.comparison ?? null,
                    // An omitted field is the default, so a later frame can clear a previous value.
                    longRunningOverride: named.longRunningOverride ?? null,
                    activityDayCount: named.activityDayCount ?? 0,
                    activityLastAt: named.activityLastAt ?? null,
                    nextScheduledRunAt: named.nextScheduledRunAt ?? null,
                    // The app's own monitors start and end without a transcript event.
                    ...(sameLongRunningWork(named.longRunningWork, thread.longRunningWork)
                      ? {}
                      : { longRunningWork: named.longRunningWork }),
                    subagentsEnabled: named.subagentsEnabled !== false,
                    firstSubagentAsk: named.firstSubagentAsk,
                  };
            }),
      projects: previous.projects.map((project) => {
        const candidate = nextById.get(project.id);
        if (candidate === undefined || candidate.workspaceRoot !== project.workspaceRoot) {
          return project;
        }
        if (resolvedRootSet?.has(project.workspaceRoot) === true) {
          return { ...project, repositoryIdentity: candidate.repositoryIdentity };
        }
        if (project.repositoryIdentity == null && candidate.repositoryIdentity != null) {
          return { ...project, repositoryIdentity: candidate.repositoryIdentity };
        }
        return project;
      }),
    };
  }

  const previousById = new Map(previous.projects.map((project) => [project.id, project] as const));
  return {
    ...next,
    projects: next.projects.map((project) => {
      const prior = previousById.get(project.id);
      if (resolvedRootSet?.has(project.workspaceRoot) === true) {
        return project;
      }
      return retainRepositoryIdentity(prior, project);
    }),
  };
}

/** Applies one committed V2 shell delta while preserving active/archive exclusivity. */
export function applyShellStreamEvent(
  snapshot: OrchestrationV2ShellSnapshot,
  event: Exclude<
    OrchestrationV2ShellStreamItem,
    { readonly kind: "snapshot" } | { readonly kind: "synchronized" }
  >,
): OrchestrationV2ShellSnapshot {
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project.updated": {
      // Enrichment is async. A project mutation can land with null
      // repositoryIdentity while an earlier snapshot already resolved it.
      // Keep the prior identity for the same workspace root so multi-env
      // grouping does not split until a full snapshot refresh arrives.
      const previous = snapshot.projects.find((project) => project.id === event.project.id);
      const project = retainRepositoryIdentity(previous, event.project);
      return {
        ...snapshot,
        projects: upsertById(snapshot.projects, project),
        snapshotSequence: event.sequence,
      };
    }
    case "project.removed":
      return {
        ...snapshot,
        projects: snapshot.projects.filter((project) => project.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread.updated": {
      // An unchanged shell keeps its object and the list, so subscribers that
      // compare by reference skip the update. Only the cursor moves.
      const existing =
        event.location === "active"
          ? snapshot.threads.find((thread) => thread.id === event.thread.id)
          : undefined;
      if (existing !== undefined && sameThreadShell(existing, event.thread)) {
        return { ...snapshot, snapshotSequence: event.sequence };
      }
      const withoutThread = (threads: OrchestrationV2ShellSnapshot["threads"]) =>
        threads.filter((thread) => thread.id !== event.thread.id);
      return {
        ...snapshot,
        threads:
          event.location === "active"
            ? upsertById(snapshot.threads, event.thread)
            : withoutThread(snapshot.threads),
        // The archive has its own bounded query/subscription. Older servers may
        // still send archive-located deltas here; remove them from the normal
        // shell instead of growing its persisted cache again.
        archivedThreads: withoutThread(snapshot.archivedThreads),
        snapshotSequence: event.sequence,
      };
    }
    case "thread.removed":
      return {
        ...snapshot,
        threads: snapshot.threads.filter((thread) => thread.id !== event.threadId),
        archivedThreads: snapshot.archivedThreads.filter((thread) => thread.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    default:
      return snapshot;
  }
}

export type ShellStreamEvent = Exclude<
  OrchestrationV2ShellStreamItem,
  { readonly kind: "snapshot" } | { readonly kind: "synchronized" }
>;

/** Fold a replay chunk with one index and array materialization per collection. */
export function applyShellStreamEvents(
  snapshot: OrchestrationV2ShellSnapshot,
  events: ReadonlyArray<ShellStreamEvent>,
): OrchestrationV2ShellSnapshot {
  if (events.length === 1) return applyShellStreamEvent(snapshot, events[0]!);
  let sequence = snapshot.snapshotSequence;
  let projects: Map<OrchestrationProjectShell["id"], OrchestrationProjectShell> | undefined;
  let threads: Map<OrchestrationV2ThreadShell["id"], OrchestrationV2ThreadShell> | undefined;
  let archived: Map<OrchestrationV2ThreadShell["id"], OrchestrationV2ThreadShell> | undefined;
  const activeThreads = () =>
    (threads ??= new Map(snapshot.threads.map((thread) => [thread.id, thread])));
  const archivedThreads = () =>
    (archived ??= new Map(snapshot.archivedThreads.map((thread) => [thread.id, thread])));
  let threadsChanged = false;
  let archivedChanged = false;
  for (const event of events) {
    if (event.sequence <= sequence) continue;
    sequence = event.sequence;
    switch (event.kind) {
      case "project.updated": {
        projects ??= new Map(snapshot.projects.map((project) => [project.id, project]));
        projects.set(
          event.project.id,
          retainRepositoryIdentity(projects.get(event.project.id), event.project),
        );
        break;
      }
      case "project.removed":
        projects ??= new Map(snapshot.projects.map((project) => [project.id, project]));
        projects.delete(event.projectId);
        break;
      case "thread.updated": {
        const active = activeThreads();
        const existing = event.location === "active" ? active.get(event.thread.id) : undefined;
        if (existing !== undefined && sameThreadShell(existing, event.thread)) break;
        if (event.location === "active") {
          active.set(event.thread.id, event.thread);
          threadsChanged = true;
        } else {
          threadsChanged = active.delete(event.thread.id) || threadsChanged;
        }
        archivedChanged = archivedThreads().delete(event.thread.id) || archivedChanged;
        break;
      }
      case "thread.removed":
        threadsChanged = activeThreads().delete(event.threadId) || threadsChanged;
        archivedChanged = archivedThreads().delete(event.threadId) || archivedChanged;
        break;
    }
  }
  return sequence === snapshot.snapshotSequence
    ? snapshot
    : {
        ...snapshot,
        snapshotSequence: sequence,
        projects: projects === undefined ? snapshot.projects : [...projects.values()],
        threads: threadsChanged ? [...threads!.values()] : snapshot.threads,
        archivedThreads: archivedChanged ? [...archived!.values()] : snapshot.archivedThreads,
      };
}

function sameInstant(
  left: DateTime.Utc | null | undefined,
  right: DateTime.Utc | null | undefined,
): boolean {
  if (left == null || right == null) return (left ?? null) === (right ?? null);
  return DateTime.formatIso(left) === DateTime.formatIso(right);
}

function sameLongRunningWork(
  left: OrchestrationV2ThreadShell["longRunningWork"],
  right: OrchestrationV2ThreadShell["longRunningWork"],
): boolean {
  return (
    (left?.monitorCount ?? 0) === (right?.monitorCount ?? 0) &&
    (left?.backgroundTaskCount ?? 0) === (right?.backgroundTaskCount ?? 0) &&
    (left?.runningSubagentCount ?? 0) === (right?.runningSubagentCount ?? 0)
  );
}

function sameChatControls(
  named: OrchestrationV2ThreadShell,
  thread: OrchestrationV2ThreadShell,
): boolean {
  return (
    (named.longRunningOverride ?? null) === (thread.longRunningOverride ?? null) &&
    (named.activityDayCount ?? 0) === (thread.activityDayCount ?? 0) &&
    sameInstant(named.activityLastAt, thread.activityLastAt) &&
    (named.nextScheduledRunAt ?? null) === (thread.nextScheduledRunAt ?? null) &&
    sameLongRunningWork(named.longRunningWork, thread.longRunningWork) &&
    (named.subagentsEnabled !== false) === (thread.subagentsEnabled !== false) &&
    named.firstSubagentAsk === thread.firstSubagentAsk
  );
}

function sameChatTab(
  left: OrchestrationV2ThreadShell["chatTab"],
  right: OrchestrationV2ThreadShell["chatTab"],
): boolean {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.name === right.name &&
      left.position === right.position &&
      left.manual === right.manual)
  );
}

function sameComparison(
  left: OrchestrationV2ThreadShell["comparison"],
  right: OrchestrationV2ThreadShell["comparison"],
): boolean {
  if (left == null || right == null) return left == null && right == null;
  return (
    left === right ||
    (left.id === right.id &&
      left.title === right.title &&
      left.threadIds.length === right.threadIds.length &&
      left.threadIds.every((id, index) => id === right.threadIds[index]))
  );
}
