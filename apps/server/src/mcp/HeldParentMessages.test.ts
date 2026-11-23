import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import {
  addHeldMessage,
  combineHeldMessages,
  type HeldParentMessage,
  MAX_HELD_PER_PARENT,
  MAX_HELD_TEXT,
  shouldHoldForParent,
} from "./HeldParentMessages.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";

const parentId = ThreadId.make("thread:lead");
const childId = ThreadId.make("thread:sol-moe");

const parent = idleThreadProjection(liveThreadShell(parentId, { activeRunId: null }));
const child = (relationshipToParent: "subagent" | "fork" = "subagent") => {
  const projection = idleThreadProjection(liveThreadShell(childId));
  return {
    ...projection,
    thread: {
      ...projection.thread,
      lineage: { rootThreadId: parentId, parentThreadId: parentId, relationshipToParent },
    },
  };
};

/** The parent mid-turn, so a message can steer into it. */
const steerable: OrchestrationV2ThreadProjection = {
  ...parent,
  runs: [{ status: "running", activeAttemptId: "attempt:1" } as unknown as OrchestrationV2Run],
  providerTurns: [
    { runAttemptId: "attempt:1", status: "running" } as unknown as OrchestrationV2ProviderTurn,
  ],
};

const held = (index: number, sender = childId): HeldParentMessage => ({
  projectId: ProjectId.make("project:mcp-test"),
  senderThreadId: sender,
  senderTitle: `Agent ${sender}`,
  messageId: MessageId.make(`message:update-${index}`),
  commandId: CommandId.make(`command:update-${index}`),
  text: `Update ${index}`,
});

describe("held parent messages", () => {
  it("holds a subagent's auto message only while its parent has no turn to steer into", () => {
    assert.isTrue(shouldHoldForParent({ mode: undefined, caller: child(), target: parent }));
    assert.isTrue(shouldHoldForParent({ mode: "auto", caller: child(), target: parent }));
    assert.isFalse(shouldHoldForParent({ mode: "auto", caller: child(), target: steerable }));
  });

  it("still wakes the parent for an explicit mode, a fork, another thread or a client", () => {
    for (const mode of ["queue", "steer", "restart"] as const) {
      assert.isFalse(shouldHoldForParent({ mode, caller: child(), target: parent }));
    }
    assert.isFalse(shouldHoldForParent({ mode: "auto", caller: child("fork"), target: parent }));
    const remoteChild = child();
    assert.isFalse(
      shouldHoldForParent({
        mode: "auto",
        caller: {
          ...remoteChild,
          thread: {
            ...remoteChild.thread,
            lineage: {
              ...remoteChild.thread.lineage,
              parentEnvironmentId: EnvironmentId.make("mac-test"),
            },
          },
        },
        target: parent,
      }),
    );
    const stranger = idleThreadProjection(liveThreadShell(ThreadId.make("thread:other")));
    assert.isFalse(shouldHoldForParent({ mode: "auto", caller: child(), target: stranger }));
    assert.isFalse(shouldHoldForParent({ mode: "auto", caller: undefined, target: parent }));
  });

  it("ignores retries and keeps only the newest messages", () => {
    const once = addHeldMessage([], held(1));
    assert.strictEqual(addHeldMessage(once, held(1)), once);
    let many: ReadonlyArray<HeldParentMessage> = [];
    for (let index = 0; index < MAX_HELD_PER_PARENT + 5; index += 1) {
      many = addHeldMessage(many, held(index));
    }
    assert.lengthOf(many, MAX_HELD_PER_PARENT);
    assert.strictEqual(many[0]?.text, "Update 5");
  });

  it.effect("delivers one held message as sent and several as one combined message", () =>
    Effect.gen(function* () {
      assert.isNull(yield* combineHeldMessages(parentId, []));
      assert.deepStrictEqual(yield* combineHeldMessages(parentId, [held(1)]), {
        projectId: held(1).projectId,
        senderThreadId: childId,
        messageId: held(1).messageId,
        commandId: held(1).commandId,
        text: "Update 1",
      });

      const other = ThreadId.make("thread:sol-dense");
      const combined = yield* combineHeldMessages(parentId, [held(1), held(2, other)]);
      assert.isUndefined(combined?.senderThreadId);
      assert.strictEqual(
        combined?.text,
        [
          "Your subagents sent 2 updates while you were idle:",
          `From "Agent ${childId}" (thread ${childId}):\nUpdate 1`,
          `From "Agent ${other}" (thread ${other}):\nUpdate 2`,
        ].join("\n\n"),
      );
      // The same held set always maps to the same delivery, so a retry is idempotent.
      assert.deepStrictEqual(
        yield* combineHeldMessages(parentId, [held(1), held(2, other)]),
        combined,
      );
      assert.strictEqual(
        (yield* combineHeldMessages(parentId, [held(1), held(2)]))?.senderThreadId,
        childId,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.effect("bounds the entire prompt and retains recent actionable text with its source", () =>
  Effect.gen(function* () {
    let batch: ReadonlyArray<HeldParentMessage> = [];
    for (let index = 0; index < 50; index++) {
      batch = addHeldMessage(batch, {
        ...held(index),
        senderTitle: "x".repeat(512),
        text: "x".repeat(120_000) + `\nAction ${index}`,
      });
    }
    const combined = (yield* combineHeldMessages(parentId, batch))!;
    assert.isAtMost(combined.text.length, MAX_HELD_TEXT);
    assert.include(combined.text, "Action 49");
    assert.include(combined.text, `read thread ${childId}`);
    assert.isAtMost(
      batch.reduce((sum, message) => sum + message.text.length, 0),
      MAX_HELD_TEXT,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "distinguishes overlapping held batches and keeps single-message receipt identities",
  () =>
    Effect.gen(function* () {
      const first = (yield* combineHeldMessages(parentId, [held(1), held(2)]))!;
      const replaced = (yield* combineHeldMessages(parentId, [held(1), held(3)]))!;
      assert.notEqual(first.commandId, replaced.commandId);
      assert.notEqual(first.messageId, replaced.messageId);
      assert.notEqual(
        first.commandId,
        (yield* combineHeldMessages(parentId, [held(2), held(1)]))!.commandId,
      );
      assert.equal((yield* combineHeldMessages(parentId, [held(3)]))!.commandId, held(3).commandId);
    }).pipe(Effect.provide(NodeServices.layer)),
);
