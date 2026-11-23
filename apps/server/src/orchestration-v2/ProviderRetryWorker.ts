import { CommandId, MessageId, type OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { unreadMidTurnMessages, withUnreadMessages } from "./MidTurnMessageReplay.ts";

const RETRY_PROMPT =
  "Continue where you left off. The previous turn ended with a transient provider failure. Preserve completed work and resume unfinished work from the existing conversation.";

/** Retries a failed run, re-sending the mid-turn messages it may not have read. */
export function providerRetryCommand(
  run: OrchestrationV2Run,
  unread: Parameters<typeof withUnreadMessages>[1] = [],
) {
  const identity = `provider-retry:${run.id}:${run.automaticProviderRetry?.attempt}`;
  const { text, attachments, context } = withUnreadMessages(RETRY_PROMPT, unread);
  return {
    type: "message.dispatch" as const,
    commandId: CommandId.make(identity),
    messageId: MessageId.make(identity),
    threadId: run.threadId,
    providerRetryContinuationOfRunId: run.id,
    text,
    ...(context === undefined ? {} : { context }),
    notification: {
      source: { kind: "system" as const },
      outcome: "updated" as const,
      summary: "Automatically retrying the same model",
    },
    attachments,
    modelSelection: run.modelSelection,
    dispatchMode: { type: "start_immediately" as const },
    createdBy: "agent" as const,
    creationSource: "server" as const,
  };
}

export const sweep = Effect.fn("ProviderRetryWorker.sweep")(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const candidates = yield* projections.getProviderRetryCandidates(yield* DateTime.now);
  for (const run of candidates) {
    yield* unreadMidTurnMessages(threads, run.threadId, run).pipe(
      Effect.flatMap((unread) => threads.dispatch(providerRetryCommand(run, unread))),
      Effect.catchTags({
        ThreadManagementProviderInstanceDisabledError: () =>
          threads.dispatch({
            type: "provider-retry.cancel",
            commandId: CommandId.make(`provider-retry-cancel:${run.id}`),
            threadId: run.threadId,
            runId: run.id,
          }),
      }),
      Effect.catchCause((cause) =>
        Effect.logWarning("Provider retry dispatch failed", {
          threadId: run.threadId,
          runId: run.id,
          cause,
        }),
      ),
    );
  }
});

// Due times and attempt counts are persisted with the terminal failure. The
// shared scheduler can recover them after restart without replaying a prompt.
export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("provider-retry", sweep());
  }),
);
