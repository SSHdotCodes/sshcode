import {
  handoffMessage,
  historicalMessage,
  renderHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import { expandDebugCommand } from "@t3tools/shared/debugCommand";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  OrchestrationV2TurnItem,
  type OrchestratorMcpThreadReadInput,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as UsageLimitSources from "../usage/UsageLimitSources.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

const threadId = ThreadId.make("thread:mcp-read");
const projection = idleThreadProjection(liveThreadShell(threadId, { activeRunId: null }));
const now = projection.updatedAt;
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:mcp-read"),
  requestNamespace: "mcp-read-test",
  thread: undefined,
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const encodeItem = Schema.encodeSync(Schema.fromJsonString(OrchestrationV2TurnItem));

function item(position: number, text: string, command = false): OrchestrationV2TurnItem {
  const base = {
    id: TurnItemId.make(`item:mcp-read:${position}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: position,
    status: "completed" as const,
    title: command ? "Wireless setup" : null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  return command
    ? { ...base, type: "command_execution", input: text }
    : {
        ...base,
        type: "assistant_message",
        messageId: MessageId.make(`message:mcp-read:${position}`),
        text,
        streaming: false,
      };
}

const smallItems = [
  item(0, "Developer settings enable mode on the phone."),
  item(1, "Developer settings alone."),
  item(2, "enable developer mode", true),
  item(3, `${"x".repeat(500)} developer MODE uses the Horizon phone app ${"y".repeat(500)}`),
  item(4, "Developer mode is in the Meta Horizon phone app."),
  item(5, "Unrelated latest reply."),
];

const providerInstanceId = ProviderInstanceId.make("codex");

function boundedRun(ordinal: number, status: "completed" | "running"): OrchestrationV2Run {
  return {
    id: RunId.make(`run:mcp-read:${ordinal}`),
    threadId,
    ordinal,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    providerThreadId: null,
    userMessageId: MessageId.make(`message:mcp-read:run:${ordinal}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: now,
    completedAt: status === "completed" ? now : null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

function dynamicToolItem(
  position: number,
  payload: { readonly toolName: string; readonly input: unknown; readonly output: unknown },
): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make(`item:mcp-read:${position}`),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: position,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "dynamic_tool",
    toolName: payload.toolName,
    input: payload.input,
    output: payload.output,
  };
}

const makeHarness = Effect.fn("makeReadHarness")(function* (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  bulk = false,
  runs: ReadonlyArray<OrchestrationV2Run> = [],
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make("event:mcp-read:thread"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: projection.thread,
  });
  if (bulk) {
    const sql = yield* SqlClient.SqlClient;
    for (let offset = 0; offset < items.length; offset += 100) {
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(
        items.slice(offset, offset + 100).map((row) => ({
          turn_item_id: row.id,
          thread_id: threadId,
          run_id: null,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal: row.ordinal,
          type: row.type,
          status: row.status,
          updated_at: DateTime.formatIso(now),
          payload_json: encodeItem(row),
        })),
      )}`;
    }
  } else {
    for (const row of items) {
      yield* store.apply({
        id: EventId.make(`event:${row.id}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: row,
      });
    }
  }
  for (const run of runs) {
    yield* store.apply({
      id: EventId.make(`event:${run.id}`),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: run,
    });
  }
  const pages: Array<{ limit: number; hydrated: number }> = [];
  const layerThreads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: () => Effect.succeed(liveThreadShell(threadId, { activeRunId: null })),
    getProjectThreadRecords: (input, fields, filter) => {
      // Non-child reads must not load every user message in a large thread.
      expect(filter?.messageRoles).toEqual([]);
      return store
        .getThreadRecords(input.threadId, fields, filter)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ThreadManagement.ThreadManagementProjectionLoadError({ ...input, cause }),
          ),
        );
    },
    getThreadRecords: (id, fields, filter) =>
      store
        .getThreadRecords(id, fields, filter)
        .pipe(Effect.mapError((cause) => new OrchestratorProjectionError({ threadId: id, cause }))),
    getTimelinePage: (id, options) =>
      store.getTimelinePage(id, options).pipe(
        Effect.tap((page) =>
          Effect.sync(() => pages.push({ limit: options.limit, hydrated: page.items.length })),
        ),
        Effect.mapError((cause) => new OrchestratorProjectionError({ threadId: id, cause })),
      ),
  });
  const layer = OrchestratorMcpService.layer.pipe(
    Layer.provide(
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/unused" }),
    ),
    Layer.provide(
      Layer.mergeAll(
        layerThreads,
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
  return {
    pages,
    read: (input: Omit<OrchestratorMcpThreadReadInput, "threadId"> = {}) =>
      Effect.flatMap(OrchestratorMcpService.OrchestratorMcpService, (service) =>
        service.readThread(scope, { threadId, ...input }),
      ).pipe(Effect.provide(layer)),
  };
});

const layerSqlite = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const stores = [
  { name: "sqlite", layerStore: layerSqlite },
  {
    name: "memory",
    layerStore: Layer.merge(ProjectionStore.layerMemory, SqlitePersistence.layerMemory),
  },
];

it.effect.each(stores)(
  "$name: recovers original items using ids from shortened handoff history",
  ({ layerStore }) =>
    Effect.gen(function* () {
      const { read } = yield* makeHarness(smallItems);
      const messages = smallItems.flatMap((item) => {
        const message = historicalMessage(item);
        return message === null ? [] : [message];
      });
      // An item carried whole needs no id: there is nothing more to read.
      expect(renderHistory(messages, "Historical context")).not.toContain("; item=");
      const rendered = renderHistory(
        messages.map((message) => ({ ...message, shortened: true as const })),
        "Historical context",
      );
      const ids = [...rendered.matchAll(/; item=([^\]]+)\]/g)].map((match) =>
        TurnItemId.make(match[1]!),
      );
      expect(ids).toEqual(messages.map((message) => message.itemId));
      for (const [index, itemId] of ids.entries()) {
        const result = yield* read({ view: "activity", itemId, maxCharsPerItem: 50_000 });
        const message = messages[index]!;
        expect(result.items[0]?.text).toBe(
          message.kind === "command_execution" ? "$ enable developer mode" : message.text,
        );
        expect(result.items[0]?.nextTextOffset).toBeNull();
      }
    }).pipe(Effect.provide(layerStore)),
);

it.effect.each(stores)(
  "$name: recovers the full text a handoff cut from context-expanded user and subagent items",
  ({ layerStore }) =>
    Effect.gen(function* () {
      const base = {
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed" as const,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      const items: Array<OrchestrationV2TurnItem> = [
        {
          ...base,
          id: TurnItemId.make("item:mcp-read:expanded-user"),
          ordinal: 100,
          title: null,
          type: "user_message",
          messageId: MessageId.make("message:mcp-read:expanded-user"),
          ...expandDebugCommand("/debug stale phone"),
          attachments: [],
          inputIntent: "turn_start",
          createdBy: "user",
          creationSource: "web",
        },
        {
          ...base,
          id: TurnItemId.make("item:mcp-read:subagent"),
          ordinal: 101,
          title: "Review the hinge",
          type: "subagent",
          subagentId: NodeId.make("node:mcp-read:subagent"),
          origin: "app_owned",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId,
          childThreadId: null,
          prompt: "Inspect the hinge tolerances. FULL-PROMPT",
          progress: "Halfway through. FULL-PROGRESS",
          result: "Use a softer stop. FULL-RESULT",
        },
      ];
      const { read } = yield* makeHarness(items);
      const messages = items.flatMap((row) => {
        const carried = handoffMessage(row);
        return carried === null ? [] : [carried];
      });
      expect(messages).toHaveLength(2);
      // The handoff promises a shortened item can be read back whole by its id.
      // That has to include what only the provider projection of a user message
      // contains, and a subagent's task as well as its result.
      const rendered = renderHistory(
        messages.map((message) => ({ ...message, shortened: true as const })),
        "Historical context",
      );
      const ids = [...rendered.matchAll(/; item=([^\]]+)\]/g)].map((match) =>
        TurnItemId.make(match[1]!),
      );
      expect(ids).toEqual(messages.map((message) => message.itemId));
      const user = yield* read({ view: "activity", itemId: ids[0]!, maxCharsPerItem: 50_000 });
      expect(user.items[0]?.text).toBe(messages[0]!.text);
      const subagent = yield* read({
        view: "activity",
        itemId: ids[1]!,
        maxCharsPerItem: 50_000,
      });
      // Result first (a capped read opens with it), then the task; progress is
      // superseded once there is a result.
      expect(subagent.items[0]?.text).toBe(
        "Use a softer stop. FULL-RESULT\n\nTask: Inspect the hinge tolerances. FULL-PROMPT",
      );
    }).pipe(Effect.provide(layerStore)),
);

it.effect.each(stores)(
  "$name: tails in position order and pages backwards within the chosen view",
  ({ layerStore }) =>
    Effect.gen(function* () {
      const { read } = yield* makeHarness(smallItems);
      const tail = yield* read({ fromEnd: true, limit: 2 });
      expect(tail.items.map((row) => row.position)).toEqual([4, 5]);
      expect(tail).toMatchObject({ nextPosition: 5, prevPosition: 4, hasMore: true });
      const older = yield* read({ beforePosition: tail.prevPosition!, limit: 2 });
      expect(older.items.map((row) => row.position)).toEqual([1, 3]);
      expect(older).toMatchObject({ prevPosition: 1, hasMore: true });
      const first = yield* read({ beforePosition: older.prevPosition!, limit: 2 });
      expect(first.items.map((row) => row.position)).toEqual([0]);
      expect(first).toMatchObject({ prevPosition: null, hasMore: false });
      const activity = yield* read({ beforePosition: 4, view: "activity", limit: 2 });
      expect(activity.items.map((row) => row.position)).toEqual([2, 3]);
      const empty = yield* read({ beforePosition: 0 });
      expect(empty.items).toEqual([]);
      expect(empty).toMatchObject({ prevPosition: null, nextPosition: null, hasMore: false });
    }).pipe(Effect.provide(layerStore)),
);

it.effect.each(stores)(
  "$name: preserves forward pages and long-item text recovery",
  ({ layerStore }) =>
    Effect.gen(function* () {
      const { read } = yield* makeHarness(smallItems);
      const first = yield* read({ limit: 2 });
      expect(first.items.map((row) => row.position)).toEqual([0, 1]);
      expect(first).toMatchObject({ nextPosition: 1, hasMore: true });
      expect(first).not.toHaveProperty("prevPosition");
      expect(first).not.toHaveProperty("search");
      const next = yield* read({ afterPosition: first.nextPosition!, limit: 2 });
      expect(next.items.map((row) => row.position)).toEqual([3, 4]);
      expect(next).toMatchObject({ nextPosition: 4, hasMore: true });
      const last = yield* read({ afterPosition: next.nextPosition!, limit: 2 });
      expect(last.items.map((row) => row.position)).toEqual([5]);
      expect(last.hasMore).toBe(false);
      const text = yield* read({ itemId: smallItems[3]!.id, textOffset: 500, maxCharsPerItem: 40 });
      expect(text.items[0]?.text).toBe(" developer MODE uses the Horizon phone a");
      expect(text.items[0]?.nextTextOffset).toBe(540);
    }).pipe(Effect.provide(layerStore)),
);

it.effect.each(stores)(
  "$name: searches all words case-insensitively, newest first, with match snippets",
  ({ layerStore }) =>
    Effect.gen(function* () {
      const { read } = yield* makeHarness(smallItems);
      const result = yield* read({ query: "  MODE\tdeveloper ", limit: 1 });
      expect(result.items.map((row) => row.position)).toEqual([4]);
      expect(result).toMatchObject({
        prevPosition: 4,
        nextPosition: null,
        hasMore: true,
        search: { hasMoreMatches: true },
      });
      const older = yield* read({
        query: "developer mode",
        beforePosition: result.prevPosition!,
        maxCharsPerItem: 32,
      });
      expect(older.items.map((row) => row.position)).toEqual([3, 0]);
      expect(older.items[0]?.text).toBe("x".repeat(32));
      expect(older.items[0]?.snippet).toContain("developer MODE uses the Horizon phone app");
      expect(older.items[0]?.snippet?.length).toBeLessThanOrEqual(242);
      expect(older).toMatchObject({
        prevPosition: null,
        hasMore: false,
        search: { hasMoreMatches: false },
      });
      const activity = yield* read({ query: "mode wireless", view: "activity" });
      expect(activity.items.map((row) => row.position)).toEqual([2]);
      expect(activity.items[0]?.snippet).toContain("Wireless setup");
      const noMatch = yield* read({ query: "absent" });
      expect(noMatch.items).toEqual([]);
      expect(noMatch.search).toEqual({
        scannedItems: 5,
        scanLimitReached: false,
        hasMoreMatches: false,
      });
      for (const input of [
        { query: " " },
        { query: "mode", afterPosition: 0 },
        { fromEnd: true, afterPosition: 0 },
        { query: "mode", itemId: smallItems[0]!.id },
      ]) {
        const error = yield* read(input).pipe(Effect.flip);
        expect(error).toMatchObject({ code: "invalid_request" });
      }
    }).pipe(Effect.provide(layerStore)),
);

it.effect.each(stores)(
  "$name: bounds a page by items and characters and pages through the rest",
  ({ layerStore }) =>
    Effect.gen(function* () {
      // 4,000 UTF-16 units lands inside this emoji, between its two surrogates.
      const splitText = `${"a".repeat(3_999)}🧪${"b".repeat(100)}`;
      const pageText = "x".repeat(splitText.length);
      const toolPayload = {
        toolName: "search",
        input: { query: "mode" },
        output: { blob: "y".repeat(5_000) },
      };
      const compactToolText = JSON.stringify({
        toolName: toolPayload.toolName,
        input: toolPayload.input,
        output: toolPayload.output,
      });
      const messages = [
        item(0, splitText),
        ...Array.from({ length: 19 }, (_, index) => item(index + 1, pageText)),
      ];
      const tool = dynamicToolItem(messages.length, toolPayload);
      const olderCompleted = boundedRun(1, "completed");
      const active = boundedRun(2, "running");
      const latestCompleted = boundedRun(3, "completed");
      const { read } = yield* makeHarness([...messages, tool], false, [
        olderCompleted,
        active,
        latestCompleted,
      ]);

      // A page stops at 15 items or ~30k chars, whichever comes first.
      const first = yield* read();
      const firstCount = first.items.length;
      expect(firstCount).toBeGreaterThan(1);
      expect(firstCount).toBeLessThan(15);
      expect(JSON.stringify(first).length).toBeLessThan(31_000);
      expect(first.items.map((row) => row.position)).toEqual(
        Array.from({ length: firstCount }, (_, index) => index),
      );
      expect(first).toMatchObject({ nextPosition: firstCount - 1, hasMore: true });
      expect(first.recentRuns).toEqual([
        expect.objectContaining({
          runId: latestCompleted.id,
          ordinal: 3,
          status: "completed",
          model: "gpt-5",
        }),
      ]);
      expect(first.thread).toMatchObject({
        runCount: 3,
        latestRunId: latestCompleted.id,
        activeRunId: active.id,
        itemCount: 21,
      });
      for (const row of first.items) {
        expect(row.text).toHaveLength(4_000);
        expect(row).toMatchObject({ textTruncated: true, nextTextOffset: 4_000 });
      }
      expect(first.items[0]?.text).toBe(splitText.slice(0, 4_000));
      expect(splitText.codePointAt(3_999)).toBeGreaterThan(0xffff);

      const continued = yield* read({
        itemId: messages[0]!.id,
        textOffset: first.items[0]!.nextTextOffset!,
      });
      expect(continued.items).toHaveLength(1);
      expect(continued.items[0]).toMatchObject({
        text: splitText.slice(4_000),
        textTruncated: false,
        nextTextOffset: null,
      });
      expect(`${first.items[0]?.text ?? ""}${continued.items[0]?.text ?? ""}`).toBe(splitText);
      expect(continued.hasMore).toBe(false);

      const remainder = yield* read({ afterPosition: first.nextPosition! });
      expect(remainder.items[0]?.position).toBe(firstCount);
      expect(
        remainder.items.every((row) => row.textTruncated && row.nextTextOffset === 4_000),
      ).toBe(true);

      // The newest page that fits pages back from its first item.
      const newest = yield* read({ fromEnd: true });
      // The tool call is activity, outside the default messages view.
      expect(newest.items.at(-1)?.position).toBe(19);
      expect(newest).toMatchObject({ hasMore: true, prevPosition: newest.items[0]?.position });

      const contractMaxPage = yield* read({
        limit: 100,
        runLimit: 50,
        maxCharsPerItem: 50_000,
      });
      expect(JSON.stringify(contractMaxPage).length).toBeLessThan(31_000);
      expect(contractMaxPage.items[0]).toMatchObject({
        text: splitText,
        textTruncated: false,
        nextTextOffset: null,
      });
      expect(
        contractMaxPage.items.slice(1).every((row) => row.text === pageText && !row.textTruncated),
      ).toBe(true);
      expect(contractMaxPage).toMatchObject({
        hasMore: true,
        nextPosition: contractMaxPage.items.at(-1)?.position,
      });
      expect(contractMaxPage.recentRuns.map((run) => run.ordinal)).toEqual([3, 2, 1]);

      expect(compactToolText.length).toBeGreaterThan(4_000);
      expect(compactToolText.length).toBeLessThan(20_000);
      expect(compactToolText.includes("\n")).toBe(false);
      const toolChunk = yield* read({ itemId: tool.id });
      expect(toolChunk.items[0]).toMatchObject({
        type: "dynamic_tool",
        text: compactToolText.slice(0, 4_000),
        textTruncated: true,
        nextTextOffset: 4_000,
      });
      expect(toolChunk.items[0]?.text).not.toBe(
        JSON.stringify(toolPayload, null, 2).slice(0, 4_000),
      );
      const toolRest = yield* read({ itemId: tool.id, textOffset: 4_000 });
      expect(toolRest.items[0]).toMatchObject({
        text: compactToolText.slice(4_000),
        textTruncated: false,
        nextTextOffset: null,
      });
      expect(`${toolChunk.items[0]?.text ?? ""}${toolRest.items[0]?.text ?? ""}`).toBe(
        compactToolText,
      );
      const toolFull = yield* read({ itemId: tool.id, maxCharsPerItem: 20_000 });
      expect(toolFull.items[0]).toMatchObject({
        text: compactToolText,
        textTruncated: false,
        nextTextOffset: null,
      });
      const toolContractMax = yield* read({ itemId: tool.id, maxCharsPerItem: 50_000 });
      expect(toolContractMax.items[0]?.text).toBe(compactToolText);
    }).pipe(Effect.provide(layerStore)),
);

it.live(
  "bounds sparse search on a 20,000-item SQLite thread and resumes even after an empty page",
  () =>
    Effect.gen(function* () {
      const items = Array.from({ length: 20_000 }, (_, index) =>
        item(index, index === 18_999 ? "developer mode uses the phone" : "unrelated reply"),
      );
      const { read, pages } = yield* makeHarness(items, true);
      const tailStart = performance.now();
      const tail = yield* read({ fromEnd: true, limit: 10 });
      const tailMs = performance.now() - tailStart;
      expect(tail.items.map((row) => row.position)).toEqual(
        Array.from({ length: 10 }, (_, i) => 19_990 + i),
      );
      expect(pages.splice(0)).toEqual([{ limit: 10, hydrated: 10 }]);
      const searchStart = performance.now();
      const first = yield* read({ query: "developer mode", limit: 1 });
      const searchMs = performance.now() - searchStart;
      expect(first.items).toEqual([]);
      expect(first).toMatchObject({
        hasMore: true,
        prevPosition: 19_000,
        search: { scannedItems: 1_000, scanLimitReached: true, hasMoreMatches: null },
      });
      expect(pages).toHaveLength(10);
      expect(pages.every((page) => page.limit === 100 && page.hydrated === 100)).toBe(true);
      const second = yield* read({
        query: "developer mode",
        beforePosition: first.prevPosition!,
        limit: 1,
      });
      expect(second.items.map((row) => row.position)).toEqual([18_999]);
      expect(second).toMatchObject({
        prevPosition: 18_000,
        hasMore: true,
        search: { scannedItems: 1_000, hasMoreMatches: null },
      });
      const exhausted = yield* read({ query: "developer mode", beforePosition: 10 });
      expect(exhausted).toMatchObject({
        items: [],
        prevPosition: null,
        hasMore: false,
        search: { scannedItems: 10, scanLimitReached: false, hasMoreMatches: false },
      });
      yield* Effect.logInfo(
        `20,000-item SQLite thread: tail(10) ${tailMs.toFixed(1)}ms, bounded search(1,000) ${searchMs.toFixed(1)}ms`,
      ).pipe(
        Effect.provideService(References.MinimumLogLevel, "Info"),
        Effect.provide(Logger.layer([Logger.consoleLogFmt])),
      );
    }).pipe(Effect.provide(layerSqlite)),
);
