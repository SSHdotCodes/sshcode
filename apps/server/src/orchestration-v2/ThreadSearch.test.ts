import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";
import * as EventStore from "./EventStore.ts";
import * as Config from "../config.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";

let backgroundAllowed = true;
const policy = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  shouldRunOpportunisticWork: Effect.sync(() => backgroundAllowed),
});
const configLayer = Layer.effect(
  Config.ServerConfig,
  Effect.gen(function* () {
    const config = yield* Config.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(config.stateDir, { recursive: true });
    yield* fs.writeFileString(
      `${config.stateDir}/search-index-config.json`,
      '{"model":"fake","url":"http://127.0.0.1:0/v1"}',
    );
    return config;
  }),
).pipe(
  Layer.provide(Config.layerTest(process.cwd(), { prefix: "thread-search-" })),
  Layer.provide(NodeServices.layer),
);

const layerTest = Layer.mergeAll(
  ThreadSearch.layer,
  ProjectionStore.layer,
  ProjectStore.layer,
).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(policy),
  Layer.provideMerge(configLayer),
  Layer.provideMerge(NodeServices.layer),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: { readonly archivedAt?: DateTime.Utc; readonly deletedAt?: DateTime.Utc } = {},
): Extract<OrchestrationV2DomainEvent, { type: "thread.created" }> => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

const message = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: { readonly minute?: number; readonly streaming?: boolean; readonly runId?: RunId } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(options.minute ?? 1),
  payload: {
    createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(id),
    threadId,
    runId: options.runId ?? null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: options.streaming ?? false,
    createdAt: at(options.minute ?? 1),
    updatedAt: at(options.minute ?? 1),
  },
});

const run = (
  owner: ThreadId,
  status: "running" | "rolled_back" | "cancelled",
  options: { readonly retainQueuedMessage?: true } = {},
) =>
  ({
    id: EventId.make(`run:${owner}:${status}`),
    type: status === "running" ? "run.created" : "run.updated",
    threadId: owner,
    runId: RunId.make(`run:${owner}`),
    nodeId: NodeId.make(`node:${owner}`),
    providerInstanceId,
    occurredAt: at(2),
    payload: {
      ...options,
      id: RunId.make(`run:${owner}`),
      threadId: owner,
      ordinal: 1,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
      providerThreadId: null,
      userMessageId: MessageId.make(`${owner}:prompt`),
      rootNodeId: NodeId.make(`node:${owner}`),
      activeAttemptId: null,
      status,
      requestedAt: at(1),
      startedAt: at(1),
      completedAt: status === "running" ? null : at(2),
      checkpointId: null,
      contextHandoffId: null,
    },
  }) satisfies OrchestrationV2DomainEvent;

const shown = (owner: ThreadId, id: string, as: "turn_start" | "queued_turn" | "reply") =>
  ({
    id: EventId.make(`item:${id}`),
    type: "turn-item.updated",
    threadId: owner,
    occurredAt: at(2),
    payload: {
      id: TurnItemId.make(id),
      threadId: owner,
      runId: RunId.make(`run:${owner}`),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: at(1),
      completedAt: at(1),
      updatedAt: at(1),
      messageId: MessageId.make(id),
      text: "",
      ...(as === "reply"
        ? { type: "assistant_message", streaming: false }
        : {
            type: "user_message",
            inputIntent: as,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          }),
    },
  }) satisfies OrchestrationV2DomainEvent;

it.layer(layerTest)("ThreadSearch", (it) => {
  it.effect("leaves out rolled-back turns and cancelled queued prompts the chat hides", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:hidden-turns");
      const rewound = ThreadId.make("thread:rewound");
      const queued = ThreadId.make("thread:queued");
      const kept = ThreadId.make("thread:kept");
      const stopped = ThreadId.make("thread:stopped");
      const recovered = ThreadId.make("thread:recovered");
      const live = ThreadId.make("thread:live-rewound");
      const runIdOf = (owner: ThreadId) => RunId.make(`run:${owner}`);
      yield* createProject(project);
      yield* Effect.forEach(
        [
          thread(rewound, project),
          run(rewound, "rolled_back"),
          message(rewound, "rewound-reply", "assistant", "the albatross drive is ready", {
            runId: runIdOf(rewound),
          }),
          thread(queued, project),
          run(queued, "cancelled"),
          message(queued, "queued-prompt", "user", "then mount the albatross drive", {
            runId: runIdOf(queued),
          }),
          message(queued, "requeued-prompt", "user", "then eject the albatross drive", {
            runId: runIdOf(queued),
          }),
          shown(queued, "requeued-prompt", "queued_turn"),
          // Storage maintenance keeps a cancelled queued prompt in the chat.
          thread(kept, project),
          run(kept, "cancelled", { retainQueuedMessage: true }),
          message(kept, "kept-prompt", "user", "later label the albatross drive", {
            runId: runIdOf(kept),
          }),
          shown(kept, "kept-prompt", "queued_turn"),
          // A stopped turn keeps its prompt and whatever the agent already said.
          thread(stopped, project),
          run(stopped, "cancelled"),
          message(stopped, "stopped-prompt", "user", "format the albatross drive", {
            runId: runIdOf(stopped),
          }),
          shown(stopped, "stopped-prompt", "turn_start"),
          thread(recovered, project),
          run(recovered, "cancelled"),
          message(recovered, "recovered-reply", "assistant", "the albatross drive is formatted", {
            runId: runIdOf(recovered),
          }),
          shown(recovered, "recovered-reply", "reply"),
          thread(live, project),
          run(live, "running"),
          message(live, "live-reply", "assistant", "the albatross drive is mirrored", {
            runId: runIdOf(live),
          }),
        ],
        projections.apply,
        { discard: true },
      );
      yield* search.backfillBatch;
      const found = () =>
        search
          .search({ query: "albatross", limit: 20, mode: "keyword" })
          .pipe(Effect.map((result) => result.matches.map((match) => match.messageId).sort()));
      assert.deepEqual(yield* found(), [
        MessageId.make("kept-prompt"),
        MessageId.make("live-reply"),
        MessageId.make("recovered-reply"),
        MessageId.make("stopped-prompt"),
      ]);

      // Rolling back a turn the index already holds removes it.
      const rolledBack = run(live, "rolled_back");
      yield* projections.apply(rolledBack);
      yield* search.handle(rolledBack);
      assert.deepEqual(yield* found(), [
        MessageId.make("kept-prompt"),
        MessageId.make("recovered-reply"),
        MessageId.make("stopped-prompt"),
      ]);
    }),
  );

  it.effect("returns one finished user or assistant match per active thread", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search");
      const deletedProject = ProjectId.make("project:search-deleted");
      yield* createProject(project);
      yield* createProject(deletedProject);
      yield* Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
        projects.apply({
          sequence: 0,
          eventId: EventId.make("deleted:project"),
          aggregateKind: "project",
          aggregateId: deletedProject,
          occurredAt: DateTime.formatIso(at(2)),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: { projectId: deletedProject, deletedAt: DateTime.formatIso(at(2)) },
        }),
      );

      const both = ThreadId.make("thread:both");
      const assistantOnly = ThreadId.make("thread:assistant");
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        thread(both, project),
        message(both, "both-assistant", "assistant", "needle from the answer", { minute: 3 }),
        message(both, "both-user-old", "user", "older needle question", { minute: 1 }),
        message(both, "both-user-new", "user", "newer needle question", { minute: 2 }),
        thread(assistantOnly, project),
        message(assistantOnly, "assistant-only", "assistant", "needle in an answer"),
        message(assistantOnly, "assistant-streaming", "user", "needle still typing", {
          streaming: true,
        }),
        message(assistantOnly, "assistant-system", "system", "needle system prompt"),
        thread(ThreadId.make("thread:archived"), project, { archivedAt: at(1) }),
        message(ThreadId.make("thread:archived"), "archived", "user", "needle archived"),
        thread(ThreadId.make("thread:deleted"), project, { deletedAt: at(1) }),
        message(ThreadId.make("thread:deleted"), "deleted", "user", "needle deleted"),
        thread(ThreadId.make("thread:orphaned"), deletedProject),
        message(ThreadId.make("thread:orphaned"), "orphaned", "user", "needle orphaned"),
      ];
      yield* Effect.forEach(events, projections.apply, { discard: true });

      yield* search.backfillBatch;
      const result = yield* search.search({ query: "NEEDLE", limit: 20, mode: "keyword" });
      assert.deepEqual(
        new Set(result.matches.map((m) => m.threadId)),
        new Set([both, assistantOnly, ThreadId.make("thread:archived")]),
      );
      assert.isTrue(result.matches.find((m) => m.threadId === "thread:archived")?.archived);
      assert.isFalse(
        result.matches.some(
          (m) => m.snippet.includes("still typing") || m.snippet.includes("system prompt"),
        ),
      );
      assert.lengthOf(
        (yield* search.search({ query: "needle", limit: 1, mode: "keyword" })).matches,
        1,
      );
      // LIKE wildcards in the query match literally.
      assert.deepEqual((yield* search.search({ query: "ne%le", mode: "keyword" })).matches, []);
    }),
  );

  it.effect("excludes existing Models helpers on backfill and live updates", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:models-hidden");
      yield* createProject(project);
      const helper = ThreadId.make("models:saved");
      const events = [
        thread(helper, project),
        message(helper, "model-helper-message", "assistant", "helperneedle"),
      ];
      for (const event of events) yield* projections.apply(event);
      yield* search.backfillBatch;
      assert.deepEqual(
        (yield* search.search({ query: "helperneedle", mode: "keyword" })).matches,
        [],
      );
      assert.deepEqual((yield* search.search({ query: "models", mode: "keyword" })).matches, []);
      yield* search.handle(
        message(helper, "model-helper-message-2", "assistant", "helperneedle again"),
      );
      assert.deepEqual(
        (yield* search.search({ query: "helperneedle", mode: "keyword" })).matches,
        [],
      );
    }),
  );

  it.effect(
    "excludes dedicated workflow leads and nested agents on backfill and live updates without hiding normal chats",
    () =>
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2,
          search = yield* ThreadSearch.ThreadSearch;
        yield* search.rebuild;
        yield* search.backfillBatch;
        const beforeCount = (yield* search.status).totalMessages;
        const project = ProjectId.make("workflow-search");
        yield* createProject(project);
        const leadId = ThreadId.make("workflow-lead"),
          childId = ThreadId.make("workflow-child"),
          nestedId = ThreadId.make("workflow-nested"),
          chatId = ThreadId.make("normal-workflow-chat");
        const lead = thread(leadId, project);
        const descendant = (id: ThreadId, parentThreadId: ThreadId) => {
          const event = thread(id, project);
          return {
            ...event,
            payload: {
              ...event.payload,
              lineage: {
                parentThreadId,
                rootThreadId: leadId,
                relationshipToParent: "subagent" as const,
              },
            },
          };
        };
        // An existing index may still contain the lineage from before provenance was available.
        for (const event of [
          lead,
          descendant(childId, leadId),
          descendant(nestedId, childId),
          thread(chatId, project),
        ])
          yield* projections.apply(event);
        for (const id of [leadId, childId, nestedId, chatId])
          yield* projections.apply(message(id, `before-${id}`, "assistant", "workflowneedle"));
        yield* search.backfillBatch;
        // Before the lead is marked it is an ordinary chat; its subagents never show up.
        assert.deepEqual(
          (yield* search.search({ query: "workflowneedle", mode: "keyword" })).matches
            .map((m) => m.threadId)
            .toSorted(),
          [chatId, leadId].toSorted(),
        );
        const marked = {
          ...lead,
          id: EventId.make("workflow-provenance"),
          payload: { ...lead.payload, creationSource: "workflows" as const },
        };
        yield* projections.apply(marked);
        yield* search.handle(marked);
        assert.deepEqual(
          (yield* search.search({ query: "workflowneedle", mode: "keyword" })).matches.map(
            (m) => m.threadId,
          ),
          [chatId],
        );
        for (const id of [leadId, childId, nestedId]) {
          const update = message(id, `after-${id}`, "assistant", "workflowneedle");
          yield* projections.apply(update);
          yield* search.handle(update);
        }
        yield* search.rebuild;
        yield* search.backfillBatch;
        const frames = yield* search
          .searchStream({ query: "workflowneedle", mode: "keyword" })
          .pipe(Stream.runCollect);
        assert.deepEqual(
          frames[0]!.matches.map((m) => m.threadId),
          [chatId],
        );
        assert.equal((yield* search.status).totalMessages, beforeCount + 1);
      }),
  );

  it.effect("leaves subagent chats out of results and the index, keeping their lead", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2,
        search = yield* ThreadSearch.ThreadSearch;
      yield* search.rebuild;
      yield* search.backfillBatch;
      const beforeCount = (yield* search.status).totalMessages;
      const project = ProjectId.make("subagent-search");
      yield* createProject(project);
      const leadId = ThreadId.make("subagent-search-lead"),
        childId = ThreadId.make("subagent-search-child");
      const child = thread(childId, project);
      yield* projections.apply(thread(leadId, project));
      yield* projections.apply({
        ...child,
        payload: {
          ...child.payload,
          lineage: {
            parentThreadId: leadId,
            rootThreadId: leadId,
            relationshipToParent: "subagent" as const,
          },
        },
      });
      // The subagent's brief and report repeat the lead's words.
      for (const id of [leadId, childId])
        yield* projections.apply(message(id, `needle-${id}`, "assistant", "subagentneedle"));
      yield* search.backfillBatch;
      assert.deepEqual(
        (yield* search.search({ query: "subagentneedle", mode: "keyword" })).matches.map(
          (m) => m.threadId,
        ),
        [leadId],
      );
      // A rebuilt index counts only the lead's message.
      yield* search.rebuild;
      yield* search.backfillBatch;
      assert.equal((yield* search.status).totalMessages, beforeCount + 1);
    }),
  );

  it.effect("indexes settled updates, removes deleted chats, and rebuilds a deleted file", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const config = yield* Config.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const project = ProjectId.make("project:incremental");
      const id = ThreadId.make("thread:incremental");
      yield* createProject(project);
      const created = thread(id, project);
      yield* projections.apply(created);
      yield* search.handle(created);
      const streaming = message(id, "incremental", "assistant", "unsettledword", {
        streaming: true,
      });
      yield* projections.apply(streaming);
      yield* search.handle(streaming);
      assert.lengthOf(
        (yield* search.search({ query: "unsettledword", mode: "keyword" })).matches,
        0,
      );
      const settled = message(id, "incremental", "assistant", "settledword");
      yield* projections.apply(settled);
      yield* search.handle(settled);
      assert.equal(
        (yield* search.search({ query: "settledword", mode: "keyword" })).matches[0]?.messageId,
        "incremental",
      );
      yield* fs.remove(`${config.stateDir}/search-index-v1.sqlite`);
      yield* search.status; // Another caller can reopen the missing cache before backfill.
      yield* search.backfillBatch;
      assert.lengthOf((yield* search.search({ query: "settledword", mode: "keyword" })).matches, 1);
      const deleted = {
        ...created,
        type: "thread.deleted" as const,
        payload: { ...created.payload, deletedAt: at(2) },
      };
      yield* projections.apply(deleted);
      yield* search.handle(deleted);
      assert.lengthOf((yield* search.search({ query: "settledword", mode: "keyword" })).matches, 0);
      yield* search.rebuild;
      assert.equal((yield* search.status).indexedMessages, 0);
      yield* search.backfillBatch;
      assert.isAbove((yield* search.status).indexedMessages, 0);
    }),
  );

  it.effect(
    "pauses backfill under BackgroundPolicy and silently falls back when embeddings are down",
    () =>
      Effect.gen(function* () {
        const search = yield* ThreadSearch.ThreadSearch;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const project = ProjectId.make("project:policy");
        const id = ThreadId.make("thread:policy");
        yield* createProject(project);
        yield* projections.apply(thread(id, project));
        yield* projections.apply(message(id, "policy", "user", "policyword"));
        backgroundAllowed = false;
        assert.isFalse(yield* search.backfillBatch);
        assert.isFalse(yield* search.embedBatch);
        assert.isTrue((yield* search.status).paused);
        assert.lengthOf(
          (yield* search.search({ query: "policyword", mode: "keyword" })).matches,
          0,
        );
        backgroundAllowed = true;
        yield* search.backfillBatch;
        const result = yield* search.search({ query: "policyword" });
        assert.lengthOf(result.matches, 1);
        assert.equal((yield* search.status).modelStatus, "unavailable");
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            backgroundAllowed = true;
          }),
        ),
      ),
  );

  it.effect("emits keyword results before the completed hybrid answer", () =>
    Effect.gen(function* () {
      const search = yield* ThreadSearch.ThreadSearch;
      const frames = yield* search.searchStream({ query: "needle" }).pipe(Stream.runCollect);
      assert.equal(frames.length, 2);
      assert.isFalse(frames[0]?.complete);
      assert.isTrue(frames[1]?.complete);
      assert.isAbove(frames[0]?.matches.length ?? 0, 0);
      const limited = yield* search
        .searchStream({ query: "needle", limit: 1 })
        .pipe(Stream.runCollect);
      assert.equal(limited.length, 2);
      assert.lengthOf(limited[0]!.matches, 1);
      assert.lengthOf(limited[1]!.matches, 1);
    }),
  );

  it.effect("emits matching chat names before completing message search", () =>
    Effect.gen(function* () {
      const search = yield* ThreadSearch.ThreadSearch;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const project = ProjectId.make("named-search");
      const named = ThreadId.make("named-search-title");
      const discussed = ThreadId.make("named-search-discussion");
      yield* createProject(project);
      for (const event of [
        thread(named, project),
        thread(discussed, project),
        message(discussed, "named-search-message", "user", "Discuss search title relevance"),
      ]) {
        yield* projections.apply(event);
        yield* search.handle(event);
      }
      const frames = yield* search
        .searchStream({ query: "search title", mode: "keyword" })
        .pipe(Stream.runCollect);
      assert.isFalse(frames[0]?.complete);
      assert.deepEqual(
        frames[0]?.matches.map((match) => match.threadId),
        [named],
      );
      assert.isTrue(frames[1]?.complete);
      assert.deepEqual(
        frames[1]?.matches.map((match) => match.threadId),
        [named, discussed],
      );
      const modelResults = yield* search.search({ query: "gpt 5", mode: "keyword" });
      assert.equal(
        modelResults.matches.find((match) => match.threadId === named)?.matchedModel,
        "gpt-5",
      );
      const harnessResults = yield* search.search({ query: "codex", mode: "keyword" });
      assert.equal(
        harnessResults.matches.find((match) => match.threadId === named)?.matchedHarness,
        "Codex",
      );
    }),
  );

  it.effect("refreshes named search results on model and provider changes", () =>
    Effect.gen(function* () {
      const search = yield* ThreadSearch.ThreadSearch;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const project = ProjectId.make("live-search-metadata");
      const threadId = ThreadId.make("live-metadata-thread");
      yield* createProject(project);
      const initial = thread(threadId, project);
      yield* projections.apply(initial);
      yield* search.handle(initial);

      const model = {
        ...initial,
        id: EventId.make("search-model-change"),
        type: "thread.model-selection-updated",
        payload: {
          ...initial.payload,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-9-live" },
        },
      } satisfies OrchestrationV2DomainEvent;
      const claude = ProviderInstanceId.make("claudeAgent");
      const provider = {
        ...model,
        id: EventId.make("search-provider-change"),
        type: "thread.provider-switched",
        payload: {
          ...model.payload,
          providerInstanceId: claude,
          modelSelection: { instanceId: claude, model: "claude-opus" },
        },
      } satisfies OrchestrationV2DomainEvent;
      for (const event of [model, provider]) {
        yield* projections.apply(event);
        if (ThreadSearch.tracksSearchEvent(event.type)) yield* search.handle(event);
        const result = yield* search.search({
          query: event.payload.modelSelection.model,
          mode: "keyword",
        });
        assert.equal(result.matches[0]?.matchedModel, event.payload.modelSelection.model);
      }
      const old = yield* search.search({ query: "gpt-9-live", mode: "keyword" });
      assert.lengthOf(old.matches, 0);
    }),
  );

  it.effect("reports an unreadable match as a decode failure", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-corrupt");
      const threadId = ThreadId.make("thread:corrupt");
      yield* createProject(project);
      yield* Effect.forEach(
        [thread(threadId, project), message(threadId, "corrupt", "user", "20260927")],
        projections.apply,
        { discard: true },
      );
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET payload_json = json_set(payload_json, '$.text', 20260927)
        WHERE message_id = 'corrupt'
      `;

      const error = yield* Effect.flip(search.backfillBatch);
      assert.equal(error.operation, "decode");
    }),
  );
});

it.effect("searches on the reader worker while the writer is busy", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-search-" });
    const layerFile = Layer.mergeAll(
      ThreadSearch.layer,
      ProjectionStore.layer,
      ProjectStore.layer,
    ).pipe(
      Layer.provideMerge(SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"))),
      Layer.provide(policy),
      Layer.provideMerge(configLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-reader");
      const threadId = ThreadId.make("thread:reader");
      yield* createProject(project);
      yield* Effect.forEach(
        [thread(threadId, project), message(threadId, "reader", "user", "needle on the reader")],
        projections.apply,
        { discard: true },
      );

      yield* search.backfillBatch;
      // A write transaction holds the writer connection. A search on the writer would queue
      // behind it and never finish; one on the reader worker does not wait.
      const writerHeld = yield* Deferred.make<void>();
      const releaseWriter = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(writerHeld, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWriter)),
          ),
        ),
      );
      yield* Deferred.await(writerHeld);
      const result = yield* search.search({ query: "needle", mode: "keyword" });
      yield* Deferred.succeed(releaseWriter, undefined);
      yield* Fiber.join(writer);

      assert.deepEqual(
        result.matches.map((match) => match.threadId),
        [threadId],
      );
    }).pipe(Effect.provide(layerFile));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const repairLayer = layerTest.pipe(
  Layer.provideMerge(EventStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  Layer.provideMerge(policy),
);
const commitSearchEvent = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
  const events = yield* EventStore.EventStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* events.append({ events: [event] });
      yield* projections.apply(event);
    }),
  );
});

it.effect("reports the projection count even before background indexing starts", () =>
  Effect.gen(function* () {
    const search = yield* ThreadSearch.ThreadSearch;
    const project = ProjectId.make("count-project");
    const id = ThreadId.make("count-thread");
    yield* createProject(project);
    yield* commitSearchEvent(thread(id, project));
    yield* commitSearchEvent(message(id, "counted", "user", "ready"));
    assert.equal((yield* search.status).totalMessages, 1);
  }).pipe(Effect.provide(repairLayer)),
);

it.effect("counts only on status reads and shares the result until repair sees an event", () =>
  Effect.gen(function* () {
    const search = yield* ThreadSearch.ThreadSearch;
    const project = ProjectId.make("lazy-count-project");
    const id = ThreadId.make("lazy-count-thread");
    yield* createProject(project);
    yield* commitSearchEvent(thread(id, project));
    const spans: Tracer.NativeSpan[] = [];
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const counts = () =>
      spans.filter((span) => {
        const query = span.attributes.get("db.query.text");
        return (
          typeof query === "string" &&
          query.includes("count(*) AS count FROM orchestration_v2_projection_messages")
        );
      }).length;
    yield* Effect.gen(function* () {
      yield* search.backfillBatch;
      yield* commitSearchEvent(message(id, "one", "user", "ready"));
      yield* search.repair;
      assert.equal(counts(), 0);
      assert.equal((yield* search.status).totalMessages, 1);
      assert.equal((yield* search.status).totalMessages, 1);
      assert.equal(counts(), 1);
      yield* commitSearchEvent(message(id, "two", "assistant", "done"));
      yield* search.repair;
      assert.equal(counts(), 1);
      assert.equal((yield* search.status).totalMessages, 2);
      assert.equal(counts(), 2);
    }).pipe(Effect.withTracer(tracer));
  }).pipe(Effect.provide(repairLayer)),
);

it.effect("repairs missed edits and streaming removals without decoding unchanged bodies", () =>
  Effect.gen(function* () {
    const search = yield* ThreadSearch.ThreadSearch;
    const sql = yield* SqlClient.SqlClient;
    const project = ProjectId.make("repair-project"),
      id = ThreadId.make("repair-thread");
    yield* createProject(project);
    for (const event of [
      thread(id, project),
      message(id, "unchanged", "user", "stableword"),
      message(id, "edited", "assistant", "oldword"),
      message(id, "streamed", "assistant", "removedword"),
    ])
      yield* commitSearchEvent(event);
    yield* search.backfillBatch;
    // Any accidental full repair would decode this body and fail.
    yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.text', 42) WHERE message_id = 'unchanged'`;
    yield* commitSearchEvent({
      ...message(id, "edited", "assistant", "newword"),
      id: EventId.make("missed-edit"),
    });
    yield* commitSearchEvent({
      ...message(id, "streamed", "assistant", "removedword", { streaming: true }),
      id: EventId.make("missed-stream"),
    });
    yield* search.repair;
    assert.lengthOf((yield* search.search({ query: "oldword", mode: "keyword" })).matches, 0);
    assert.lengthOf((yield* search.search({ query: "removedword", mode: "keyword" })).matches, 0);
    assert.equal(
      (yield* search.search({ query: "newword", mode: "keyword" })).matches[0]?.messageId,
      "edited",
    );
    assert.equal(
      (yield* search.search({ query: "stableword", mode: "keyword" })).matches[0]?.messageId,
      "unchanged",
    );
    yield* search.repair;
    yield* search.backfillBatch;
    assert.equal((yield* search.status).totalMessages, 2);
  }).pipe(Effect.provide(repairLayer)),
);

it.effect("repairs persisted caches on startup and restores newly visible thread history", () =>
  Effect.gen(function* () {
    const search = yield* ThreadSearch.ThreadSearch;
    const project = ProjectId.make("repair-startup"),
      id = ThreadId.make("repair-startup-thread");
    yield* createProject(project);
    yield* commitSearchEvent(thread(id, project));
    yield* commitSearchEvent(message(id, "startup-body", "user", "beforeword"));
    yield* search.backfillBatch;
    yield* commitSearchEvent({
      ...message(id, "startup-body", "user", "afterword"),
      id: EventId.make("offline-edit"),
    });
    const restarted = yield* ThreadSearch.make;
    yield* restarted.backfillBatch;
    assert.lengthOf((yield* restarted.search({ query: "beforeword", mode: "keyword" })).matches, 0);
    assert.lengthOf((yield* restarted.search({ query: "afterword", mode: "keyword" })).matches, 1);
    const deleted = {
      ...thread(id, project),
      id: EventId.make("deleted-repair"),
      type: "thread.deleted" as const,
      payload: { ...thread(id, project).payload, deletedAt: at(2) },
    };
    yield* commitSearchEvent(deleted);
    yield* restarted.repair;
    assert.lengthOf((yield* restarted.search({ query: "afterword", mode: "keyword" })).matches, 0);
    yield* commitSearchEvent({ ...thread(id, project), id: EventId.make("restored-repair") });
    yield* restarted.repair;
    assert.lengthOf((yield* restarted.search({ query: "afterword", mode: "keyword" })).matches, 1);
  }).pipe(Effect.provide(repairLayer)),
);

it.effect("keeps the repair watermark when a changed body fails decoding", () =>
  Effect.gen(function* () {
    const search = yield* ThreadSearch.ThreadSearch;
    const sql = yield* SqlClient.SqlClient;
    const project = ProjectId.make("repair-retry"),
      id = ThreadId.make("repair-retry-thread");
    yield* createProject(project);
    yield* commitSearchEvent(thread(id, project));
    yield* commitSearchEvent(message(id, "retry-body", "user", "beforeword"));
    yield* search.backfillBatch;
    yield* commitSearchEvent({
      ...message(id, "retry-body", "user", "afterword"),
      id: EventId.make("retry-edit"),
    });
    yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.text', 42) WHERE message_id = 'retry-body'`;
    assert.equal((yield* search.repair.pipe(Effect.flip)).operation, "decode");
    yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.text', 'afterword') WHERE message_id = 'retry-body'`;
    yield* search.repair;
    assert.lengthOf((yield* search.search({ query: "afterword", mode: "keyword" })).matches, 1);
  }).pipe(Effect.provide(repairLayer)),
);
