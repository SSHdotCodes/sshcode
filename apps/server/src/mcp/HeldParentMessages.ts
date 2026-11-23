import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadProjection,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Hex from "effect/encoding/Hex";

/**
 * A subagent's plain message to its idle parent. Waking the parent for each
 * progress update made it a relay (one thread ran 189 turns for 149 updates),
 * so the message waits and goes in with the parent's next turn, which a
 * finished task, a question or the user's message starts anyway. If none
 * starts within {@link HELD_PARENT_MESSAGE_MAX_WAIT}, everything held wakes
 * the parent as one message.
 */
export interface HeldParentMessage {
  readonly projectId: ProjectId;
  readonly senderThreadId: ThreadId;
  readonly senderTitle: string;
  readonly messageId: MessageId;
  readonly commandId: CommandId;
  readonly text: string;
  readonly recordAcceptance?: () => void;
}

/**
 * How long held updates wait for the parent's next turn before waking it. Long
 * enough to batch a burst of progress notes into one turn, short enough that an
 * update the parent should act on doesn't sit for minutes.
 */
export const HELD_PARENT_MESSAGE_MAX_WAIT = Duration.minutes(2);

/** Each parent keeps at most this many held messages; the oldest go first. */
export const MAX_HELD_PER_PARENT = 50;
/** Includes sender labels and batch framing, not just message bodies. */
export const MAX_HELD_TEXT = 16_000;
const encodeBatchIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const messageSize = (message: HeldParentMessage) =>
  message.text.length + message.senderTitle.length + message.senderThreadId.length + 64;

/** A running turn that can take a message mid-turn. */
export function hasSteerableTurn(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
): boolean {
  return projection.runs.some(
    (run) =>
      run.status === "running" &&
      run.activeAttemptId !== null &&
      projection.providerTurns.some(
        (turn) => turn.runAttemptId === run.activeAttemptId && turn.status === "running",
      ),
  );
}

/**
 * Whether `t3_thread_send` holds a message instead of waking its target at
 * once: an `auto` message from a subagent to its own parent while the parent
 * has no turn to steer it into. Any explicit mode still wakes the parent.
 */
export function shouldHoldForParent(input: {
  readonly mode: "auto" | "queue" | "steer" | "restart" | undefined;
  readonly caller: Pick<OrchestrationV2ThreadProjection, "thread"> | undefined;
  readonly target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "providerTurns">;
}): boolean {
  if ((input.mode ?? "auto") !== "auto" || input.caller === undefined) return false;
  const lineage = input.caller.thread.lineage;
  return (
    lineage.relationshipToParent === "subagent" &&
    lineage.parentEnvironmentId === undefined &&
    lineage.parentThreadId === input.target.thread.id &&
    !hasSteerableTurn(input.target)
  );
}

/** Adds a message, ignoring a retry of one already held and dropping the oldest past the cap. */
export function addHeldMessage(
  held: ReadonlyArray<HeldParentMessage>,
  message: HeldParentMessage,
): ReadonlyArray<HeldParentMessage> {
  if (held.some((candidate) => candidate.messageId === message.messageId)) return held;
  const omitted = `[Earlier text omitted; read thread ${message.senderThreadId}.]\n`;
  const text =
    message.text.length > MAX_HELD_TEXT / 2
      ? omitted + message.text.slice(-(MAX_HELD_TEXT / 2 - omitted.length))
      : message.text;
  const next = [
    ...held,
    { ...message, senderTitle: message.senderTitle.slice(0, 120), text },
  ].slice(-MAX_HELD_PER_PARENT);
  while (
    next.length > 1 &&
    next.reduce((size, item) => size + messageSize(item), 128) > MAX_HELD_TEXT
  ) {
    next.shift();
  }
  return next;
}

/** Everything held goes in as one message, so a wake takes one delivery rather than one per update. */
export const combineHeldMessages = Effect.fnUntraced(function* (
  parentThreadId: ThreadId,
  held: ReadonlyArray<HeldParentMessage>,
) {
  const first = held[0];
  if (first === undefined) return null;
  if (held.length === 1) {
    return {
      projectId: first.projectId,
      senderThreadId: first.senderThreadId,
      messageId: first.messageId,
      commandId: first.commandId,
      text: first.text,
    };
  }
  const senders = new Set(held.map((message) => message.senderThreadId));
  const crypto = yield* Crypto.Crypto;
  const key = Hex.encode(
    yield* crypto.digest(
      "SHA-256",
      new TextEncoder().encode(
        encodeBatchIds([parentThreadId, ...held.map((message) => message.messageId)]),
      ),
    ),
  );
  return {
    projectId: first.projectId,
    ...(senders.size === 1 ? { senderThreadId: first.senderThreadId } : {}),
    messageId: MessageId.make(`message:held-subagent-updates:${key}`),
    commandId: CommandId.make(`server:held-subagent-updates:${key}`),
    text: [
      `Your subagents sent ${held.length} updates while you were idle:`,
      ...held.map(
        (message) =>
          `From "${message.senderTitle}" (thread ${message.senderThreadId}):\n${message.text}`,
      ),
    ].join("\n\n"),
  };
});
