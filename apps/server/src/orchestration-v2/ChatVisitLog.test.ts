import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ChatVisitLog from "./ChatVisitLog.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

const shell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: `private title ${id}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 4,
    createdAt: at("2026-10-28T09:00:00.000Z"),
    updatedAt: at("2026-10-28T09:00:00.000Z"),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
};

// The logger reads only the type, chat and time of a visit.
const visit = (threadId: string, occurredAt: string) =>
  ({
    type: "thread.visited",
    threadId: ThreadId.make(threadId),
    occurredAt: at(occurredAt),
  }) as unknown as OrchestrationV2DomainEvent;

it.live("records each new chat opening with the list's state, never its titles", () =>
  Effect.gen(function* () {
    // The store already leaves subagents out of the candidates; their read marks remain.
    const threads = [
      shell("asked", {
        status: "running",
        lastVisitedAt: at("2026-10-28T10:00:00.000Z"),
        latestRunStartedAt: at("2026-10-28T10:30:00.000Z"),
      }),
      shell("finished", { latestRunCompletedAt: at("2026-10-28T11:00:00.000Z") }),
    ];
    const readMarks = [
      { threadId: ThreadId.make("asked"), lastVisitedAt: at("2026-10-28T10:00:00.000Z") },
      { threadId: ThreadId.make("finished"), lastVisitedAt: null },
      { threadId: ThreadId.make("child"), lastVisitedAt: at("2026-10-28T11:30:00.000Z") },
    ];
    const streamDone = yield* Deferred.make<void>();
    const orchestrator = Layer.mock(Orchestrator.OrchestratorV2)({
      streamDomainEvents: Stream.fromIterable([
        visit("asked", "2026-10-28T12:00:00.000Z"),
        // Clients repeat the visit while output arrives in the open chat.
        visit("asked", "2026-10-28T12:00:30.000Z"),
        visit("finished", "2026-10-28T12:02:00.000Z"),
        visit("child", "2026-10-28T12:03:00.000Z"),
      ]).pipe(
        // Pulled only after the last visit is written.
        Stream.concat(
          Stream.fromEffect(Deferred.succeed(streamDone, undefined)).pipe(Stream.drain),
        ),
      ),
    });
    const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getChatVisitSnapshot: () => Effect.succeed({ threads, readMarks }),
    });
    const config = ServerConfig.layerTest(process.cwd(), { prefix: "t3-chat-visit-log-" });
    const text = yield* Effect.gen(function* () {
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const file = (yield* Path.Path).join(stateDir, ChatVisitLog.CHAT_VISIT_LOG_FILE);
      yield* Layer.build(
        ChatVisitLog.layer.pipe(Layer.provide(Layer.merge(orchestrator, projections))),
      );
      yield* Deferred.await(streamDone);
      return yield* fileSystem.readFileString(file);
    }).pipe(Effect.scoped, Effect.provide(config.pipe(Layer.provideMerge(NodeServices.layer))));

    const lines = text
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.threadId)).toEqual(["asked", "finished", "child"]);
    expect(lines[0]).toMatchObject({
      version: 1,
      at: "2026-10-28T12:00:00.000Z",
      previousVisitAt: "2026-10-28T10:00:00.000Z",
      inList: true,
    });
    expect(lines[0].candidates.map((candidate: { id: string }) => candidate.id)).toEqual([
      "asked",
      "finished",
    ]);
    expect(lines[0].candidates[0]).toMatchObject({
      status: "running",
      runStartedAt: "2026-10-28T10:30:00.000Z",
      model: "gpt-6.1-sol",
      visibleItems: 4,
    });
    // A subagent is never a candidate, but its own visit keeps its earlier read mark.
    expect(lines[2]).toMatchObject({
      previousVisitAt: "2026-10-28T11:30:00.000Z",
      inList: false,
    });
    expect(text).not.toContain("private title");
  }).pipe(Effect.provide(NodeServices.layer)),
);
