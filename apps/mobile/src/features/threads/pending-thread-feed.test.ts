import { describe, expect, it } from "vite-plus/test";
import type { QueuedThreadRun } from "@t3tools/client-runtime/state/thread-workflows";
import * as DateTime from "effect/DateTime";
import {
  CommandId,
  ComposerContextId,
  EnvironmentId,
  MessageId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type { QueuedThreadMessage } from "../../state/thread-outbox-model";
import { appendPendingThreadMessages } from "../../state/pending-thread-feed";

const pending = (id: string): QueuedThreadMessage => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  messageId: MessageId.make(id),
  commandId: CommandId.make(id),
  text: id,
  attachments: [],
  createdAt: "2026-09-06T10:00:00.000Z",
});

describe("pending timeline messages", () => {
  it("retains context records while a message is waiting for delivery", () => {
    const record = {
      version: 1 as const,
      kind: "mention" as const,
      contextId: ComposerContextId.make("setup-file"),
      label: "Checkout.tsx",
      path: "src/Checkout.tsx",
    };
    const context = { version: 1 as const, records: [record] };
    const text = "[Checkout.tsx](t3-context://v1/mention/setup-file)";
    const entries = appendPendingThreadMessages([], [], [{ ...pending("context"), text, context }]);
    const entry = entries[0];
    expect(entry?.type).toBe("message");
    if (entry?.type !== "message") throw new Error("Expected a pending message");
    expect(entry.message.text).toBe(text);
    expect(entry.message.context).toEqual(context);
  });

  it("keeps pending messages after newer agent activity in queue order", () => {
    const activity = {
      type: "thinking",
      runId: null,
      id: "thinking",
      createdAt: "2026-09-06T11:00:00.000Z",
    } as const;
    const entries = appendPendingThreadMessages(
      [activity],
      [],
      [pending("first"), pending("second")],
    );
    expect(entries.map((entry) => entry.id)).toEqual(["thinking", "first", "second"]);
    expect(entries[1]?.pendingMessage?.text).toBe("first");
  });

  it("reuses the message id and suppresses the pending copy when delivery appears", () => {
    const queued = pending("sent");
    const optimistic = appendPendingThreadMessages([], [], [queued])[0]!;
    const delivered = { ...optimistic, pendingMessage: undefined };
    expect(appendPendingThreadMessages([delivered], [delivered], [queued])).toEqual([delivered]);
    // Folded messages still count as delivered even when absent from the presented rows.
    expect(appendPendingThreadMessages([], [delivered], [queued])).toEqual([]);
  });
});

const serverQueued = (id: string): QueuedThreadRun => ({
  run: {
    id: RunId.make(`run-${id}`),
    threadId: ThreadId.make("thread"),
    status: "queued",
    requestedAt: DateTime.makeUnsafe("2026-09-06T10:05:00.000Z"),
  } as QueuedThreadRun["run"],
  text: id,
  attachments: [],
  messageId: MessageId.make(id),
});

describe("server queued timeline messages", () => {
  it("keeps messages through acknowledgement and suppresses duplicates on start", () => {
    const local = pending("follow-up");
    const queued = serverQueued("follow-up");
    const accepted = appendPendingThreadMessages([], [], [], [queued]);
    expect(appendPendingThreadMessages([], [], [local], [queued])).toEqual(accepted);
    expect(accepted[0]?.serverQueued).toBe(true);
    const delivered = { ...accepted[0]!, serverQueued: undefined };
    expect(appendPendingThreadMessages([delivered], [delivered], [], [queued])).toEqual([
      delivered,
    ]);
    expect(appendPendingThreadMessages([], [delivered], [], [queued])).toEqual([]);
  });
  it("keeps the local payload in server queue order before the message body arrives", () => {
    const local = pending("second");
    const entries = appendPendingThreadMessages(
      [],
      [],
      [local],
      [
        serverQueued("first"),
        { ...serverQueued("second"), awaitingMessage: true, text: "Queued message" },
      ],
    );
    expect(entries.map((entry) => entry.id)).toEqual(["first", "second"]);
    expect(entries[1]).toMatchObject({
      serverQueued: true,
      pendingMessage: local,
      message: { text: local.text },
    });
  });

  it("uses server order and removes cancelled entries", () => {
    const one = serverQueued("one");
    const two = serverQueued("two");
    expect(appendPendingThreadMessages([], [], [], [two, one]).map((row) => row.id)).toEqual([
      "two",
      "one",
    ]);
    expect(appendPendingThreadMessages([], [], [], [one]).map((row) => row.id)).toEqual(["one"]);
  });
});
