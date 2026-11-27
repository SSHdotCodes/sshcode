import {
  EventId,
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import {
  sortActiveThreadsByOrderKey,
  sortThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import {
  presentSessionBoxCached,
  sessionBoxSiblingShare,
  sessionBoxFacesFor,
} from "@t3tools/client-runtime/state/session-boxes";
import * as DateTime from "effect/DateTime";
import { describe, expect, test } from "vite-plus/test";

import { rankSidebarSearchResults } from "./components/Sidebar.logic";
import {
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
} from "./components/chat/MessagesTimeline.logic";
import {
  deriveTimelineEntriesFromVisibleTurnItems,
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
} from "./session-logic";
import { makeThreadFixture, makeThreadProjectionFixture } from "./test-fixtures";

// Run with `vp test bench apps/web/src/desktopPerformance.bench.ts --run --reporter verbose`.
function measure(name: string, operation: () => unknown, iterations = 1) {
  operation();
  const samples = Array.from({ length: 5 }, () => {
    const start = performance.now();
    for (let index = 0; index < iterations; index += 1) operation();
    return (performance.now() - start) / iterations;
  }).sort((a, b) => a - b);
  console.log(JSON.stringify({ name, medianMs: samples[2], minMs: samples[0], maxMs: samples[4] }));
}

function makeHistory(count: number): OrchestrationV2ThreadProjection {
  const projection = makeThreadProjectionFixture();
  const turnItems: OrchestrationV2TurnItem[] = Array.from({ length: count }, (_, index) => {
    const time = DateTime.makeUnsafe(Date.UTC(2026, 8, 4) + index * 1000);
    const base = {
      id: TurnItemId.make(`item-${index}`),
      threadId: projection.thread.id,
      runId: RunId.make(`run-${Math.floor(index / 5)}`),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: index,
      status: "completed" as const,
      title: null,
      startedAt: time,
      completedAt: time,
      updatedAt: time,
    };
    switch (index % 5) {
      case 0:
        return {
          ...base,
          type: "user_message",
          messageId: MessageId.make(`message-${index}`),
          text: "Inspect the repository",
          attachments: [],
          inputIntent: "turn_start",
          createdBy: "user",
          creationSource: "web",
        };
      case 1:
        return {
          ...base,
          type: "reasoning",
          text: "Consider the implementation. ".repeat(30),
          streaming: false,
        };
      case 2:
        return {
          ...base,
          type: "dynamic_tool",
          toolName: "read_file",
          input: { path: `/repo/src/file-${index}.ts` },
          output: "file contents\n".repeat(100),
        };
      case 3:
        return {
          ...base,
          type: "file_change",
          fileName: `src/file-${index}.ts`,
          diffStr: "@@ -1 +1 @@\n-before\n+after\n".repeat(50),
        };
      default:
        return {
          ...base,
          type: "assistant_message",
          messageId: MessageId.make(`message-${index}`),
          text: "Here is the result. ".repeat(30),
          streaming: false,
        };
    }
  });
  return {
    ...projection,
    turnItems,
    visibleTurnItems: turnItems.map((item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: item.threadId,
      sourceItemId: item.id,
      item,
    })),
  };
}

describe("desktop large-data performance", () => {
  test.each([1_000, 5_000])("history with %i items", (count) => {
    const history = makeHistory(count);
    const input = {
      visibleTurnItems: history.visibleTurnItems,
      optimisticMessages: [],
      liveThoughts: true,
    };
    const entries = deriveTimelineEntriesFromVisibleTurnItems(input);
    const context = {
      timelineEntries: entries,
      isWorking: true,
      turnDiffSummaries: [],
      supportsConversationRollback: true,
    };
    measure(`entries:${count}`, () => deriveTimelineEntriesFromVisibleTurnItems(input), 5);
    measure(`timeline:${count}`, () => deriveMessagesTimelineRows(context), 5);
    for (const kind of ["assistant_message", "reasoning", "dynamic_tool"] as const) {
      const index = history.turnItems.findLastIndex((item) => item.type === kind);
      const original = history.turnItems[index]!;
      const live = {
        ...original,
        status: "running" as const,
        completedAt: null,
        ...(kind === "dynamic_tool" ? {} : { streaming: true }),
      };
      const initial = applyOrchestrationV2ProjectionEvent(history, {
        id: EventId.make("start"),
        type: "turn-item.updated",
        threadId: history.thread.id,
        occurredAt: history.updatedAt,
        payload: live,
      })!;
      measure(`stream:${kind}:${count}:20`, () => {
        let projection = initial;
        let entryState = deriveTimelineEntriesFromVisibleTurnItemsWithState({
          ...input,
          visibleTurnItems: projection.visibleTurnItems,
        });
        let rowState = deriveMessagesTimelineRowsWithState({
          ...context,
          timelineEntries: entryState.entries,
        });
        for (let chunk = 0; chunk < 20; chunk += 1) {
          const payload = {
            ...live,
            ...(kind === "dynamic_tool"
              ? { output: `chunk ${chunk}` }
              : { text: `chunk ${chunk}` }),
          };
          projection = applyOrchestrationV2ProjectionEvent(projection, {
            id: EventId.make(`event-${chunk}`),
            type: "turn-item.updated",
            threadId: history.thread.id,
            occurredAt: history.updatedAt,
            payload,
          })!;
          entryState = deriveTimelineEntriesFromVisibleTurnItemsWithState(
            { ...input, visibleTurnItems: projection.visibleTurnItems },
            entryState,
          );
          rowState = deriveMessagesTimelineRowsWithState(
            { ...context, timelineEntries: entryState.entries },
            rowState,
          );
        }
        expect(rowState.rows.length).toBeGreaterThan(0);
      });
    }
  });

  test.each([1_000, 5_000])("sidebar with %i chats", (count) => {
    const threads = Array.from({ length: count }, (_, index) =>
      makeThreadFixture({
        id: ThreadId.make(`thread-${index}`),
        title: `Chat ${index}`,
        createdAt: new Date(Date.UTC(2026, 8, 4) + ((index * 997) % count) * 1000).toISOString(),
      }),
    );
    measure(`sidebar:sort:${count}`, () => sortThreads(threads, "updated_at"), 10);
    measure(`sidebar:active:${count}`, () => sortActiveThreadsByOrderKey(threads), 10);
    measure(
      `sidebar:search:${count}`,
      () => rankSidebarSearchResults({ known: threads, matches: [], query: "chat 9" }),
      10,
    );
    const siblingShare = sessionBoxSiblingShare(threads.map((thread) => thread.title));
    const faces = sessionBoxFacesFor(threads);
    let now = Date.UTC(2026, 8, 4);
    measure(`sidebar:box-clock:${count}`, () => {
      now += 1_000;
      return threads.map((thread) =>
        presentSessionBoxCached(thread, {
          now,
          unseen: false,
          compact: true,
          siblingShare,
          face: faces.get(thread.id),
        }),
      );
    });
  });
});
