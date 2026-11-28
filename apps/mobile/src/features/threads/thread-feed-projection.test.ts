import {
  createPendingThreadMessagesProjector,
  appendPendingThreadMessages,
} from "../../state/pending-thread-feed";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { CommandId } from "@t3tools/contracts";
import {
  EnvironmentId,
  MessageId,
  RunId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { createQuestionHistoryProjector } from "@t3tools/client-runtime/state/thread-requests";
import {
  applyOrchestrationV2ProjectionEvent,
  isSingleRowReplacement,
} from "@t3tools/client-runtime/state/orchestration-v2-projection";
import { describe, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  v2Now,
  v2Projection,
  v2ThreadId,
} from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import {
  applyContinuedWorkLogRows,
  buildThreadFeed,
  deriveThreadFeedPresentation,
  filterDiscordThreadFeed,
  type ThreadFeedEntry,
  type ThreadFeedLatestRun,
  type ThreadFeedMessage,
} from "../../lib/threadActivity";
import {
  createDiscordThreadFeedProjector,
  createStableThreadFeedProjector,
  createThreadFeedProjector,
  createThreadFeedPresentationProjector,
  threadFeedRevision,
  threadFeedSummary,
  threadFeedFailedRunIds,
  threadFeedFinalAssistantMessageIds,
} from "../../lib/threadFeedProjection";

vi.mock("../../lib/composerImageGallery", () => ({ composerImageGallery: () => [] }));
import { threadImageGallery } from "./messageImageGallery";
import {
  createTimelineDecorationsProjector,
  timelineDecorations,
} from "../discord/timelinePresentation";

const context = {
  environmentId: EnvironmentId.make("test"),
  threadId: v2ThreadId,
  workspaceRoot: "/repo",
};
const expandedRuns = new Set<RunId>();
const expandedGroups = new Set<string>();

function syntheticThread(count: number, onHistoryRead = () => {}): OrchestrationV2ThreadProjection {
  const items = Array.from({ length: count }, (_, ordinal): OrchestrationV2TurnItem => {
    const common = {
      id: TurnItemId.make(`item-${ordinal}`),
      threadId: v2ThreadId,
      runId: RunId.make(`run-${Math.floor(ordinal / 4)}`),
      nodeId: null,
      parentItemId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      ordinal,
      status: "completed" as const,
      title: null,
      startedAt: v2Now,
      updatedAt: v2Now,
      completedAt: v2Now,
    };
    if (ordinal % 4 === 0)
      return {
        ...common,
        type: "user_message",
        messageId: MessageId.make(`message-${ordinal}`),
        text: "Check this",
        attachments: [],
        inputIntent: "turn_start",
        createdBy: "user",
        creationSource: "mobile",
      };
    if (ordinal % 8 === 2)
      return { ...common, type: "reasoning", text: "Compare the alternatives", streaming: false };
    if (ordinal % 4 === 1 || ordinal % 4 === 2)
      return {
        ...common,
        type: "command_execution",
        input: "git status",
        output: "clean",
        exitCode: 0,
      };
    return {
      ...common,
      type: "assistant_message",
      messageId: MessageId.make(`message-${ordinal}`),
      text: ordinal % 40 === 3 ? "![chart](https://cdn.test/chart.png)" : "The checks passed.",
      attachments: [],
      streaming: ordinal === count - 1,
    };
  });
  const rows = items.map((item, position) => ({
    position,
    visibility: "local" as const,
    sourceThreadId: v2ThreadId,
    get sourceItemId() {
      if (position < count - 1) onHistoryRead();
      return item.id;
    },
    get item() {
      if (position < count - 1) onHistoryRead();
      return item;
    },
  }));
  return {
    ...v2Projection,
    turnItems: items,
    visibleTurnItems: rows,
  } satisfies OrchestrationV2ThreadProjection;
}

function updateItem(projection: OrchestrationV2ThreadProjection, item: OrchestrationV2TurnItem) {
  return applyOrchestrationV2ProjectionEvent(
    projection,
    {
      id: "stream-update",
      type: "turn-item.updated",
      threadId: v2ThreadId,
      occurredAt: v2Now,
      payload: item,
    } as OrchestrationV2DomainEvent,
    { partialTimeline: true },
  )!;
}

function lastReply(projection: OrchestrationV2ThreadProjection) {
  const item = projection.turnItems.at(-1)!;
  if (item.type !== "assistant_message") throw new Error("Expected a reply");
  return item;
}

function running(projection: OrchestrationV2ThreadProjection): ThreadFeedLatestRun {
  return {
    runId: lastReply(projection).runId!,
    status: "running",
    startedAt: "2026-06-20T00:00:00.000Z",
    completedAt: null,
  };
}

/** Replaces the final reply with a running command whose output streams in place. */
function withStreamingTool(projection: OrchestrationV2ThreadProjection) {
  const last = projection.turnItems.at(-1)!;
  const tool = {
    id: last.id,
    threadId: last.threadId,
    runId: last.runId,
    nodeId: null,
    parentItemId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    ordinal: last.ordinal,
    status: "running" as const,
    title: null,
    startedAt: v2Now,
    updatedAt: v2Now,
    completedAt: null,
    type: "command_execution" as const,
    input: "npm test",
    output: "running",
  };
  const item = tool as unknown as OrchestrationV2TurnItem;
  const turnItems = [...projection.turnItems.slice(0, -1), item];
  const visibleTurnItems = [
    ...projection.visibleTurnItems.slice(0, -1),
    { ...projection.visibleTurnItems.at(-1)!, item },
  ];
  return {
    projection: {
      ...projection,
      turnItems,
      visibleTurnItems,
    } as OrchestrationV2ThreadProjection,
    tool: tool as Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
  };
}

/** Rows compare without function identity: memoized detail closures are recreated per build. */
function normalizeFunctions(value: unknown): unknown {
  if (typeof value === "function") return "<fn>";
  if (Array.isArray(value)) return value.map(normalizeFunctions);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>))
      out[key] = normalizeFunctions(entry);
    return out;
  }
  return value;
}

function pipeline() {
  const build = createThreadFeedProjector();
  const projectQuestionHistory = createQuestionHistoryProjector();
  const present = createThreadFeedPresentationProjector();
  return (
    projection: OrchestrationV2ThreadProjection,
    run = running(projection),
    groups = expandedGroups,
  ) => {
    const feed = build(projectQuestionHistory(projection), {
      attempts: projection.attempts,
      nodes: projection.nodes,
    });
    const rows = present(feed, run, expandedRuns, groups, run.completedAt ? null : run.startedAt);
    return {
      feed,
      rows,
      summary: threadFeedSummary(feed),
      presentedSummary: threadFeedSummary(rows),
      gallery: threadImageGallery(rows, context),
    };
  };
}

describe("streaming feed projection", () => {
  it.each([1, 3])(
    "does not revisit 11,000 historical items for %s coalesced text chunks",
    (chunks) => {
      let historyReads = 0;
      let projection = syntheticThread(11_004, () => {
        historyReads++;
      });
      const project = pipeline();
      project(projection);
      // Warm the immutable sequence indices on the first event.
      projection = updateItem(projection, { ...lastReply(projection), text: "First chunk" });
      const before = project(projection);
      historyReads = 0;
      for (let index = 0; index < chunks; index++) {
        projection = updateItem(projection, {
          ...lastReply(projection),
          text: "First chunk and next chunk",
        });
      }
      const next = project(projection);
      expect(historyReads).toBe(0);
      expect(next.feed.at(-1)).toMatchObject({ message: { text: "First chunk and next chunk" } });
      // The streaming reply is the last row: no idle Thinking row follows a visible reply.
      expect(next.rows.at(-1)).toBe(next.feed.at(-1));
      expect(next.feed[0]).toBe(before.feed[0]);
      expect(next.summary).toBe(before.summary);
      expect(next.presentedSummary).toBe(before.presentedSummary);
      expect(next.gallery).toBe(before.gallery);
      expect(next.rows).toEqual(
        deriveThreadFeedPresentation(
          buildThreadFeed(projection.visibleTurnItems),
          running(projection),
          expandedRuns,
          expandedGroups,
          running(projection).startedAt,
        ),
      );
    },
  );

  it("reuses timeline decorations for text chunks and recalculates watermark and day changes", () => {
    let projection = syntheticThread(12);
    const project = pipeline();
    const decorate = createTimelineDecorationsProjector();
    const now = new Date("2026-06-20T12:00:00Z");
    const watermark = "2026-06-20T00:00:01Z";
    let rows = project(projection).rows;
    const initial = decorate(rows, watermark, now);
    projection = updateItem(projection, { ...lastReply(projection), text: "More" });
    rows = project(projection).rows;
    expect(decorate(rows, watermark, now)).toBe(initial);
    expect(decorate(rows, watermark, now)).toEqual(timelineDecorations(rows, watermark, now));
    projection = updateItem(projection, {
      ...lastReply(projection),
      text: "New output",
      updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:02Z"),
    });
    rows = project(projection).rows;
    const crossed = decorate(rows, watermark, now);
    expect(crossed).not.toBe(initial);
    expect(crossed).toEqual(timelineDecorations(rows, watermark, now));
    expect(crossed.get("message-11")?.isNew).toBe(true);
    const changedWatermark = decorate(rows, null, now);
    expect(changedWatermark).not.toBe(crossed);
    const tomorrow = new Date("2026-06-21T12:00:00Z");
    expect(decorate(rows, null, tomorrow)).toEqual(timelineDecorations(rows, null, tomorrow));
    expect(decorate(rows, null, tomorrow)).not.toBe(changedWatermark);
  });

  it("reuses rows when a separate message event leaves the visible sequence unchanged", () => {
    const projection = syntheticThread(12);
    const project = pipeline();
    const before = project(projection);
    const next = project({ ...projection, messages: [...projection.messages] });
    expect(next.feed).toBe(before.feed);
    expect(next.rows).toBe(before.rows);
  });

  it("keeps images added between gallery reads", () => {
    let projection = syntheticThread(4);
    const build = createThreadFeedProjector();
    const initial = build(projection.visibleTurnItems);
    threadImageGallery(initial, context);
    projection = updateItem(projection, {
      ...lastReply(projection),
      text: "![new](https://cdn.test/new.png)",
    });
    build(projection.visibleTurnItems);
    projection = updateItem(projection, {
      ...lastReply(projection),
      text: "![new](https://cdn.test/new.png) More words",
    });
    const feed = build(projection.visibleTurnItems);
    expect(threadImageGallery(feed, context).at(-1)).toMatchObject({
      uri: "https://cdn.test/new.png",
    });
  });

  it("updates image galleries when a stream adds an image or the workspace changes", () => {
    let projection = syntheticThread(4);
    const project = pipeline();
    const before = project(projection);
    projection = updateItem(projection, {
      ...lastReply(projection),
      text: "![new](https://cdn.test/new.png)",
    });
    const next = project(projection);
    expect(next.gallery).not.toBe(before.gallery);
    expect(next.gallery.at(-1)).toMatchObject({ uri: "https://cdn.test/new.png" });
    expect(
      threadImageGallery(next.rows, { ...context, environmentId: EnvironmentId.make("other") }),
    ).not.toBe(next.gallery);
  });

  it.each(["empty", "complete", "earlier", "append", "reorder"] as const)(
    "reconciles %s changes with full projection",
    (change) => {
      let projection = syntheticThread(12);
      const project = pipeline();
      project(projection);
      const reply = lastReply(projection);
      if (change === "empty") projection = updateItem(projection, { ...reply, text: " " });
      if (change === "complete")
        projection = updateItem(projection, { ...reply, streaming: false });
      if (change === "earlier") {
        const earlier = projection.turnItems[3]!;
        if (earlier.type !== "assistant_message") throw new Error("Expected earlier reply");
        projection = updateItem(projection, { ...earlier, text: "Edited earlier" });
      }
      if (change === "append")
        projection = updateItem(projection, {
          ...reply,
          id: TurnItemId.make("appended"),
          messageId: MessageId.make("appended"),
          ordinal: 20,
        });
      if (change === "reorder") projection = updateItem(projection, { ...reply, ordinal: 1 });
      const next = project(projection);
      expect(next.feed).toEqual(buildThreadFeed(projection.visibleTurnItems));
      expect(next.rows).toEqual(
        deriveThreadFeedPresentation(
          next.feed,
          running(projection),
          expandedRuns,
          expandedGroups,
          running(projection).startedAt,
        ),
      );
    },
  );

  it("rebuilds on turn completion and disclosure changes", () => {
    let projection = syntheticThread(12);
    const project = pipeline();
    project(projection);
    projection = updateItem(projection, { ...lastReply(projection), text: "More text" });
    const run = {
      ...running(projection),
      status: "completed" as const,
      completedAt: "2026-06-20T00:00:10.000Z",
    };
    const groups = new Set(["work-group:local:thread-v2:item-9"]);
    const next = project(projection, run, groups);
    expect(next.rows).toEqual(deriveThreadFeedPresentation(next.feed, run, expandedRuns, groups));
    expect(threadFeedFailedRunIds(next.summary, { ...run, status: "failed" })).toContain(run.runId);
  });

  it("measures full shaping against streaming projection on 11,004 items", () => {
    const project = pipeline();
    let projection = syntheticThread(11_004);
    project(projection);
    projection = updateItem(projection, { ...lastReply(projection), text: "warm" });
    project(projection);
    let fullMs = 0;
    let incrementalMs = 0;
    let fullDecorationsMs = 0;
    let incrementalDecorationsMs = 0;
    const decorate = createTimelineDecorationsProjector();
    decorate(project(projection).rows, null);
    for (let index = 0; index < 30; index++) {
      projection = updateItem(projection, { ...lastReply(projection), text: `Chunk ${index}` });
      let start = performance.now();
      const feed = buildThreadFeed(projection.visibleTurnItems);
      const rows = deriveThreadFeedPresentation(
        feed,
        running(projection),
        expandedRuns,
        expandedGroups,
        running(projection).startedAt,
      );
      threadFeedSummary(feed);
      threadImageGallery(rows, context);
      fullMs += performance.now() - start;
      start = performance.now();
      const next = project(projection);
      incrementalMs += performance.now() - start;
      start = performance.now();
      timelineDecorations(next.rows, null);
      fullDecorationsMs += performance.now() - start;
      start = performance.now();
      decorate(next.rows, null);
      incrementalDecorationsMs += performance.now() - start;
    }
    console.info(
      `11,004 items, 30 chunks: full ${fullMs.toFixed(1)}ms, incremental ${incrementalMs.toFixed(1)}ms; decorations full ${fullDecorationsMs.toFixed(1)}ms, incremental ${incrementalDecorationsMs.toFixed(1)}ms`,
    );
    // Work-count assertions above enforce scaling without flaky clock thresholds.
  });

  it.each([1, 3])(
    "does not revisit 11,000 historical items for %s coalesced tool output chunks",
    (chunks) => {
      let historyReads = 0;
      const base = withStreamingTool(
        syntheticThread(11_004, () => {
          historyReads++;
        }),
      );
      let projection = base.projection;
      const toolRun = (p: OrchestrationV2ThreadProjection): ThreadFeedLatestRun => ({
        runId: p.turnItems.at(-1)!.runId!,
        status: "running",
        startedAt: "2026-06-20T00:00:00.000Z",
        completedAt: null,
      });
      const project = pipeline();
      project(projection, toolRun(projection));
      // Warm the incremental indices on the first output chunk.
      projection = updateItem(projection, { ...base.tool, output: "first chunk" });
      const before = project(projection, toolRun(projection));
      historyReads = 0;
      for (let index = 0; index < chunks; index++) {
        const current = projection.turnItems.at(-1) as typeof base.tool;
        projection = updateItem(projection, {
          ...current,
          output: `first chunk and chunk ${index}`,
        });
      }
      const next = project(projection, toolRun(projection));
      // The tail group's few rows are re-read to patch it; history is not.
      expect(historyReads).toBeLessThan(100);
      expect(next.feed[0]).toBe(before.feed[0]);
      expect(next.feed.length).toBe(before.feed.length);
      const freshFeed = buildThreadFeed(projection.visibleTurnItems);
      expect(normalizeFunctions(next.feed)).toEqual(normalizeFunctions(freshFeed));
      expect(normalizeFunctions(next.rows)).toEqual(
        normalizeFunctions(
          deriveThreadFeedPresentation(
            freshFeed,
            toolRun(projection),
            expandedRuns,
            expandedGroups,
            toolRun(projection).startedAt,
          ),
        ),
      );
    },
  );

  it("measures tool output streaming against full shaping on 11,004 items", () => {
    const base = withStreamingTool(syntheticThread(11_004));
    let projection = base.projection;
    const toolRun = (p: OrchestrationV2ThreadProjection): ThreadFeedLatestRun => ({
      runId: p.turnItems.at(-1)!.runId!,
      status: "running",
      startedAt: "2026-06-20T00:00:00.000Z",
      completedAt: null,
    });
    const project = pipeline();
    project(projection, toolRun(projection));
    projection = updateItem(projection, { ...base.tool, output: "warm" });
    project(projection, toolRun(projection));
    let fullMs = 0;
    let incrementalMs = 0;
    for (let index = 0; index < 30; index++) {
      const current = projection.turnItems.at(-1) as typeof base.tool;
      projection = updateItem(projection, { ...current, output: `chunk ${index}` });
      const run = toolRun(projection);
      let start = performance.now();
      const feed = buildThreadFeed(projection.visibleTurnItems);
      const rows = deriveThreadFeedPresentation(
        feed,
        run,
        expandedRuns,
        expandedGroups,
        run.startedAt,
      );
      threadFeedSummary(feed);
      threadImageGallery(rows, context);
      fullMs += performance.now() - start;
      start = performance.now();
      project(projection, run);
      incrementalMs += performance.now() - start;
    }
    console.info(
      `11,004 items, 30 tool output chunks: full ${fullMs.toFixed(1)}ms, incremental ${incrementalMs.toFixed(1)}ms`,
    );
  });

  it("reuses the whole feed for updates to rows that never draw", () => {
    const project = pipeline();
    for (const replacement of [
      {
        type: "checkpoint",
        files: [],
      },
      {
        type: "reasoning",
        text: "thinking",
        streaming: true,
      },
    ] as const) {
      const last = { ...syntheticThread(12).turnItems.at(-1)! } as Record<string, unknown>;
      for (const key of Object.keys(last)) {
        if (
          ![
            "id",
            "threadId",
            "runId",
            "nodeId",
            "parentItemId",
            "providerThreadId",
            "providerTurnId",
            "nativeItemRef",
            "ordinal",
            "status",
            "title",
            "startedAt",
            "updatedAt",
            "completedAt",
          ].includes(key)
        )
          delete last[key];
      }
      const item = { ...last, ...replacement } as unknown as OrchestrationV2TurnItem;
      const thread = syntheticThread(12);
      let projection = {
        ...thread,
        turnItems: [...thread.turnItems.slice(0, -1), item],
        visibleTurnItems: [
          ...thread.visibleTurnItems.slice(0, -1),
          { ...thread.visibleTurnItems.at(-1)!, item },
        ],
      } as OrchestrationV2ThreadProjection;
      const run: ThreadFeedLatestRun = {
        runId: item.runId!,
        status: "running",
        startedAt: "2026-06-20T00:00:00.000Z",
        completedAt: null,
      };
      project(projection, run);
      projection = updateItem(projection, { ...item });
      const before = project(projection, run);
      const updated = {
        ...projection.turnItems.at(-1)!,
        updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:03Z"),
      } as unknown as OrchestrationV2TurnItem;
      projection = updateItem(projection, updated);
      const after = project(projection, run);
      expect(after.feed).toBe(before.feed);
      expect(after.rows).toBe(before.rows);
    }
  });

  it("matches full rebuild when an in-place tool update changes feed structure", () => {
    const base = syntheticThread(8);
    const last = base.turnItems.at(-1)!;
    const common = {
      id: last.id,
      threadId: last.threadId,
      runId: last.runId,
      nodeId: null,
      parentItemId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      ordinal: last.ordinal,
      title: null,
      startedAt: v2Now,
      updatedAt: v2Now,
      completedAt: v2Now,
    };

    const replaceTail = (item: OrchestrationV2TurnItem): OrchestrationV2ThreadProjection =>
      ({
        ...base,
        turnItems: [...base.turnItems.slice(0, -1), item],
        visibleTurnItems: [
          ...base.visibleTurnItems.slice(0, -1),
          { ...base.visibleTurnItems.at(-1)!, item },
        ],
      }) as OrchestrationV2ThreadProjection;

    // 1. Completed dynamic_tool hydrated in place with an html-render reference
    {
      const build = createThreadFeedProjector();
      const initialTool = {
        ...common,
        type: "dynamic_tool" as const,
        status: "completed" as const,
        toolName: "html_render",
        input: {},
        output: { text: "pending detail" },
      } as unknown as OrchestrationV2TurnItem;
      let projection = replaceTail(initialTool);
      build(projection.visibleTurnItems);
      const hydrated = {
        ...initialTool,
        output: {
          htmlRender: {
            attachmentId: "att-1",
            title: "Chart",
            height: 240,
          },
        },
      } as unknown as OrchestrationV2TurnItem;
      projection = updateItem(projection, hydrated);
      expect(normalizeFunctions(build(projection.visibleTurnItems))).toEqual(
        normalizeFunctions(buildThreadFeed(projection.visibleTurnItems)),
      );
    }

    // 2. Completed dynamic_tool hydrated in place with an MCP App reference
    {
      const build = createThreadFeedProjector();
      const initialTool = {
        ...common,
        type: "dynamic_tool" as const,
        status: "completed" as const,
        toolName: "demo.widget",
        input: {},
        output: { text: "plain" },
      } as unknown as OrchestrationV2TurnItem;
      let projection = replaceTail(initialTool);
      build(projection.visibleTurnItems);
      const hydrated = {
        ...initialTool,
        output: {
          t3McpApp: {
            attachmentId: "att-app-1",
            server: "demo",
            tool: "widget",
            resourceUri: "ui://demo/widget",
          },
        },
      } as unknown as OrchestrationV2TurnItem;
      projection = updateItem(projection, hydrated);
      expect(normalizeFunctions(build(projection.visibleTurnItems))).toEqual(
        normalizeFunctions(buildThreadFeed(projection.visibleTurnItems)),
      );
    }

    // 3. Visible command_execution updated in place to workspace preparation
    {
      const build = createThreadFeedProjector();
      const initialCommand = {
        ...common,
        type: "command_execution" as const,
        status: "running" as const,
        completedAt: null,
        input: "git status",
        output: "",
      } as unknown as OrchestrationV2TurnItem;
      let projection = replaceTail(initialCommand);
      build(projection.visibleTurnItems);
      const workspacePrep = {
        ...initialCommand,
        input: "Preparing workspace",
      } as unknown as OrchestrationV2TurnItem;
      projection = updateItem(projection, workspacePrep);
      expect(normalizeFunctions(build(projection.visibleTurnItems))).toEqual(
        normalizeFunctions(buildThreadFeed(projection.visibleTurnItems)),
      );
    }

    // 4. Tool with startedAt: null whose updatedAt crosses an anchored message timestamp
    {
      const build = createThreadFeedProjector();
      const initialCommand = {
        ...common,
        type: "command_execution" as const,
        status: "running" as const,
        startedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
        completedAt: null,
        input: "npm test",
        output: "starting",
      } as unknown as OrchestrationV2TurnItem;
      let projection = replaceTail(initialCommand);
      const anchoredMessages = [
        {
          id: MessageId.make("local-1"),
          role: "user" as const,
          text: "Anchored note",
          attachments: [],
          createdAt: "2026-06-20T00:00:05.000Z",
          updatedAt: "2026-06-20T00:00:05.000Z",
          streaming: false,
        },
      ];
      build(projection.visibleTurnItems, { anchoredMessages });
      projection = updateItem(projection, {
        ...initialCommand,
        updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:10.000Z"),
        output: "still running",
      } as unknown as OrchestrationV2TurnItem);
      expect(normalizeFunctions(build(projection.visibleTurnItems, { anchoredMessages }))).toEqual(
        normalizeFunctions(buildThreadFeed(projection.visibleTurnItems, { anchoredMessages })),
      );
    }
  });

  it("matches full rebuild for tool streams across reorder, removal, chat switch, and turn end", () => {
    const project = pipeline();
    const { projection: initialProjection, tool } = withStreamingTool(syntheticThread(12));
    const activeRun: ThreadFeedLatestRun = {
      runId: tool.runId!,
      status: "running",
      startedAt: "2026-06-20T00:00:00.000Z",
      completedAt: null,
    };

    const assertMatchesFull = (
      projection: OrchestrationV2ThreadProjection,
      run: ThreadFeedLatestRun,
    ) => {
      const next = project(projection, run);
      const freshFeed = buildThreadFeed(projection.visibleTurnItems, {
        attempts: projection.attempts,
        nodes: projection.nodes,
      });
      expect(normalizeFunctions(next.feed)).toEqual(normalizeFunctions(freshFeed));
      expect(normalizeFunctions(next.rows)).toEqual(
        normalizeFunctions(
          deriveThreadFeedPresentation(
            freshFeed,
            run,
            expandedRuns,
            expandedGroups,
            run.completedAt ? null : run.startedAt,
          ),
        ),
      );
    };

    let projection = initialProjection;
    assertMatchesFull(projection, activeRun);
    projection = updateItem(projection, { ...tool, output: "chunk 1" });
    assertMatchesFull(projection, activeRun);

    // Reorder: move the streaming tool earlier in the timeline
    const reordered = updateItem(projection, { ...tool, output: "chunk 2", ordinal: 1 });
    assertMatchesFull(reordered, activeRun);

    // Removal: drop the streaming tool item as on rollback or snapshot resync
    const removed: OrchestrationV2ThreadProjection = {
      ...projection,
      turnItems: projection.turnItems.slice(0, -1),
      visibleTurnItems: projection.visibleTurnItems.slice(0, -1),
    };
    assertMatchesFull(removed, activeRun);

    // Chat switch: switch to an unrelated thread projection
    const otherThread = withStreamingTool(syntheticThread(8));
    const otherRun: ThreadFeedLatestRun = {
      runId: otherThread.tool.runId!,
      status: "running",
      startedAt: "2026-06-20T00:00:00.000Z",
      completedAt: null,
    };
    assertMatchesFull(otherThread.projection, otherRun);

    // Turn end: complete the streaming tool and settle the run
    const settledProjection = updateItem(otherThread.projection, {
      ...otherThread.tool,
      status: "completed",
      completedAt: v2Now,
      output: "done",
    });
    const settledRun: ThreadFeedLatestRun = {
      ...otherRun,
      status: "completed",
      completedAt: "2026-06-20T00:00:10.000Z",
    };
    assertMatchesFull(settledProjection, settledRun);
  });

  it("preserves continued work-log row references and single-row revision chain across tool chunks", () => {
    const base = syntheticThread(8);
    // Replace item-7 (assistant_message in run-1) with a running command in run-2 so
    // run-1's expanded work-toggle (continuesWorkLog: true) immediately precedes the active tail.
    const activeRunId = RunId.make("run-2");
    const last = base.turnItems.at(-1)!;
    const streamingTool = {
      id: last.id,
      threadId: last.threadId,
      runId: activeRunId,
      nodeId: null,
      parentItemId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      ordinal: last.ordinal,
      status: "running" as const,
      title: null,
      startedAt: v2Now,
      updatedAt: v2Now,
      completedAt: null,
      type: "command_execution" as const,
      input: "npm test",
      output: "running",
    } as unknown as Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;
    let projection: OrchestrationV2ThreadProjection = {
      ...base,
      turnItems: [...base.turnItems.slice(0, -1), streamingTool],
      visibleTurnItems: [
        ...base.visibleTurnItems.slice(0, -1),
        { ...base.visibleTurnItems.at(-1)!, item: streamingTool },
      ],
    };
    const activeRun: ThreadFeedLatestRun = {
      runId: activeRunId,
      status: "running",
      startedAt: "2026-06-20T00:00:00.000Z",
      completedAt: null,
    };
    const openRuns = new Set<RunId>([RunId.make("run-1")]);
    const build = createThreadFeedProjector();
    const present = createThreadFeedPresentationProjector();
    const project = (p: OrchestrationV2ThreadProjection) => {
      const feed = build(p.visibleTurnItems, { attempts: p.attempts, nodes: p.nodes });
      return {
        feed,
        rows: present(feed, activeRun, openRuns, expandedGroups, activeRun.startedAt),
      };
    };

    const initial = project(projection);
    const boundaryIndex = initial.rows.length - 2;
    expect(initial.rows[boundaryIndex]?.continuesWorkLog).toBe(true);
    // applyContinuedWorkLogRows itself must be idempotent on already-continued rows.
    expect(applyContinuedWorkLogRows(initial.rows)[boundaryIndex]).toBe(
      initial.rows[boundaryIndex],
    );

    // Warm single-row revision lineage, then stream another chunk.
    projection = updateItem(projection, { ...streamingTool, output: "chunk 1" });
    const before = project(projection);
    projection = updateItem(projection, { ...streamingTool, output: "chunk 2" });
    const after = project(projection);

    // The preceding continued work-log row must keep referential identity (not be re-cloned)
    // and the tail patch must keep a single-row revision link for downstream projectors.
    expect(after.rows[boundaryIndex]).toBe(before.rows[boundaryIndex]);
    expect(
      isSingleRowReplacement(threadFeedRevision(before.rows), threadFeedRevision(after.rows)),
    ).toBe(true);
    expect(normalizeFunctions(after.rows)).toEqual(
      normalizeFunctions(
        deriveThreadFeedPresentation(
          buildThreadFeed(projection.visibleTurnItems, {
            attempts: projection.attempts,
            nodes: projection.nodes,
          }),
          activeRun,
          openRuns,
          expandedGroups,
          activeRun.startedAt,
        ),
      ),
    );
  });
});

describe("Discord and pending feed revisions", () => {
  it.each([1, 3])("preserves all outputs and skips history for %i coalesced chunks", (chunks) => {
    let projection = syntheticThread(1_004);
    const project = pipeline();
    const append = createPendingThreadMessagesProjector();
    const filter = createDiscordThreadFeedProjector();
    const decorate = createTimelineDecorationsProjector();
    const queued: QueuedThreadMessage[] = [
      {
        environmentId: context.environmentId,
        threadId: v2ThreadId,
        messageId: MessageId.make("pending"),
        commandId: CommandId.make("pending"),
        text: "Next question",
        attachments: [],
        createdAt: "2026-06-20T00:00:00Z",
      },
    ];
    const read = () => {
      const { rows, feed } = project(projection);
      const pending = append(rows, feed, queued);
      const filtered = filter(pending);
      return {
        feed,
        rows,
        pending,
        filtered,
        summary: threadFeedSummary(filtered),
        gallery: threadImageGallery(filtered, context),
        decorations: decorate(filtered, null),
      };
    };
    read();
    projection = updateItem(projection, { ...lastReply(projection), text: "Warm chunk" });
    const initial = read();
    let historicalReads = 0;
    for (const entry of initial.filtered) {
      if (entry.type !== "message" || entry.id === "message-1003" || entry.id === "pending")
        continue;
      const message = entry.message;
      Object.defineProperty(entry, "message", {
        get: () => {
          historicalReads++;
          return message;
        },
        configurable: true,
      });
    }
    const start = performance.now();
    for (let index = 0; index < chunks; index++)
      projection = updateItem(projection, { ...lastReply(projection), text: `Streamed ${index}` });
    const next = read();
    const after = performance.now() - start;
    expect(historicalReads).toBe(0);
    expect(next.filtered[0]).toBe(initial.filtered[0]);
    expect(next.summary).toBe(initial.summary);
    expect(next.gallery).toBe(initial.gallery);
    expect(next.decorations).toBe(initial.decorations);
    expect(next.filtered).toEqual(
      filterDiscordThreadFeed(appendPendingThreadMessages(next.rows, next.feed, queued)),
    );
    expect(next.filtered.at(-1)).toMatchObject({ pendingMessage: queued[0] });
    const beforeStart = performance.now();
    const uncached = filterDiscordThreadFeed(
      appendPendingThreadMessages(next.rows, next.feed, queued),
    );
    threadFeedSummary(uncached);
    threadImageGallery(uncached, context);
    createTimelineDecorationsProjector()(uncached, null);
    console.info(
      `Discord+pending:1004:${chunks} before/after (ms)`,
      performance.now() - beforeStart,
      after,
    );
    const changedQueue = [{ ...queued[0]!, text: "Updated question" }];
    expect(filter(append(next.rows, next.feed, changedQueue))).toEqual(
      filterDiscordThreadFeed(appendPendingThreadMessages(next.rows, next.feed, changedQueue)),
    );
  });

  it("reuses unchanged mixed reasoning rows and drops reasoning-only groups", () => {
    const projection = syntheticThread(12);
    const feed = buildThreadFeed(projection.visibleTurnItems);
    const first = filterDiscordThreadFeed(feed);
    const next = filterDiscordThreadFeed(feed);
    expect(next).toEqual(first);
    first.forEach((row, index) => expect(next[index]).toBe(row));
    for (const row of first)
      if (row.type === "activity-group" || row.type === "work-toggle")
        expect(
          row.activities.every((activity) => activity.projectedItem.item.type !== "reasoning"),
        ).toBe(true);
  });

  it("stabilizes untouched row references across tool updates and identical rebuilds", () => {
    let projection = syntheticThread(12);
    const project = pipeline();
    const stabilize = createStableThreadFeedProjector();

    const firstRows = stabilize(project(projection).rows);
    expect(firstRows.length).toBeGreaterThan(2);

    // An identical rebuild returns the exact previous array reference.
    const rebuiltSame = stabilize(
      deriveThreadFeedPresentation(
        buildThreadFeed(projection.visibleTurnItems),
        running(projection),
        expandedRuns,
        expandedGroups,
        running(projection).startedAt,
      ),
    );
    expect(rebuiltSame).toBe(firstRows);

    // Updating a visible active-run command keeps all message row object references intact.
    const activeRunId = running(projection).runId;
    const toolItem = projection.visibleTurnItems.find(
      (entry) => entry.item.type === "command_execution" && entry.item.runId === activeRunId,
    )?.item;
    expect(toolItem?.type).toBe("command_execution");
    if (toolItem?.type !== "command_execution") return;
    projection = updateItem(projection, {
      ...toolItem,
      output: "updated output",
    });
    const afterToolUpdate = stabilize(project(projection).rows);
    expect(afterToolUpdate).not.toBe(firstRows);
    const previousMessages = firstRows.filter((row) => row.type === "message");
    const nextMessages = afterToolUpdate.filter((row) => row.type === "message");
    expect(nextMessages.length).toBe(previousMessages.length);
    for (let i = 0; i < previousMessages.length; i++) {
      expect(nextMessages[i]).toBe(previousMessages[i]);
    }

    // Subsequent streaming text chunk keeps O(1) single-row replacement stability.
    const streamingMessageId = lastReply(projection).messageId;
    projection = updateItem(projection, { ...lastReply(projection), text: "Streamed after tool" });
    const afterStream = stabilize(project(projection).rows);
    expect(afterStream.length).toBe(afterToolUpdate.length);
    for (let i = 0; i < afterToolUpdate.length; i++) {
      if (afterToolUpdate[i]!.id === streamingMessageId) {
        expect(afterStream[i]).not.toBe(afterToolUpdate[i]);
      } else {
        expect(afterStream[i]).toBe(afterToolUpdate[i]);
      }
    }
  });
});

describe("agent reply footers", () => {
  const message = (
    id: string,
    role: "user" | "assistant",
    runId: string,
    extra: Partial<ThreadFeedMessage> = {},
  ): ThreadFeedEntry => ({
    type: "message",
    id,
    createdAt: DateTime.formatIso(v2Now),
    message: {
      id: MessageId.make(id),
      role,
      text: "text",
      attachments: [],
      runId: RunId.make(runId),
      streaming: false,
      visibility: "local",
      sourceThreadId: v2ThreadId,
      createdAt: DateTime.formatIso(v2Now),
      updatedAt: DateTime.formatIso(v2Now),
      ...extra,
    },
  });
  // run-2 stays open on an agent timer: the user wrote to the waiting agent twice.
  const feed = [
    message("u-1", "user", "run-1"),
    message("a-1", "assistant", "run-1"),
    message("u-2", "user", "run-2"),
    message("a-2", "assistant", "run-2"),
    message("u-3", "user", "run-2", { inputIntent: "steer", agentWasWaiting: true }),
    message("a-3", "assistant", "run-2"),
    message("u-4", "user", "run-2", { inputIntent: "steer", agentWasWaiting: true }),
    message("a-4", "assistant", "run-2"),
  ];

  it("finishes a reply that a message to the waiting agent follows", () => {
    const summary = threadFeedSummary(feed);
    expect([...threadFeedFinalAssistantMessageIds(summary, RunId.make("run-2"))]).toEqual([
      "a-1",
      "a-2",
      "a-3",
    ]);
    // The same run waiting only on its timer has finished its latest reply too.
    expect([...threadFeedFinalAssistantMessageIds(summary, null)]).toEqual([
      "a-1",
      "a-2",
      "a-3",
      "a-4",
    ]);
  });

  it("keeps a reply open across a steer to a working agent", () => {
    const summary = threadFeedSummary([
      message("u-1", "user", "run-1"),
      message("a-1", "assistant", "run-1"),
      message("u-2", "user", "run-1", { inputIntent: "steer" }),
      message("a-2", "assistant", "run-1"),
    ]);
    expect([...threadFeedFinalAssistantMessageIds(summary, RunId.make("run-1"))]).toEqual([]);
    expect([...threadFeedFinalAssistantMessageIds(summary, null)]).toEqual(["a-2"]);
    expect([...summary.assistantIdsBeforeUserBubble]).toEqual(["a-1"]);
  });

  it("spaces only agent messages directly above a user bubble", () => {
    const summary = threadFeedSummary([
      ...feed,
      message("u-5", "user", "run-3", { createdBy: "agent", creationSource: "mcp" }),
    ]);
    expect([...summary.assistantIdsBeforeUserBubble]).toEqual(["a-1", "a-2", "a-3"]);
  });
});
