/**
 * A local record of which chat the user opened and what the chat list held at
 * that moment, for learning a better sidebar order. Each line has every
 * unsettled top-level chat's state and timestamps, never titles or text. It
 * stays in the server's state directory and is read only by local training.
 */
import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export const CHAT_VISIT_LOG_FILE = "chat-visits.ndjson";
const encodeLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const MAX_LOG_BYTES = 20 * 1024 * 1024;
// Clients repeat a visit while new output arrives in an open chat; those are not new choices.
const REVISIT_QUIET_MS = 60_000;

const iso = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.formatIso(value);

/** One chat as the ranking model sees it. Field names stay short: a line holds dozens. */
export const chatVisitCandidate = (thread: OrchestrationV2ThreadShell) => ({
  id: thread.id,
  status: thread.status,
  request: thread.pendingRuntimeRequest?.kind ?? null,
  requestAt: iso(thread.pendingRuntimeRequest?.createdAt),
  runRequestedAt: iso(thread.latestRunRequestedAt),
  runStartedAt: iso(thread.latestRunStartedAt),
  runCompletedAt: iso(thread.latestRunCompletedAt),
  activityRunStatus: thread.activityRunStatus ?? null,
  errorClass: thread.lastErrorClass ?? null,
  userMessageAt: iso(thread.latestUserAuthoredMessageAt ?? thread.latestUserMessageAt),
  planReady: thread.hasActionableProposedPlan,
  backgroundTasks: thread.pendingBackgroundTasks?.length ?? 0,
  visibleItems: thread.visibleItemCount,
  createdAt: iso(thread.createdAt),
  updatedAt: iso(thread.updatedAt),
  lastVisitedAt: iso(thread.lastVisitedAt),
  pinned: thread.pinnedAt != null,
  snoozedUntil: iso(thread.snoozedUntil),
  settled: thread.settledOverride,
  provider: thread.providerInstanceId,
  model: thread.modelSelection.model,
  relationship: thread.lineage.relationshipToParent ?? null,
  comparison: thread.comparison != null,
});

/** The line for one visit. `previousVisitAt` is the chat's read mark before this open. */
export const chatVisitRecord = (input: {
  readonly at: string;
  readonly threadId: ThreadId;
  readonly previousVisitAt: string | null;
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
}) => {
  const candidates = input.threads
    .filter(
      (thread) => thread.archivedAt === null && thread.lineage.relationshipToParent !== "subagent",
    )
    .map(chatVisitCandidate);
  return {
    version: 1,
    at: input.at,
    threadId: input.threadId,
    previousVisitAt: input.previousVisitAt,
    inList: candidates.some((candidate) => candidate.id === input.threadId),
    candidates,
  };
};

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = (yield* Path.Path).join(config.stateDir, CHAT_VISIT_LOG_FILE);
    // Each chat's read mark as of the last snapshot: a visit's own event already carries the new one.
    const readMarks = new Map<string, string | null>();
    const lastLogged = new Map<string, number>();

    // Candidates are top-level chats, but a visit to a subagent still needs its read mark.
    const snapshot = projections.getChatVisitSnapshot();
    const remember = (marks: ReadonlyArray<ProjectionStore.ProjectionReadMark>) => {
      for (const mark of marks) readMarks.set(mark.threadId, iso(mark.lastVisitedAt));
    };

    const append = (line: string) =>
      Effect.gen(function* () {
        const size = yield* fileSystem.stat(path).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.orElseSucceed(() => 0),
        );
        if (size > MAX_LOG_BYTES) yield* fileSystem.rename(path, `${path}.1`);
        yield* fileSystem.writeFileString(path, `${line}\n`, { flag: "a" });
      });

    const logVisit = (threadId: ThreadId, occurredAt: DateTime.Utc) =>
      Effect.gen(function* () {
        const atMs = DateTime.toEpochMillis(occurredAt);
        const previousMs = lastLogged.get(threadId);
        lastLogged.set(threadId, atMs);
        if (previousMs !== undefined && atMs - previousMs < REVISIT_QUIET_MS) return;
        const previousVisitAt = readMarks.get(threadId) ?? null;
        const { threads, readMarks: marks } = yield* snapshot;
        yield* append(
          encodeLine(
            chatVisitRecord({
              at: DateTime.formatIso(occurredAt),
              threadId,
              previousVisitAt,
              threads,
            }),
          ),
        );
        remember(marks);
      }).pipe(
        // A missed line only costs one training example; it must never disturb the server.
        Effect.catchCause((cause) => Effect.logDebug("Chat visit log skipped a visit", { cause })),
      );

    yield* forkParked(
      Effect.gen(function* () {
        remember(
          yield* snapshot.pipe(
            Effect.map(({ readMarks: marks }) => marks),
            Effect.orElseSucceed(() => []),
          ),
        );
        yield* Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
          event.type === "thread.visited"
            ? logVisit(event.threadId, event.occurredAt)
            : Effect.void,
        );
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("Chat visit log stopped", { cause }))),
    );
  }),
);
