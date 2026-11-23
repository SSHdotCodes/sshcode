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
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import { describe, expect, it, vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  v2Now,
  v2Projection,
  v2ThreadId,
} from "../../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import {
  buildThreadFeed,
  deriveThreadFeedPresentation,
  filterDiscordThreadFeed,
  type ThreadFeedLatestRun,
} from "../../lib/threadActivity";
import {
  createDiscordThreadFeedProjector,
  createStableThreadFeedProjector,
  createThreadFeedProjector,
  createThreadFeedPresentationProjector,
  threadFeedSummary,
  threadFeedFailedRunIds,
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
      expect(next.rows.at(-2)).toBe(next.feed.at(-1));
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
