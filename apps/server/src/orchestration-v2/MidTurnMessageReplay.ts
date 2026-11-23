import type {
  ChatAttachment,
  OrchestrationV2ConversationMessage,
  OrchestrationMessageContext,
  OrchestrationV2Run,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagementService from "./ThreadManagementService.ts";

/** Marks a re-sent mid-turn message in a continuation prompt. */
const UNREAD_MESSAGE_LABEL = "Sent while you were working, possibly unread:";

type Run = Pick<
  OrchestrationV2Run,
  "id" | "restartContinuationOfRunId" | "providerRetryContinuationOfRunId"
>;

/**
 * Mid-turn messages (steers and question-card answers) that a cut or failed
 * run may never have shown the model. Providers hold a steer until their next
 * step and none confirms it reached the model, so a steer after the run's last
 * assistant output counts as unread. A continuation with no output may not have
 * delivered its own prompt, which re-sent its source's unread messages, so the
 * walk follows it back.
 */
export const unreadMidTurnMessages = Effect.fn("MidTurnMessageReplay.unreadMidTurnMessages")(
  function* (
    threads: Pick<ThreadManagementService.ThreadManagementService["Service"], "getThreadRecords">,
    threadId: ThreadId,
    source: Run,
  ) {
    const unreadIds: Array<OrchestrationV2ConversationMessage["id"]> = [];
    const visited = new Set<RunId>();
    let run: Run | undefined = source;
    while (run !== undefined && !visited.has(run.id)) {
      const runId: RunId = run.id;
      visited.add(runId);
      const { turnItems } = yield* threads.getThreadRecords(threadId, ["turnItems"], {
        turnItemRunIds: [runId],
        turnItemTypes: ["user_message", "assistant_message"],
      });
      const items = turnItems.filter((item) => item.runId === runId);
      const lastOutput = Math.max(
        -Infinity,
        ...items.filter((item) => item.type === "assistant_message").map((item) => item.ordinal),
      );
      unreadIds.unshift(
        ...items
          .filter((item) => item.ordinal > lastOutput)
          .sort((left, right) => left.ordinal - right.ordinal)
          .flatMap((item) =>
            item.type === "user_message" &&
            (item.inputIntent === "steer" || item.inputIntent === "promoted_queued_to_steer")
              ? [item.messageId]
              : [],
          ),
      );
      // Output in this run proves the model read the prompt that started it.
      if (lastOutput !== -Infinity) break;
      const previousId: RunId | undefined =
        run.restartContinuationOfRunId ?? run.providerRetryContinuationOfRunId;
      if (previousId === undefined) break;
      const previous: { readonly runs: ReadonlyArray<OrchestrationV2Run> } =
        yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [previousId] });
      run = previous.runs.find((candidate) => candidate.id === previousId);
    }
    if (unreadIds.length === 0) return [];
    const { messages } = yield* threads.getThreadRecords(threadId, ["messages"], {
      messageIds: unreadIds,
    });
    return unreadIds.flatMap((id) => messages.filter((message) => message.id === id));
  },
);

/**
 * A continuation prompt that re-sends `unread` ahead of `prompt`. Their
 * attachments and context come along; the turn start projects the context.
 */
export function withUnreadMessages(
  prompt: string,
  unread: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "text" | "context" | "attachments">
  >,
): {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext;
} {
  const attachments: Array<ChatAttachment> = [];
  for (const attachment of unread.flatMap((message) => message.attachments)) {
    if (!attachments.some((existing) => existing.id === attachment.id))
      attachments.push(attachment);
  }
  const records: Array<OrchestrationMessageContext["records"][number]> = [];
  for (const record of unread.flatMap((message) => message.context?.records ?? [])) {
    if (!records.some((existing) => existing.contextId === record.contextId)) records.push(record);
  }
  return {
    text: [...unread.map((message) => `${UNREAD_MESSAGE_LABEL}\n${message.text}`), prompt].join(
      "\n\n",
    ),
    attachments,
    ...(records.length === 0 ? {} : { context: { version: 1, records } }),
  };
}
