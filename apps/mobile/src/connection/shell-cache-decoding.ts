import {
  StoredOrchestrationShellSnapshot,
  type Persistence,
} from "@t3tools/client-runtime/platform";
import {
  isHelperThreadId,
  NonNegativeInt,
  type EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import { pendingSubagentRequestsByThread } from "@t3tools/client-runtime/state/threads";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { homeMachineSummaries } from "../lib/thread-summaries";
import { deferPullRequests, detachPullRequests } from "@t3tools/client-runtime/state/shell";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";

export const SHELL_PREVIEW_THREAD_LIMIT = 64;
const StoredShellPreview = Schema.fromJsonString(
  StoredOrchestrationShellSnapshot.mapFields((fields) => ({
    ...fields,
    snapshot: fields.snapshot.mapFields((snapshot) => ({
      ...snapshot,
      previewCounts: Schema.optionalKey(
        Schema.Struct({
          visibleChats: NonNegativeInt,
          needsYou: NonNegativeInt,
          unread: Schema.Boolean,
          working: NonNegativeInt,
          pendingInput: NonNegativeInt,
        }),
      ),
    })),
  })),
);
export const decodeStoredShellPreview = Schema.decodeUnknownEffect(StoredShellPreview);
export const encodeStoredShellPreview = Schema.encodeEffect(StoredShellPreview);

/** Selected during persistence, never by parsing the full cache at startup. */
export function firstScreenShellSnapshot(
  snapshot: OrchestrationV2ShellSnapshot,
  environmentId: EnvironmentId,
): Persistence.EnvironmentShellPreview {
  const visible = snapshot.threads.filter((thread) => !isHelperThreadId(thread.id));
  const requests = pendingSubagentRequestsByThread(visible);
  // Child requests affect a parent's badge, but children have no preview row or count.
  const topLevel = visible.filter((thread) => thread.lineage.relationshipToParent !== "subagent");
  const navigation = topLevel
    .filter((thread) => thread.archivedAt === null)
    .map((thread) => presentThreadShell(environmentId, thread, requests.get(thread.id) ?? null));
  const machine = homeMachineSummaries(navigation).get(environmentId);
  const previewCounts: Persistence.ShellPreviewCounts = {
    visibleChats: navigation.length,
    needsYou: machine?.needsYou ?? 0,
    unread: machine?.unread ?? false,
    working: navigation.filter(isThreadWorking).length,
    pendingInput: navigation.filter(
      (thread) => thread.hasPendingApprovals || thread.hasPendingUserInput,
    ).length,
  };
  const priority = (thread: OrchestrationV2ThreadShell) =>
    thread.pinnedAt != null
      ? 0
      : thread.pendingRuntimeRequest != null ||
          ["preparing", "starting", "running", "waiting"].includes(thread.status)
        ? 1
        : thread.settledOverride === "settled"
          ? 3
          : 2;
  const threads = topLevel
    .map((thread) => ({
      thread,
      priority: priority(thread),
      at: DateTime.toEpochMillis(thread.updatedAt),
    }))
    .sort(
      (left, right) =>
        left.priority - right.priority ||
        right.at - left.at ||
        left.thread.id.localeCompare(right.thread.id),
    )
    .slice(0, SHELL_PREVIEW_THREAD_LIMIT)
    .map(({ thread }) => thread);
  const projects = new Set(threads.map((thread) => thread.projectId));
  return {
    ...snapshot,
    projects: snapshot.projects.filter((project) => projects.has(project.id)),
    threads,
    archivedThreads: [],
    previewCounts,
  };
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeStoredShell = Schema.decodeUnknownEffect(StoredOrchestrationShellSnapshot);

/**
 * Decode the shell cache payload with each thread's pull request links left out, so the
 * thread list can paint first; `loadPullRequests` decodes the links afterwards.
 */
export const decodeStoredShellSnapshot = Effect.fnUntraced(function* (raw: string) {
  const parsed = yield* decodeJson(raw);
  const rawLinks = Predicate.isObject(parsed) ? detachPullRequests(parsed.snapshot) : [];
  const stored = yield* decodeStoredShell(parsed);
  return { ...stored, snapshot: deferPullRequests(stored.snapshot, rawLinks) };
});
