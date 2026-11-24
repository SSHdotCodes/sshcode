import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  MessageId,
  OrchestrationV2Command,
  THREAD_PINNED_MESSAGES_LIMIT,
  type ThreadPinnedMessage,
} from "@t3tools/contracts";

import { withMessagePin } from "./Orchestrator.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);
const first = MessageId.make("message-1");
const second = MessageId.make("message-2");
const decodeCommand = Schema.decodeUnknownSync(OrchestrationV2Command);

it("pins a message once, keeps its preview and first pin time, and unpins it", () => {
  const pinned = withMessagePin(
    [],
    { messageId: first, pinned: true, preview: "  The plan  " },
    at("2026-11-24T20:00:00.000Z"),
  );
  assert.deepStrictEqual(
    pinned.map((pin) => [pin.messageId, pin.preview]),
    [[first, "The plan"]],
  );
  // Pinning again (a second device, a retried tap) is a no-op.
  const again = withMessagePin(
    pinned,
    { messageId: first, pinned: true },
    at("2026-11-24T21:00:00.000Z"),
  );
  assert.strictEqual(again, pinned);
  const both = withMessagePin(
    again,
    { messageId: second, pinned: true },
    at("2026-11-24T21:00:00.000Z"),
  );
  assert.deepStrictEqual(
    both.map((pin) => pin.messageId),
    [first, second],
  );
  assert.strictEqual(both[1]!.preview, undefined);
  assert.deepStrictEqual(
    withMessagePin(both, { messageId: first, pinned: false }, at("2026-11-24T22:00:00.000Z")).map(
      (pin) => pin.messageId,
    ),
    [second],
  );
});

it("keeps the newest pins once a chat reaches the limit", () => {
  const now = at("2026-11-24T20:00:00.000Z");
  const full: ThreadPinnedMessage[] = Array.from(
    { length: THREAD_PINNED_MESSAGES_LIMIT },
    (_, index) => ({
      messageId: MessageId.make(`message-${index}`),
      pinnedAt: now,
    }),
  );
  const next = withMessagePin(
    full,
    { messageId: MessageId.make("message-new"), pinned: true },
    now,
  );
  assert.strictEqual(next.length, THREAD_PINNED_MESSAGES_LIMIT);
  assert.strictEqual(next[0]!.messageId, "message-1");
  assert.strictEqual(next.at(-1)!.messageId, "message-new");
});

it("decodes a pin change on thread.metadata.update", () => {
  const decoded = decodeCommand({
    type: "thread.metadata.update",
    commandId: "command-pin",
    threadId: "thread-1",
    messagePin: { messageId: "message-1", pinned: true, preview: "The plan" },
  });
  assert.deepStrictEqual(
    (decoded as Extract<typeof decoded, { type: "thread.metadata.update" }>).messagePin,
    { messageId: first, pinned: true, preview: "The plan" },
  );
});
