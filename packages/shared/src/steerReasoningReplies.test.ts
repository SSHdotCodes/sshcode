import { describe, expect, it } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { selectSteerReasoningReplies } from "./casualVoice.ts";

const runId = RunId.make("run");
const threadId = ThreadId.make("thread");
const now = DateTime.makeUnsafe("2026-10-27T00:00:00Z");
const base = (id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  ordinal,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  title: null,
  status: "completed" as const,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});
const steer = (
  ordinal: number,
  intent: "steer" | "promoted_queued_to_steer" | "turn_start" = "steer",
): Extract<OrchestrationV2TurnItem, { type: "user_message" }> => ({
  ...base(`steer-${ordinal}`, ordinal),
  type: "user_message",
  messageId: MessageId.make(`steer-${ordinal}`),
  text: "Check the earlier result.",
  inputIntent: intent,
  attachments: [],
  createdBy: "user",
  creationSource: "web",
});
const thought = (
  ordinal: number,
  text = "The earlier result probably still applies.",
  streaming = false,
): OrchestrationV2TurnItem => ({
  ...base(`thought-${ordinal}`, ordinal),
  type: "reasoning",
  text,
  streaming,
});
const answer = (ordinal: number): OrchestrationV2TurnItem => ({
  ...base(`answer-${ordinal}`, ordinal),
  type: "assistant_message",
  messageId: MessageId.make(`answer-${ordinal}`),
  text: "Here is the result.",
  streaming: false,
});
const ended = [{ id: runId, status: "completed" }];
const ids = (items: OrchestrationV2TurnItem[], runs = ended) =>
  selectSteerReasoningReplies(items, runs).map((reply) => ({
    steer: reply.steer.messageId,
    items: reply.items.map((item) => item.id),
    closed: reply.closed,
  }));

describe("steer reasoning windows", () => {
  it("selects reasoning by ordinal, stops at assistant text and ignores nested or other-run output", () => {
    expect(
      ids([
        thought(6),
        answer(5),
        { ...thought(4), runId: RunId.make("other") },
        thought(3),
        steer(2),
        { ...thought(1), parentItemId: TurnItemId.make("tool") },
      ]),
    ).toEqual([{ steer: "steer-2", items: ["thought-3"], closed: true }]);
    expect(ids([steer(1), answer(2), thought(3)])).toEqual([]);
    expect(ids([steer(1, "turn_start"), thought(2)])).toEqual([]);
  });
  it("keeps each delivered steer in one group and closes the preceding window", () => {
    expect(
      ids([steer(1), thought(2), steer(3, "promoted_queued_to_steer"), thought(4), thought(5)], []),
    ).toEqual([
      { steer: "steer-1", items: ["thought-2"], closed: true },
      { steer: "steer-3", items: ["thought-4", "thought-5"], closed: false },
    ]);
    expect(ids([steer(1), steer(2), thought(3)])).toEqual([
      { steer: "steer-2", items: ["thought-3"], closed: true },
    ]);
  });
  it.each(["steer", "promoted_queued_to_steer"] as const)(
    "ends the previous reply without narrating a %s sent while waiting",
    (intent) => {
      expect(
        ids([
          steer(1),
          thought(2),
          { ...steer(3, intent), agentWasWaiting: true },
          thought(4),
          answer(5),
        ]),
      ).toEqual([{ steer: "steer-1", items: ["thought-2"], closed: true }]);
    },
  );
  it("does not infer delivery from an older tool finishing or from child output", () => {
    const tool: OrchestrationV2TurnItem = {
      ...base("tool", 1),
      type: "command_execution",
      input: "synthetic command",
    };
    expect(ids([tool, steer(2), { ...thought(3), parentItemId: tool.id }], [])).toEqual([]);
    expect(ids([steer(1), thought(2, "Partial", true)], [])).toEqual([]);
    expect(ids([steer(1), thought(2), thought(3, "Partial", true), answer(4)], [])).toEqual([
      { steer: "steer-1", items: ["thought-2"], closed: false },
    ]);
  });
  it("closes only at assistant text, a cap, or a settled run", () => {
    expect(ids([steer(1), thought(2)], [])).toEqual([
      { steer: "steer-1", items: ["thought-2"], closed: false },
    ]);
    expect(
      ids([steer(1), thought(2), answer(3)], [{ id: runId, status: "running" }])[0]?.closed,
    ).toBe(true);
    expect(ids([steer(1), thought(2)], [{ id: runId, status: "interrupted" }])[0]?.closed).toBe(
      true,
    );
    expect(ids([steer(1), thought(2), thought(3), thought(4), thought(5)], [])[0]).toEqual({
      steer: "steer-1",
      items: ["thought-2", "thought-3", "thought-4"],
      closed: true,
    });
  });
  it("caps at complete items within the character budget, with a verbatim long first fallback", () => {
    expect(
      ids([steer(1), thought(2, "x".repeat(800)), thought(3, "y".repeat(800)), thought(4)], [])[0]
        ?.items,
    ).toEqual(["thought-2"]);
    expect(ids([steer(1), thought(2, "x".repeat(1600)), thought(3)], [])[0]).toMatchObject({
      items: ["thought-2"],
      closed: true,
    });
    expect(ids([steer(1), thought(2, "x".repeat(1500))], [])[0]?.closed).toBe(true);
  });
});
