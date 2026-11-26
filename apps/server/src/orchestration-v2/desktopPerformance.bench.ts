import * as LocalFiles from "../assets/LocalFileAttachments.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProviderDriverKind,
  ProviderSessionId,
  ThreadId,
  TurnItemId,
  OrchestrationV2TurnItem,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ServerConfig from "../config.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(database));
const sink = EventSink.layer.pipe(Layer.provide(Layer.merge(stores, database)));
const ingest = ProviderEventIngestor.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      stores,
      sink,
      IdAllocator.layer,
      ThreadCommandExecutor.layer,
      ServerConfig.layerTest(process.cwd(), { prefix: "desktop-performance-bench-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
    ),
  ),
);
const harness = Layer.mergeAll(stores, sink, ingest, database);
const encodeItem = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2TurnItem));

const measure = Effect.fn("measure")(function* <A, E, R>(
  name: string,
  operation: Effect.Effect<A, E, R>,
) {
  yield* operation;
  const samples: number[] = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const start = performance.now();
    yield* operation;
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  yield* Effect.logInfo({ name, medianMs: samples[2], minMs: samples[0], maxMs: samples[4] }).pipe(
    Effect.provideService(References.MinimumLogLevel, "Info"),
    Effect.provide(Logger.layer([Logger.consoleJson])),
  );
});

it.live.each([1_000, 5_000])("server history with %i items", (count) =>
  Effect.gen(function* () {
    const shell = liveThreadShell(ThreadId.make(`perf-${count}`), { activeRunId: null });
    const projection = idleThreadProjection(shell);
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const ingestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const sql = yield* SqlClient.SqlClient;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`created-${count}`),
          type: "thread.created",
          threadId: shell.id,
          occurredAt: shell.updatedAt,
          payload: projection.thread,
        },
      ],
    });
    const items: Array<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>> =
      Array.from({ length: count }, (_, index) => ({
        id: TurnItemId.make(`item-${index}`),
        threadId: shell.id,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index,
        status: "running",
        title: "Read file",
        startedAt: shell.updatedAt,
        completedAt: null,
        updatedAt: shell.updatedAt,
        type: "command_execution",
        input: "cat src/index.ts",
        output: "contents\n".repeat(500),
      }));
    for (let offset = 0; offset < count; offset += 100) {
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(
        items.slice(offset, offset + 100).map((item) => ({
          turn_item_id: item.id,
          thread_id: shell.id,
          run_id: null,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal: item.ordinal,
          type: item.type,
          status: item.status,
          updated_at: DateTime.formatIso(item.updatedAt),
          payload_json: encodeItem(item),
        })),
      )}`;
    }
    const full: OrchestrationV2ThreadProjection = {
      ...projection,
      turnItems: items,
      visibleTurnItems: items.map((item, position) => ({
        item,
        position,
        visibility: "local",
        sourceThreadId: shell.id,
        sourceItemId: item.id,
      })),
    };
    const event = {
      id: EventId.make("update"),
      type: "turn-item.updated" as const,
      threadId: shell.id,
      occurredAt: shell.updatedAt,
      payload: items[count - 1]!,
    };
    yield* measure(
      `server:replay:${count}:100`,
      Effect.sync(() => {
        let current = full;
        for (let chunk = 0; chunk < 100; chunk += 1)
          current = ProjectionStore.applyToProjection(current, event);
        return current;
      }),
    );
    yield* measure(
      `server:ingest-sqlite:${count}:100`,
      Effect.gen(function* () {
        for (let chunk = 0; chunk < 100; chunk += 1) {
          yield* ingestor.ingestNormalized({
            providerSessionId: ProviderSessionId.make("perf-session"),
            providerInstanceId: shell.providerInstanceId,
            threadId: shell.id,
            event: {
              driver: ProviderDriverKind.make("codex"),
              type: "turn_item.updated",
              turnItem: { ...items[count - 1]!, output: `chunk ${chunk}` },
            },
          });
        }
      }),
    );
    yield* measure(`server:full-snapshot:${count}`, store.getThreadSnapshot(shell.id));
    yield* measure(
      `server:bounded-snapshot:${count}`,
      store.getThreadSnapshotWindow(shell.id, { rowLimit: 50 }),
    );
    const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(shell),
      getProjectThreadRecords: (input, fields, filter) =>
        store.getThreadRecords(input.threadId, fields, filter).pipe(Effect.orDie),
      getThreadRecords: (id, fields, filter) =>
        store.getThreadRecords(id, fields, filter).pipe(Effect.orDie),
      getTimelinePage: (id, options) => store.getTimelinePage(id, options).pipe(Effect.orDie),
    });
    const mcp = OrchestratorMcpService.layer.pipe(
      Layer.provide(Layer.mock(LocalFiles.LocalFileAttachments)({})),
      Layer.provide(
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/unused",
          folderForThread: () => Effect.succeedNone,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          threads,
          NodeCrypto.layer,
          ServerSettings.layerTest(),
          Layer.mock(UsageLimitSources.UsageLimitSources)({}),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(GitVcsDriver.GitVcsDriver)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({}),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("perf"),
        requestNamespace: "perf",
        thread: undefined,
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };
      yield* measure(
        `mcp:read-tail:${count}`,
        service.readThread(scope, {
          threadId: shell.id,
          fromEnd: true,
          limit: 50,
          view: "activity",
        }),
      );
      yield* measure(
        `mcp:search:${count}`,
        service.readThread(scope, { threadId: shell.id, query: "absent needle", view: "activity" }),
      );
    }).pipe(Effect.provide(mcp));
  }).pipe(Effect.provide(harness), Effect.provideService(References.MinimumLogLevel, "Warning")),
);
