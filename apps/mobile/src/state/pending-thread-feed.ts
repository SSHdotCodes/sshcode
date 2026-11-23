import {
  createMessagePreservingFeedProjector,
  threadFeedSummary,
} from "../lib/threadFeedProjection";
import type { QueuedThreadRun } from "@t3tools/client-runtime/state/thread-workflows";
import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ThreadFeedEntry } from "../lib/threadActivity";
import type { QueuedThreadMessage } from "./thread-outbox-model";

export type PendingThreadFeedEntry = ThreadFeedEntry & {
  readonly pendingMessage?: QueuedThreadMessage;
  readonly acknowledged?: boolean;
  readonly serverQueued?: boolean;
};

/** Append the outbox after all presented activity, until the server echoes each message. */
export function appendPendingThreadMessages(
  presentedFeed: ReadonlyArray<ThreadFeedEntry>,
  feed: ReadonlyArray<ThreadFeedEntry>,
  queuedMessages: ReadonlyArray<QueuedThreadMessage>,
  serverQueue: ReadonlyArray<QueuedThreadRun> = [],
  threadId?: ThreadId,
): ReadonlyArray<PendingThreadFeedEntry> {
  if (queuedMessages.length === 0 && serverQueue.length === 0) return presentedFeed;
  return appendPendingMessages(
    presentedFeed,
    threadFeedSummary(feed).messageIds,
    queuedMessages,
    serverQueue,
    threadId,
  );
}

function appendPendingMessages(
  presentedFeed: ReadonlyArray<PendingThreadFeedEntry>,
  deliveredIds: ReadonlySet<string>,
  queuedMessages: ReadonlyArray<QueuedThreadMessage>,
  serverQueue: ReadonlyArray<QueuedThreadRun>,
  threadId: ThreadId | undefined,
): ReadonlyArray<PendingThreadFeedEntry> {
  const serverQueuedIds = new Set(serverQueue.map((message) => message.messageId));
  return [
    ...presentedFeed,
    ...serverQueue
      .filter((queued) => !deliveredIds.has(queued.messageId))
      .map((queued): PendingThreadFeedEntry => {
        const pending = queued.awaitingMessage
          ? queuedMessages.find((message) => message.messageId === queued.messageId)
          : undefined;
        const createdAt = DateTime.formatIso(queued.run.requestedAt);
        return {
          type: "message",
          id: queued.messageId,
          createdAt,
          serverQueued: true,
          ...(pending ? { pendingMessage: pending, acknowledged: true } : {}),
          message: {
            id: queued.messageId,
            role: "user",
            text: pending?.text ?? queued.text,
            attachments: queued.attachments,
            context: pending?.context ?? queued.context,
            createdAt,
            updatedAt: createdAt,
            runId: null,
            streaming: false,
            visibility: "local",
            sourceThreadId: threadId ?? queued.run.threadId,
          },
        };
      }),
    ...queuedMessages
      .filter(
        (message) =>
          !deliveredIds.has(message.messageId) && !serverQueuedIds.has(message.messageId),
      )
      .map((pendingMessage): PendingThreadFeedEntry => ({
        type: "message",
        id: pendingMessage.messageId,
        createdAt: pendingMessage.createdAt,
        pendingMessage,
        message: {
          id: pendingMessage.messageId,
          role: "user",
          text: pendingMessage.text,
          attachments: [],
          context: pendingMessage.context,
          createdAt: pendingMessage.createdAt,
          updatedAt: pendingMessage.createdAt,
          runId: null,
          streaming: false,
          visibility: "local",
          sourceThreadId: pendingMessage.threadId,
        },
      })),
  ];
}

const EMPTY_SERVER_QUEUE: ReadonlyArray<QueuedThreadRun> = [];
export function createPendingThreadMessagesProjector() {
  const project = createMessagePreservingFeedProjector(appendPendingMessages);
  return (
    ...[presented, feed, queued, serverQueue, threadId]: Parameters<
      typeof appendPendingThreadMessages
    >
  ) => {
    if (queued.length === 0 && !serverQueue?.length) return presented;
    return project(
      presented,
      threadFeedSummary(feed).messageIds,
      queued,
      serverQueue ?? EMPTY_SERVER_QUEUE,
      threadId,
    );
  };
}
