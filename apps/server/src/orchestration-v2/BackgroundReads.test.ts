import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import { listDueTasks } from "../scheduledTasks/ScheduledTaskService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

it.effect(
  "routes scheduler discovery and the shell watermark to the reader and preserves transaction visibility",
  () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const database = Sqlite.layerFromPath(dir + "/background.sqlite");
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const events = yield* EventStore.OrchestrationEventStore;
        const now = yield* DateTime.now;
        const spans: Tracer.NativeSpan[] = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        yield* Effect.all([
          store.getProviderRetryCandidates(now),
          listDueTasks(now),
          store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: true }),
          store.getSignedOutStops({ since: now, messagePrefix: "signed out" }),
          events.latestApplicationSequence,
        ]).pipe(
          Effect.withTracer(tracer),
          Effect.provideService(Statement.SpanPropagationEnabled, true),
        );
        assert.deepEqual(
          spans
            .filter((span) => span.name === "sqlite")
            .map((span) => span.attributes.get("db.connection")),
          Array(5).fill("reader"),
        );
        // Recovery skips successful run histories using the existing thread/status index.
        for (const [alias, marker] of [
          ["r", "$.automaticProviderRetry.status"],
          ["r", "AS run_payload_json"],
          ["failed", "AS failure_payload_json"],
        ] as const) {
          const query = spans
            .map((span) => span.attributes.get("db.query.text"))
            .find(
              (statement): statement is string =>
                typeof statement === "string" && statement.includes(marker),
            );
          assert.isDefined(query, marker);
          const plan = yield* sql.unsafe<{ detail: string }>(`EXPLAIN QUERY PLAN ${query}`);
          assert.isTrue(
            plan.some(
              ({ detail }) =>
                detail.startsWith(`SEARCH ${alias} `) &&
                detail.includes("runs_thread_status_idx (thread_id=? AND status=?)"),
            ),
            `${marker}: ${plan.map((row) => row.detail).join(", ")}`,
          );
          if (marker === "AS run_payload_json") {
            const match = plan.findIndex(({ detail }) => detail.startsWith("SEARCH error "));
            const history = plan.findIndex(({ detail }) => detail.startsWith("SEARCH latest "));
            assert.isAtLeast(match, 0);
            assert.isAbove(history, match);
          }
        }
        const before = yield* events.latestApplicationSequence;
        yield* Effect.flip(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`INSERT INTO orchestration_events(event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
          VALUES ('temporary', 'thread', 'test', 1, 'thread.created', ${DateTime.formatIso(now)}, 'server', '{}', '{}', 2)`;
              assert.isAbove(yield* events.latestApplicationSequence, before);
              return yield* Effect.fail("roll back");
            }),
          ),
        );
        assert.equal(yield* events.latestApplicationSequence, before);
        // Ingestion drops an identical node. If another writer is changing A
        // to B, a restoration of A must compare against B after that commit.
        const threadId = ThreadId.make("restoration");
        const id = NodeId.make("root");
        const node = {
          id,
          threadId,
          runId: null,
          parentNodeId: null,
          rootNodeId: id,
          kind: "root_turn" as const,
          status: "running" as const,
          countsForRun: true,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: null,
        };
        yield* store.apply({
          type: "node.updated",
          id: EventId.make("old"),
          threadId,
          occurredAt: now,
          payload: node,
        });
        assert.isTrue(yield* store.isNodeStored(node));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const writer = yield* Effect.forkChild(
          sql.withTransaction(
            store
              .apply({
                type: "node.updated",
                id: EventId.make("new"),
                threadId,
                occurredAt: now,
                payload: { ...node, status: "completed", completedAt: now },
              })
              .pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Deferred.await(release)),
              ),
          ),
        );
        yield* Deferred.await(entered);
        const waiting = Tracer.make({
          span(options) {
            if (options.name === "sqlite.statement.wait") Deferred.doneUnsafe(release, Effect.void);
            return new Tracer.NativeSpan(options);
          },
        });
        const identical = yield* store
          .isNodeStored(node)
          .pipe(Effect.withTracer(waiting), Effect.ensuring(Deferred.succeed(release, undefined)));
        yield* Fiber.join(writer);
        assert.isFalse(identical);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(ProjectionStore.layer, EventStore.layer).pipe(
            Layer.provideMerge(database),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect(
  "reads the full shell's rows and reply previews on the reader, and a finished reply once",
  () =>
    Effect.gen(function* () {
      const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
      const database = Sqlite.layerFromPath(dir + "/shell.sqlite");
      yield* Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const instanceId = ProviderInstanceId.make("codex");
        const modelSelection = { instanceId, model: "gpt-5.1-codex" };
        const driver = ProviderDriverKind.make("codex");
        const threadId = ThreadId.make("thread:reader-shell");
        const runId = RunId.make("run:reader-shell");
        const rootNodeId = NodeId.make("node:reader-shell");
        const run = {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:reader-shell"),
          rootNodeId,
          activeAttemptId: null,
          status: "completed" as const,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        };
        yield* store.apply({
          id: EventId.make("event:reader-shell:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:reader-shell"),
            title: "Reader shell",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
        yield* store.apply({
          id: EventId.make("event:reader-shell:run"),
          type: "run.created",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: run,
        });
        yield* store.apply({
          id: EventId.make("event:reader-shell:reply"),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          occurredAt: now,
          payload: {
            threadId,
            runId,
            nodeId: rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            id: TurnItemId.make("item:reader-shell:reply"),
            ordinal: 1,
            status: "completed",
            type: "assistant_message",
            messageId: MessageId.make("message:reader-shell:reply"),
            text: "All done.",
            streaming: false,
          },
        });
        const spans: Tracer.NativeSpan[] = [];
        const tracer = Tracer.make({
          span(options) {
            const span = new Tracer.NativeSpan(options);
            spans.push(span);
            return span;
          },
        });
        const shell = () =>
          store
            .getShellSnapshot()
            .pipe(
              Effect.withTracer(tracer),
              Effect.provideService(Statement.SpanPropagationEnabled, true),
            );
        const first = yield* shell();
        assert.equal(first.threads.find((row) => row.id === threadId)?.replyPreview, "All done.");
        const transactions = spans.filter((span) => span.name === "sql.transaction");
        // One transaction for the rows, one for the session boxes; neither on the writer.
        assert.isAtLeast(transactions.length, 2);
        assert.deepEqual(
          [...new Set(transactions.map((span) => span.attributes.get("db.connection")))],
          ["reader"],
        );
        assert.notInclude(
          spans
            .filter((span) => span.name === "sqlite")
            .map((span) => span.attributes.get("db.connection")),
          "writer",
        );
        const replyReads = () =>
          spans.filter((span) =>
            String(span.attributes.get("db.query.text")).includes("reply_tail"),
          ).length;
        assert.equal(replyReads(), 1);
        const transactionsAfterFirst = transactions.length;
        const second = yield* shell();
        assert.equal(second.threads.find((row) => row.id === threadId)?.replyPreview, "All done.");
        assert.equal(replyReads(), 1);
        // Second connect reuses cached replies and requests, so it skips the second box transaction.
        assert.equal(
          spans.filter((span) => span.name === "sql.transaction").length,
          transactionsAfterFirst + 1,
        );
        // A family read with no box data left to read stays in one reader transaction.
        const transactionsBeforeFamily = spans.filter(
          (span) => span.name === "sql.transaction",
        ).length;
        yield* store
          .getShellSnapshot({ location: "active", subagentFamilyOf: threadId })
          .pipe(
            Effect.withTracer(tracer),
            Effect.provideService(Statement.SpanPropagationEnabled, true),
          );
        assert.equal(
          spans.filter((span) => span.name === "sql.transaction").length,
          transactionsBeforeFamily + 1,
        );
      }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(database))));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("keeps an idle subagent's reply preview on a family read", () =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const database = Sqlite.layerFromPath(dir + "/family.sqlite");
    yield* Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "gpt-5.1-codex" };
      const driver = ProviderDriverKind.make("codex");
      const rootId = ThreadId.make("thread:family-box:root");
      const childId = ThreadId.make("thread:family-box:child");
      const runId = RunId.make("run:family-box:child");
      const nodeId = NodeId.make("node:family-box:child");
      const threadPayload = (id: ThreadId, parentThreadId: ThreadId | null) =>
        ({
          createdBy: parentThreadId === null ? "user" : "agent",
          creationSource: parentThreadId === null ? "web" : "mcp",
          id,
          projectId: ProjectId.make("project:family-box"),
          title: id,
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId,
            relationshipToParent: parentThreadId === null ? null : "subagent",
            rootThreadId: rootId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        }) as const;
      for (const [id, parentThreadId] of [
        [rootId, null],
        [childId, rootId],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`event:family-box:${id}`),
          type: "thread.created",
          threadId: id,
          occurredAt: now,
          payload: threadPayload(id, parentThreadId),
        });
      }
      yield* store.apply({
        id: EventId.make("event:family-box:run"),
        type: "run.created",
        threadId: childId,
        runId,
        nodeId,
        driver,
        providerInstanceId: instanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: childId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:family-box:task"),
          rootNodeId: nodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:family-box:reply"),
        type: "turn-item.updated",
        threadId: childId,
        runId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          threadId: childId,
          runId,
          nodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          id: TurnItemId.make("item:family-box:reply"),
          ordinal: 1,
          status: "completed",
          type: "assistant_message",
          messageId: MessageId.make("message:family-box:reply"),
          text: "Child finished.",
          streaming: false,
        },
      });

      // The slim shell leaves the idle child to its family, whose row then stands in for it.
      const slim = yield* store.getShellSnapshot({ location: "active", omitIdleSubagents: "all" });
      assert.notInclude(
        slim.threads.map((thread) => thread.id),
        childId,
      );
      const family = yield* store.getShellSnapshot({
        location: "active",
        subagentFamilyOf: rootId,
      });
      assert.equal(
        family.threads.find((thread) => thread.id === childId)?.replyPreview,
        "Child finished.",
      );
    }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(database))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
// An idle chat an agent created over MCP, whose row previews the agent's latest reply.
const withMcpChatPreview = <A, E>(
  use: (chat: {
    readonly store: ProjectionStore.ProjectionStoreV2["Service"];
    readonly sql: SqlClient.SqlClient;
    readonly reply: (text: string) => OrchestrationV2DomainEvent;
    readonly shellPreview: Effect.Effect<
      string | undefined,
      ProjectionStore.ProjectionStoreV2Error
    >;
    readonly threadPreview: Effect.Effect<
      string | undefined,
      ProjectionStore.ProjectionStoreV2Error
    >;
  }) => Effect.Effect<A, E, ProjectionStore.ProjectionStoreV2 | SqlClient.SqlClient>,
) =>
  Effect.gen(function* () {
    const dir = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped();
    const database = Sqlite.layerFromPath(dir + "/box-race.sqlite");
    return yield* Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const instanceId = ProviderInstanceId.make("codex");
      const threadId = ThreadId.make("thread:box-race");
      const messageId = MessageId.make("message:box-race:reply");
      yield* store.apply({
        id: EventId.make("event:box-race:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "agent",
          creationSource: "mcp",
          id: threadId,
          projectId: ProjectId.make("project:box-race"),
          title: "Box race",
          providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "gpt-5.1-codex" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      // Every edit keeps the cache key: no new run, no new item.
      const reply = (text: string): OrchestrationV2DomainEvent => ({
        id: EventId.make(`event:box-race:${text}`),
        type: "message.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: messageId,
          threadId,
          runId: null,
          nodeId: null,
          role: "assistant",
          text,
          attachments: [],
          streaming: false,
          createdBy: "agent",
          creationSource: "mcp",
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* store.apply(reply("First draft"));
      return yield* use({
        store,
        sql,
        reply,
        shellPreview: store
          .getShellSnapshot()
          .pipe(
            Effect.map(
              (snapshot) =>
                snapshot.threads.find((thread) => thread.id === threadId)?.createdChatPreview,
            ),
          ),
        threadPreview: store
          .getThreadShell(threadId)
          .pipe(Effect.map((shell) => shell?.createdChatPreview)),
      });
    }).pipe(Effect.provide(ProjectionStore.layer.pipe(Layer.provideMerge(database))));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect(
  "does not keep a chat preview a reader cached while a message write was uncommitted",
  () =>
    withMcpChatPreview(({ store, sql, reply, shellPreview }) =>
      Effect.gen(function* () {
        // Forked outside the write transaction, so it reads on the reader worker, which
        // sees only committed rows. It runs and caches while the edit below is open.
        const go = yield* Deferred.make<void>();
        const read = yield* Effect.forkChild(Deferred.await(go).pipe(Effect.andThen(shellPreview)));
        const edit = reply("Final answer");
        const afterCommit = yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* store.apply(edit);
            // EventSink prepares this inside the transaction and runs it after commit.
            const invalidate = yield* store.prepareMessageBoxInvalidation!([edit]);
            yield* Deferred.succeed(go, undefined);
            assert.equal(yield* Fiber.join(read), "First draft");
            return invalidate;
          }),
        );
        yield* afterCommit;
        assert.equal(yield* shellPreview, "Final answer");
      }),
    ),
);

it.effect("does not cache a chat preview read inside a write that rolls back", () =>
  withMcpChatPreview(({ store, sql, reply, threadPreview }) =>
    Effect.gen(function* () {
      const rolledBack = yield* sql
        .withTransaction(
          Effect.gen(function* () {
            yield* store.apply(reply("Never committed"));
            // Nested in the write, this read sees the uncommitted edit.
            assert.equal(yield* threadPreview, "Never committed");
            return yield* Effect.fail("roll back" as const);
          }),
        )
        .pipe(Effect.flip);
      assert.equal(rolledBack, "roll back");
      assert.equal(yield* threadPreview, "First draft");
    }),
  ),
);
