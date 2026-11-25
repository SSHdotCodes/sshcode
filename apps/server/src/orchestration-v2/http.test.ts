import {
  AuthSessionId,
  type AuthEnvironmentScope,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EnvironmentId,
  EventId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  OrchestrationV2AppThread,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2TurnItem,
  OrchestrationV2ThreadTranscript,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadHistoryPage,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as Etag from "effect/http/Etag";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import { ProjectEnrichmentService } from "../project/ProjectEnrichmentService.ts";
import * as OrchestrationHttp from "./http.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

class TranscriptTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}
const decodeTranscript = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadTranscript),
);

const decodeBoundedSnapshot = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot),
);
const decodeHistoryPage = Schema.decodeUnknownEffect(
  Schema.toCodecJson(OrchestrationV2ThreadHistoryPage),
);

const now = DateTime.makeUnsafe("2026-09-29T00:00:00.000Z");
const environmentId = EnvironmentId.make("source-بيئة");
const output = "Full tool output. ".repeat(4_000);
const thread = Schema.decodeUnknownSync(OrchestrationV2AppThread)({
  id: "source-thread",
  projectId: "source-project",
  title: "Source 界\nconversation",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: "source-thread", parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});
const items = Schema.decodeUnknownSync(Schema.Array(OrchestrationV2TurnItem))(
  Array.from({ length: 200 }, (_, position) => ({
    id: `item-${position}`,
    threadId: "source-thread",
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: position,
    type: "command_execution",
    status: "completed",
    title: "Read notes",
    input: "cat notes.md",
    output: position === 0 ? output : "Done",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  })),
);

it.effect("exports full history with size, scope, and missing-thread checks", () =>
  Effect.gen(function* () {
    let allowed = true;
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: "thread-transcript" },
      ProviderAdapterRegistry.layerFromAdapters([]),
      { runEffectWorker: false },
    );
    const services = yield* Layer.build(
      Layer.mergeAll(
        runtime,
        ThreadManagementService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(runtime, CommandReceiptStore.layer, ServerSettings.layerTest({})),
          ),
        ),
        OrchestrationEventStore.layer,
        ProjectStore.layer,
        ProjectionStore.layer,
      ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
    );
    const eventSink = Context.get(services, EventSinkV2);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("create-source"),
          type: "thread.created",
          threadId: thread.id,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
    const routes = HttpApiBuilder.layer(TranscriptTestApi).pipe(
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          Effect.suspend(() =>
            effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("test-session"),
                subject: "test",
                method: "bearer-access-token",
                scopes: new Set<AuthEnvironmentScope>(allowed ? ["orchestration:read"] : []),
              }),
            ),
          ),
        ),
      ),
      Layer.provide(Layer.succeedContext(services)),
      Layer.provide(
        Layer.mock(ProjectEnrichmentService)({
          getAvailable: () =>
            Effect.succeed({
              repositoryIdentity: null,
              faviconPath: null,
              repositoryIdentityResolved: false,
            }),
        }),
      ),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const read = (threadId: ThreadId) =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/orchestration/threads/${threadId}/transcript`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        ),
      );

    const emptyResponse = yield* read(thread.id);
    expect(emptyResponse.status).toBe(200);
    expect(
      (yield* decodeTranscript(yield* Effect.promise(() => emptyResponse.json()))).items,
    ).toEqual([]);
    yield* eventSink.write({
      events: items.map((item) => ({
        id: EventId.make(`create-${item.id}`),
        type: "turn-item.updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: item,
      })),
    });

    const response = yield* read(thread.id);
    expect(response.status).toBe(200);
    const transcript = yield* decodeTranscript(yield* Effect.promise(() => response.json()));
    expect(transcript.items).toHaveLength(200);
    expect(transcript.items[0]?.item).toMatchObject({ output });
    expect(transcript.items[0]?.visibility).toBe("local");
    expect(transcript.items[199]?.position).toBe(199);

    const emptyOutputRows = transcript.items.map((row, position) =>
      position === 0 ? { ...row, item: { ...row.item, output: "" } } : row,
    );
    const header = threadTranscriptHeader(environmentId, transcript);
    const baseSize =
      Buffer.byteLength(header, "utf8") +
      emptyOutputRows.reduce(
        (size, row) => size + Buffer.byteLength(`${JSON.stringify(row)}\n`, "utf8"),
        0,
      );
    const boundaryOutput = "界" + "x".repeat(PROVIDER_SEND_TURN_MAX_FILE_BYTES - baseSize - 3);
    for (const [suffix, expectedStatus] of [
      ["", 200],
      ["x", 400],
    ] as const) {
      // New rows keep 128 KB of a command's output, but rows stored before that
      // cap can be this large, so the boundary row goes straight to the projection.
      yield* Context.get(services, ProjectionStore.ProjectionStoreV2).apply({
        id: EventId.make(`boundary-${expectedStatus}`),
        type: "turn-item.updated",
        threadId: thread.id,
        occurredAt: now,
        payload: {
          ...items.find((item) => item.type === "command_execution")!,
          output: boundaryOutput + suffix,
        },
      });
      const response = yield* read(thread.id);
      expect(response.status).toBe(expectedStatus);
      if (expectedStatus === 400) {
        const error = yield* Context.get(services, ThreadManagementService.ThreadManagementService)
          .getThreadTranscript(thread.id)
          .pipe(
            Effect.provideService(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(environmentId),
            }),
            Effect.flip,
          );
        expect(error).toBeInstanceOf(ThreadManagementService.ThreadTranscriptTooLargeError);
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          _tag: "EnvironmentRequestInvalidError",
          reason: "thread_transcript_too_large",
        });
      }
    }

    // Separate thread with 12 complete user turns, including folded tool rows.
    const pagedThread = { ...thread, id: ThreadId.make("paged-thread") };
    const pagedItems = Array.from(
      { length: 24 },
      (_, ordinal) =>
        ({
          ...items[1]!,
          id: TurnItemId.make(`paged-${ordinal}`),
          threadId: pagedThread.id,
          ordinal,
          ...(ordinal % 2 === 0
            ? {
                type: "user_message" as const,
                createdBy: "user" as const,
                creationSource: "mobile" as const,
                inputIntent: "turn_start" as const,
                messageId: MessageId.make(`message-${ordinal}`),
                text: "Prompt",
                attachments: [],
              }
            : {}),
        }) as OrchestrationV2TurnItem,
    );
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("create-paged"),
          type: "thread.created",
          threadId: pagedThread.id,
          occurredAt: now,
          payload: pagedThread,
        },
        ...pagedItems.map((item) => ({
          id: EventId.make(`create-${item.id}`),
          type: "turn-item.updated" as const,
          threadId: pagedThread.id,
          occurredAt: now,
          payload: item,
        })),
      ],
    });
    const readPaged = (suffix: string) =>
      Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/orchestration/threads/${pagedThread.id}/${suffix}`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        ),
      );
    for (const [query, turns] of [
      ["", 10],
      ["?snapshotUserTurnLimit=3", 3],
      ["?snapshotUserTurnLimit=0", 1],
      ["?snapshotUserTurnLimit=99", 10],
      ["?snapshotUserTurnLimit=invalid", 10],
    ] as const) {
      const response = yield* readPaged(`bounded${query}`);
      expect(response.status).toBe(200);
      const bounded = yield* decodeBoundedSnapshot(yield* Effect.promise(() => response.json()));
      expect(bounded.projection.visibleTurnItems).toHaveLength(turns * 2);
      expect(bounded.hasMoreHistory).toBe(true);
      expect(bounded.historyCursor).not.toBeNull();
      const historyResponse = yield* readPaged(
        `history?cursor=${encodeURIComponent(bounded.historyCursor!)}`,
      );
      expect(historyResponse.status).toBe(200);
      const older = yield* decodeHistoryPage(yield* Effect.promise(() => historyResponse.json()));
      expect(older.hasMoreHistory).toBe(false);
      expect(
        [...older.items, ...bounded.projection.visibleTurnItems].map((row) => row.sourceItemId),
      ).toEqual(pagedItems.map((item) => item.id));
    }

    expect((yield* read(ThreadId.make("missing"))).status).toBe(404);
    allowed = false;
    expect((yield* read(thread.id)).status).toBe(403);
  }),
);

it.effect("shell HTTP selects full, legacy, and app-owned omission independently", () =>
  Effect.gen(function* () {
    const dependencies = yield* Layer.build(
      Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer, OrchestrationEventStore.layer).pipe(
        Layer.provideMerge(SqlitePersistence.layerMemory),
      ),
    );
    const store = Context.get(dependencies, ProjectionStore.ProjectionStoreV2);
    const projectStore = Context.get(dependencies, ProjectStore.ProjectStoreV2);
    const providerThreadId = ProviderThreadId.make("shell-provider-thread");
    const providerSessionId = ProviderSessionId.make("shell-provider-session");
    const providerTurnId = ProviderTurnId.make("shell-provider-turn");
    const nodeId = NodeId.make("shell-node");
    const runId = RunId.make("shell-run");
    const requestId = RuntimeRequestId.make("shell-runtime-request");
    const shellFixtureOccurredAt = DateTime.subtract(now, { seconds: 2 });
    const modelSelection = {
      ...thread.modelSelection,
      options: [{ id: "reasoningEffort", value: "high" }],
    };
    yield* projectStore.apply({
      sequence: 1,
      eventId: EventId.make("shell-project-created"),
      aggregateKind: "project",
      aggregateId: thread.projectId,
      occurredAt: DateTime.formatIso(now),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId: thread.projectId,
        title: "Source project",
        workspaceRoot: "/work/source-project",
        defaultModelSelection: modelSelection,
        projectIcon: { kind: "emoji", emoji: "🚀" },
        scripts: [],
        createdAt: DateTime.formatIso(now),
        updatedAt: DateTime.formatIso(now),
      },
    });
    for (const [id, source] of [
      [thread.id, "web"],
      [ThreadId.make("idle-native"), "provider"],
      [ThreadId.make("idle-delegated"), "mcp"],
    ] as const) {
      const updatedAt = id === thread.id ? DateTime.subtract(now, { seconds: 1 }) : now;
      yield* store.apply({
        id: EventId.make(`shell-create-${id}`),
        type: "thread.created",
        threadId: id,
        occurredAt: now,
        payload: {
          ...thread,
          id,
          updatedAt,
          createdBy: id === thread.id ? "user" : "agent",
          creationSource: source,
          ...(id === thread.id
            ? {
                activeProviderThreadId: providerThreadId,
                modelSelection,
                pinnedMessages: [
                  { messageId: MessageId.make("pinned"), pinnedAt: now, preview: "Pinned 界" },
                ],
              }
            : {}),
          lineage:
            id === thread.id
              ? thread.lineage
              : {
                  parentThreadId: thread.id,
                  rootThreadId: thread.id,
                  relationshipToParent: "subagent",
                },
        },
      });
    }
    yield* store.apply({
      id: EventId.make("shell-provider-thread"),
      type: "provider-thread.updated",
      threadId: thread.id,
      occurredAt: shellFixtureOccurredAt,
      payload: {
        id: providerThreadId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: thread.providerInstanceId,
        providerSessionId,
        appThreadId: thread.id,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "active",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [
          {
            taskId: "background-build",
            kind: "command",
            description: "Build watcher",
            wakesAgent: true,
          },
        ],
        goal: {
          objective: "Finish the migration",
          status: "active",
          tokensUsed: 128,
          tokenBudget: 4_000,
          timeUsedSeconds: 90,
        },
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* store.apply({
      id: EventId.make("shell-run"),
      type: "run.created",
      threadId: thread.id,
      occurredAt: shellFixtureOccurredAt,
      payload: {
        id: runId,
        threadId: thread.id,
        ordinal: 1,
        providerInstanceId: thread.providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make("shell-message"),
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
      id: EventId.make("shell-runtime-request"),
      type: "runtime-request.updated",
      threadId: thread.id,
      occurredAt: shellFixtureOccurredAt,
      payload: {
        id: requestId,
        nodeId,
        providerTurnId,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "live", providerSessionId },
        createdAt: now,
        resolvedAt: null,
      },
    });
    const services = Context.add(
      dependencies,
      ThreadManagementService.ThreadManagementService,
      ThreadManagementService.ThreadManagementService.of({
        readShellSnapshot: (
          options: Parameters<
            ThreadManagementService.ThreadManagementService["Service"]["readShellSnapshot"]
          >[0],
        ) => store.readShellSnapshot(options).pipe(Effect.orDie, Effect.map(Effect.orDie)),
      } as unknown as ThreadManagementService.ThreadManagementService["Service"]),
    );
    const routes = HttpApiBuilder.layer(TranscriptTestApi).pipe(
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(environmentId),
        }),
      ),
      Layer.provide(
        Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
          Effect.suspend(() =>
            effect.pipe(
              Effect.provideService(EnvironmentAuthenticatedPrincipal, {
                sessionId: AuthSessionId.make("test-session"),
                subject: "test",
                method: "bearer-access-token",
                scopes: new Set<AuthEnvironmentScope>(["orchestration:read"]),
              }),
            ),
          ),
        ),
      ),
      Layer.provide(Layer.succeedContext(services)),
      Layer.provide(
        Layer.mock(ProjectEnrichmentService)({
          getAvailable: () =>
            Effect.succeed({
              repositoryIdentity: null,
              faviconPath: null,
              repositoryIdentityResolved: false,
            }),
        }),
      ),
      Layer.provide(HttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true });
    yield* Effect.addFinalizer(() => Effect.promise(dispose));
    const codec = Schema.toCodecJson(OrchestrationV2ShellSnapshot);
    const decode = Schema.decodeUnknownEffect(codec, { onExcessProperty: "error" });
    const encode = Schema.encodeEffect(codec);
    for (const [query, ids, native, all] of [
      ["", ["source-thread", "idle-delegated", "idle-native"], undefined, undefined],
      ["?omitIdleSubagents=1", ["source-thread", "idle-delegated"], true, undefined],
      ["?omitIdleSubagents=2", ["source-thread"], true, true],
    ] as const) {
      const response = yield* Effect.promise(() =>
        handler(
          new Request(`http://localhost/api/orchestration/shell${query}`, {
            headers: { [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT },
          }),
        ),
      );
      expect(response.status).toBe(200);
      const body = yield* Effect.promise(() => response.json());
      const snapshot = yield* decode(body);
      expect(body).toEqual(yield* encode(snapshot));
      expect(snapshot.threads.map(({ id }) => id)).toEqual(ids);
      expect(snapshot.threads.find(({ id }) => id === thread.id)).toMatchObject({
        modelSelection: { options: [{ id: "reasoningEffort", value: "high" }] },
        pendingRuntimeRequest: { id: requestId, kind: "user_input" },
        pendingBackgroundTasks: [
          {
            taskId: "background-build",
            kind: "command",
            description: "Build watcher",
            wakesAgent: true,
          },
        ],
        goal: { objective: "Finish the migration", status: "active" },
      });
      expect(snapshot.projects.find(({ id }) => id === thread.projectId)).toMatchObject({
        defaultModelSelection: { options: [{ id: "reasoningEffort", value: "high" }] },
        projectIcon: { kind: "emoji", emoji: "🚀" },
      });
      expect(snapshot.idleSubagentsOmitted).toBe(native);
      expect(snapshot.idleAppOwnedSubagentsOmitted).toBe(all);
    }
  }),
);
