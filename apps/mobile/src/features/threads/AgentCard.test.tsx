import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { buildCardReplyContext, validateAndNormalizeCardInput } from "@t3tools/shared/cards";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { buildThreadFeed } from "../../lib/threadActivity";

const envId = EnvironmentId.make("env-mobile-card");
const threadId = ThreadId.make("thread-mobile-card");
const baseTime = DateTime.makeUnsafe("2026-11-26T20:00:00.000Z");

describe("mobile thread feed projection for show_card", () => {
  it("projects streaming skeleton while running, ready card when completed, and locks after user reply", () => {
    const cardInput = {
      title: "Release check",
      subtitle: "iOS + server",
      tone: "good",
      icon: "bot",
      blocks: [
        { text: "All checks green." },
        { stats: [{ label: "Pass", value: "99%", delta: "+1%" }] },
        { progress: { percent: 100, label: "Ready", eta: "Done" } },
      ],
      actions: [
        { label: "Ship", reply: "Ship the release.", style: "primary" },
        { label: "Hold", reply: "Hold for now.", style: "plain" },
      ],
    };

    const streamingFeed = buildThreadFeed([
      {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: "item-card-1" as never,
        item: {
          id: "item-card-1" as never,
          threadId,
          runId: "run-1" as never,
          nodeId: "node-1" as never,
          parentItemId: null,
          ordinal: 1,
          type: "dynamic_tool",
          status: "running",
          toolName: "mcp__t3-code__show_card",
          input: { title: "Release check" },
          startedAt: baseTime,
          updatedAt: baseTime,
          completedAt: null,
        } as never,
      },
    ]);

    expect(streamingFeed).toHaveLength(1);
    expect(streamingFeed[0]).toMatchObject({
      type: "agent-card",
      card: { state: "streaming", streamingTitle: "Release check" },
    });

    const replyContext = buildCardReplyContext({
      itemId: "item-card-1",
      kind: "action",
      actionIndex: 0,
      label: "Ship",
    });

    const lockedFeed = buildThreadFeed([
      {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: "item-card-1" as never,
        item: {
          id: "item-card-1" as never,
          threadId,
          runId: "run-1" as never,
          nodeId: "node-1" as never,
          parentItemId: null,
          ordinal: 1,
          type: "dynamic_tool",
          status: "completed",
          toolName: "t3-code.show_card",
          input: cardInput,
          output: { ok: true },
          startedAt: baseTime,
          updatedAt: baseTime,
          completedAt: baseTime,
        } as never,
      },
      {
        position: 1,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: "item-user-2" as never,
        item: {
          id: "item-user-2" as never,
          threadId,
          runId: "run-2" as never,
          nodeId: "node-2" as never,
          parentItemId: null,
          ordinal: 2,
          type: "user_message",
          status: "completed",
          createdBy: "user",
          creationSource: "mobile",
          messageId: "msg-2" as never,
          inputIntent: "new_turn",
          text: "Ship the release.",
          context: replyContext,
          attachments: [],
          startedAt: baseTime,
          updatedAt: baseTime,
          completedAt: baseTime,
        } as never,
      },
    ]);

    expect(lockedFeed).toHaveLength(2);
    const cardEntry = lockedFeed[0];
    expect(cardEntry?.type).toBe("agent-card");
    if (cardEntry?.type === "agent-card") {
      expect(cardEntry.card.state).toBe("ready");
      expect(cardEntry.lockedState).toEqual({
        locked: true,
        selectedActionIndex: 0,
        selectedActionLabel: "Ship",
      });
    }
    expect(validateAndNormalizeCardInput(cardInput).ok).toBe(true);
    expect(envId).toBeTruthy();
  });

  it("keeps cards from an old turn readable but inert even when answered by typed text", () => {
    const feed = buildThreadFeed([
      {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: "item-old-card" as never,
        item: {
          id: "item-old-card" as never,
          threadId,
          runId: "run-1" as never,
          nodeId: "node-1" as never,
          parentItemId: null,
          ordinal: 1,
          type: "dynamic_tool",
          status: "completed",
          toolName: "mcp__custom__show_card",
          input: {
            title: "Old choice",
            actions: [{ label: "Yes", reply: "Yes, do it.", style: "primary" }],
          },
          output: { ok: true },
          startedAt: baseTime,
          updatedAt: baseTime,
          completedAt: baseTime,
        } as never,
      },
      {
        position: 1,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: "item-typed-reply" as never,
        item: {
          id: "item-typed-reply" as never,
          threadId,
          runId: "run-2" as never,
          nodeId: "node-2" as never,
          parentItemId: null,
          ordinal: 2,
          type: "user_message",
          status: "completed",
          createdBy: "user",
          creationSource: "mobile",
          messageId: "msg-typed" as never,
          inputIntent: "new_turn",
          text: "Actually never mind",
          attachments: [],
          startedAt: baseTime,
          updatedAt: baseTime,
          completedAt: baseTime,
        } as never,
      },
    ]);

    expect(feed[0]).toMatchObject({
      type: "agent-card",
      lockedState: { locked: true },
    });
  });
});
