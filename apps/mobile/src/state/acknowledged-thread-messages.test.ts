import { DateTime } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { echoedAcknowledgedMessageIds } from "./acknowledged-thread-messages";

const run = (ordinal: number, status: string, userMessageId: string) =>
  ({ id: `run-${ordinal}`, ordinal, status, userMessageId }) as never;
const SENT_AT = Date.parse("2026-11-13T21:28:23.000Z");
const at = (ms: number) => DateTime.makeUnsafe(ms);
const userMessage = (runOrdinal: number, messageId: string, updatedAt = SENT_AT) =>
  ({
    item: { type: "user_message", runId: `run-${runOrdinal}`, messageId, updatedAt: at(updatedAt) },
  }) as never;
const reply = (runOrdinal: number, updatedAt = SENT_AT) =>
  ({
    item: { type: "assistant_message", runId: `run-${runOrdinal}`, updatedAt: at(updatedAt) },
  }) as never;

describe("echoedAcknowledgedMessageIds", () => {
  it("drops a sent message once it is visible", () => {
    const ids = echoedAcknowledgedMessageIds(
      [userMessage(2, "m2"), reply(2)],
      [run(1, "completed", "m1"), run(2, "running", "m2")],
      [],
    );
    expect(ids.has("m2")).toBe(true);
  });

  it("keeps a just-started message whose item has not arrived yet", () => {
    const ids = echoedAcknowledgedMessageIds(
      [userMessage(1, "m1"), reply(1)],
      [run(1, "completed", "m1"), run(2, "starting", "m2")],
      [],
    );
    expect(ids.has("m2")).toBe(false);
  });

  it("drops a sent message whose turn is older than the loaded window", () => {
    // The phone loads one user turn: a later card answer starts the window, so
    // the 12:31 message lives in unloaded history and must not sit at the bottom.
    const ids = echoedAcknowledgedMessageIds(
      [userMessage(3, "answer"), reply(3), reply(4)],
      [run(2, "completed", "m-1231"), run(3, "completed", "answer"), run(4, "completed", "wake")],
      [{ id: "m-1231" }],
      [{ messageId: "m-1231", receiptSequence: 4 }],
      12,
    );
    expect(ids.has("m-1231")).toBe(true);
  });

  it("drops a sent message when a reopened chat's snapshot no longer lists its run", () => {
    // Sent at 4:28, phone asleep until 5:22: the fresh snapshot holds only the
    // latest turn and its run, so the old run's ordinal is unknown.
    const hourLater = SENT_AT + 54 * 60_000;
    const ids = echoedAcknowledgedMessageIds(
      [userMessage(68, "m-0504", hourLater - 60_000), reply(68, hourLater)],
      [run(68, "completed", "m-0504")],
      [],
      [{ messageId: "m-0428", receiptSequence: 10 }],
      10,
    );
    expect(ids.has("m-0428")).toBe(true);
  });

  it("keeps a sent message while the shown items are no newer than its acknowledgment", () => {
    // A live reply that keeps streaming right after the send, within clock skew.
    const ids = echoedAcknowledgedMessageIds(
      [userMessage(1, "m1"), reply(1, SENT_AT + 20_000)],
      [run(1, "running", "m1")],
      [],
      [{ messageId: "m2", receiptSequence: 15 }],
      14,
    );
    expect(ids.has("m2")).toBe(false);
  });

  it("treats queued, cancelled and rolled-back inputs as owned by the server", () => {
    const ids = echoedAcknowledgedMessageIds(
      [],
      [run(1, "queued", "q"), run(2, "cancelled", "c"), run(3, "rolled_back", "r")],
      [{ id: "q" }],
    );
    expect([...ids].sort()).toEqual(["c", "q", "r"]);
  });
});

it("keeps an acknowledged send awaiting its first event when the phone clock is slow", () => {
  for (const receiptSequence of [11, undefined, 0]) {
    const ids = echoedAcknowledgedMessageIds(
      [reply(1, SENT_AT + 60_000)],
      [run(1, "running", "first")],
      [],
      [{ messageId: "new-send", receiptSequence }],
      10,
    );
    expect(ids.has("new-send")).toBe(false);
  }
});
