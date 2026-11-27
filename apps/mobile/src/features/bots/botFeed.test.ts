import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadFeed, deriveThreadFeedPresentation } from "../../lib/threadActivity";

const threadId = ThreadId.make("bot-home");
const runId = RunId.make("run-1");

function base(id: string, second: number) {
  const timestamp = DateTime.makeUnsafe(`2026-11-26T09:00:${String(second).padStart(2, "0")}.000Z`);
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: second,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

const tool = (id: string, second: number, toolName: string): OrchestrationV2TurnItem => ({
  ...base(id, second),
  type: "dynamic_tool",
  toolName,
  input: {},
  output: { text: "ok" },
});

const say = (id: string, second: number, text: string): OrchestrationV2TurnItem => ({
  ...base(id, second),
  type: "assistant_message",
  messageId: MessageId.make(id),
  text,
  streaming: false,
});

/** The tool calls a presented row shows, whether as a group or its collapsed toggle. */
const callIds = (rows: ReturnType<typeof deriveThreadFeedPresentation>) =>
  rows.flatMap((row) =>
    row.type === "activity-group" || row.type === "work-toggle"
      ? row.activities.map((activity) => String(activity.projectedItem.item.id))
      : [],
  );

const project = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  items.map((item, position): OrchestrationV2ProjectedTurnItem => ({
    position,
    visibility: "local",
    sourceThreadId: threadId,
    sourceItemId: item.id,
    item,
  }));

// The user asks; the bot checks chats, answers, messages one, then shows a card.
const turn = buildThreadFeed(
  project([
    {
      ...base("ask", 0),
      type: "user_message",
      messageId: MessageId.make("ask"),
      createdBy: "user",
      creationSource: "mobile",
      inputIntent: "turn_start",
      text: "What's running right now?",
      attachments: [],
    },
    tool("list", 1, "mcp__t3-code__t3_thread_list"),
    tool("read-a", 2, "mcp__t3-code__t3_thread_read"),
    tool("read-b", 3, "mcp__t3-code__t3_thread_read"),
    say("answer", 4, "Two chats are running."),
    tool("send", 5, "mcp__t3-code__t3_thread_send"),
    tool("card", 6, "mcp__t3-code__show_card"),
  ]),
);

describe("bot chat timeline", () => {
  it("folds a finished turn's tools into one plain line and leaves the card out", () => {
    const rows = deriveThreadFeedPresentation(
      turn,
      null,
      new Set(),
      new Set(),
      null,
      false,
      undefined,
      true,
    );
    expect(rows.map((row) => row.type)).toEqual(["message", "run-fold", "message", "work-toggle"]);
    expect(rows[1]).toMatchObject({
      type: "run-fold",
      label: "Checked 2 chats, checked the chat list",
    });
    // Only the card stays out of the fold, on a row of its own.
    expect(callIds(rows)).toEqual(["card"]);
  });

  it("shows every folded call in place when opened", () => {
    const rows = deriveThreadFeedPresentation(
      turn,
      null,
      new Set([runId]),
      new Set(),
      null,
      false,
      undefined,
      true,
    );
    expect(rows.filter((row) => row.type === "run-fold")).toHaveLength(1);
    expect(callIds(rows)).toEqual(["list", "read-a", "read-b", "send", "card"]);
  });

  it("keeps the normal chat rule: work after prose does not fold", () => {
    const rows = deriveThreadFeedPresentation(turn, null, new Set());
    expect(rows.some((row) => row.type === "run-fold")).toBe(false);
  });
});
