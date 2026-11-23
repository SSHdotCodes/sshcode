import { remapComposerContextAttachments } from "@t3tools/shared/composerContextReferences";
import { appendUserInputAttachmentPaths } from "../provider/userInputAttachments.ts";
import type { ChatAttachment, OrchestrationV2Command } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { resolveAttachmentOriginalPathById, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "./Orchestrator.ts";

import * as AttachmentClaims from "./AttachmentClaims.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

// These dispatcher failures occur in receipt validation or planning, before
// commitCommand. Generic dispatch errors can follow a commit and remain uncertain.
// A disabled-instance refusal comes from ThreadManagementService.dispatch's
// own enablement check, which also runs before any commit is attempted.
function dispatchWasNotAccepted(
  error: Orchestrator.OrchestratorV2Error | ThreadManagement.ThreadManagementError,
) {
  switch (error._tag) {
    case "OrchestratorCommandRejectedError":
    case "OrchestratorThreadAlreadyExistsError":
    case "OrchestratorProjectionError":
    case "OrchestratorProviderAdapterError":
    case "OrchestratorCommandPreviouslyRejectedError":
    case "OrchestratorCommandIdConflictError":
    case "OrchestratorSubagentThreadReadOnlyError":
    case "OrchestratorThreadAboveModeLimitError":
    case "TerminalHandoffError":
    case "ThreadManagementProviderInstanceDisabledError":
      return true;
    default:
      return false;
  }
}
const isAttachmentClaimError = Schema.is(AttachmentClaims.AttachmentClaimError);
const isOrchestratorError = Schema.is(Orchestrator.OrchestratorV2Error);
const isThreadManagementError = Schema.is(ThreadManagement.ThreadManagementError);
/** True only when a retry cannot race an already-committed command. */
export const commandWasNotAccepted = (error: unknown) =>
  isAttachmentClaimError(error) ||
  ((isOrchestratorError(error) || isThreadManagementError(error)) && dispatchWasNotAccepted(error));

/** A projection read or preparation failure can follow acceptance of the initial message. */
export const launchMessageWasNotAccepted = (error: ThreadLaunch.ThreadLaunchError) =>
  error.notAccepted === true ||
  ((error.operation === "dispatch-message" ||
    error.operation === "create-thread" ||
    error.operation === "update-thread") &&
    (isOrchestratorError(error.cause) || isThreadManagementError(error.cause)) &&
    error.cause._tag !== "OrchestratorProjectionError" &&
    dispatchWasNotAccepted(error.cause));

const releaseUnusedClaims = Effect.fn("ThreadMessageIntake.releaseUnusedClaims")(function* (
  claimedPaths: ReadonlyArray<string>,
  accepted: ReadonlyArray<ChatAttachment>,
) {
  if (claimedPaths.length === 0) return;
  const config = yield* ServerConfig.ServerConfig;
  const retained = new Set(
    accepted.flatMap((attachment) => [
      resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      }),
      ...(attachment.type === "image" && "original" in attachment && attachment.original
        ? [
            resolveAttachmentOriginalPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId: attachment.id,
            }),
          ]
        : []),
    ]),
  );
  yield* AttachmentClaims.releaseClaimedAttachments(
    claimedPaths.filter((path) => !retained.has(path)),
  );
});

export const dispatchCommand = Effect.fn("ThreadMessageIntake.dispatchCommand")(function* (
  command: OrchestrationV2Command,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  if (command.type === "runtime-request.respond" && command.attachmentsByQuestionId) {
    const config = yield* ServerConfig.ServerConfig;
    const incomingByQuestionId = command.attachmentsByQuestionId;
    yield* AttachmentClaims.validateAttachmentLimits(Object.values(incomingByQuestionId).flat());
    // Claims accumulate across questions, so all of preparation shares one
    // rollback boundary: any failure before dispatch removes every new copy.
    const claimedPaths: string[] = [];
    const prepared = yield* Effect.gen(function* () {
      const attachmentsByQuestionId: import("@t3tools/contracts").UserInputAttachments = {};
      for (const [questionId, attachments] of Object.entries(incomingByQuestionId)) {
        const claimed = yield* AttachmentClaims.claimPendingAttachments({
          threadId: command.threadId,
          attachments,
        });
        claimedPaths.push(...claimed.claimedPaths);
        Object.defineProperty(attachmentsByQuestionId, questionId, {
          value: claimed.attachments,
          enumerable: true,
        });
      }
      const answers = yield* appendUserInputAttachmentPaths({
        answers: command.answers ?? {},
        attachmentsByQuestionId,
        attachmentsDir: config.attachmentsDir,
      }).pipe(
        Effect.mapError(
          (cause) => new AttachmentClaims.AttachmentClaimError({ message: cause.issue }),
        ),
      );
      return { answers, attachmentsByQuestionId };
    }).pipe(Effect.onError(() => AttachmentClaims.releaseClaimedAttachments(claimedPaths)));
    return yield* threads
      .dispatch({
        ...command,
        answers: prepared.answers,
        attachmentsByQuestionId: prepared.attachmentsByQuestionId,
      })
      .pipe(
        Effect.tap((result) => {
          // A replayed receipt reports the first attempt's answer, so this
          // attempt's copies go unreferenced and are released. The resolved
          // turn item proves the respond was applied; questionAnswer is only
          // recorded when the accepted command carried attachments, so its
          // absence means the accepted answer referenced no copies. With no
          // resolved item at all the outcome is ambiguous and everything stays.
          const answeredItems = result.storedEvents.flatMap(({ event }) =>
            event.type === "turn-item.updated" &&
            event.payload.type === "user_input_request" &&
            event.payload.requestId === command.requestId
              ? [event.payload]
              : [],
          );
          return answeredItems.length > 0
            ? releaseUnusedClaims(
                claimedPaths,
                answeredItems.flatMap((item) =>
                  item.questionAnswer === undefined
                    ? []
                    : Object.values(item.questionAnswer.attachmentsByQuestionId).flat(),
                ),
              )
            : Effect.void;
        }),
        Effect.tapError((error) =>
          dispatchWasNotAccepted(error)
            ? AttachmentClaims.releaseClaimedAttachments(claimedPaths)
            : Effect.void,
        ),
      );
  }
  if (
    command.type !== "message.dispatch" &&
    (command.type !== "queued-run.edit" || command.attachments === undefined)
  )
    return yield* threads.dispatch(command);
  const claimAndDispatch = Effect.gen(function* () {
    const claimed = yield* AttachmentClaims.claimPendingAttachments({
      threadId: command.threadId,
      attachments: command.attachments ?? [],
    });
    return yield* threads
      .dispatch({
        ...command,
        attachments: claimed.attachments,
        ...(command.context
          ? {
              context: remapComposerContextAttachments(
                command.context,
                command.attachments ?? [],
                claimed.attachments,
              ),
            }
          : {}),
      })
      .pipe(
        Effect.tap((result) =>
          releaseUnusedClaims(
            claimed.claimedPaths,
            result.storedEvents.flatMap(({ event }) =>
              event.type === "message.updated" ? event.payload.attachments : [],
            ),
          ),
        ),
        Effect.tapError((error) =>
          dispatchWasNotAccepted(error)
            ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
            : Effect.void,
        ),
      );
  });
  return command.type === "message.dispatch" && command.attachments.length > 0
    ? yield* threads.withIntakeReceipt(command, (accepted) =>
        accepted ? threads.dispatch(command) : claimAndDispatch,
      )
    : yield* claimAndDispatch;
});

export const sendToThread = Effect.fn("ThreadMessageIntake.sendToThread")(function* (
  input: ThreadManagement.ThreadManagementSendInput,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const claimed = yield* AttachmentClaims.claimPendingAttachments(input);
  return yield* threads.sendToThread({ ...input, attachments: claimed.attachments }).pipe(
    Effect.tap((result) => releaseUnusedClaims(claimed.claimedPaths, result.message.attachments)),
    Effect.tapError((error) =>
      dispatchWasNotAccepted(error)
        ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
        : Effect.void,
    ),
  );
});

const claimAndLaunch = Effect.fn("ThreadMessageIntake.claimAndLaunch")(function* (
  input: ThreadLaunch.ThreadLaunchInput,
) {
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  yield* AttachmentClaims.validateAttachmentLimits(input.initialMessage?.attachments ?? []);
  if (!input.initialMessage?.attachments.some(AttachmentClaims.attachmentIsPendingUpload)) {
    return yield* launches.launch(input);
  }
  if (input.threadId === undefined) {
    return yield* new AttachmentClaims.AttachmentClaimError({
      message: "Uploaded attachments need a thread id at launch.",
    });
  }
  const claimed = yield* AttachmentClaims.claimPendingAttachments({
    threadId: input.threadId,
    attachments: input.initialMessage.attachments,
  });
  return yield* launches
    .launch({
      ...input,
      initialMessage: {
        ...input.initialMessage,
        attachments: claimed.attachments,
        ...(input.initialMessage.context
          ? {
              context: remapComposerContextAttachments(
                input.initialMessage.context,
                input.initialMessage.attachments,
                claimed.attachments,
              ),
            }
          : {}),
      },
    })
    .pipe(
      Effect.tap((result) =>
        releaseUnusedClaims(
          claimed.claimedPaths,
          result.projection.messages.flatMap((message) => message.attachments),
        ),
      ),
      Effect.tapError((error) => {
        if (error._tag === "ThreadManagementProviderInstanceDisabledError") {
          return AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths);
        }
        // Project/receipt reads precede message dispatch. The create-thread error
        // also wraps post-message projection reads, so its tag alone is not proof.
        // The initial message's own dispatch can still find the instance newly
        // disabled, which wraps the same tag handled above instead of surfacing
        // it directly, so the guard below also recognizes it.
        const notAccepted =
          error.operation === "resolve-project" ||
          error.operation === "read-receipt" ||
          launchMessageWasNotAccepted(error);
        return notAccepted
          ? AttachmentClaims.releaseClaimedAttachments(claimed.claimedPaths)
          : Effect.void;
      }),
    );
});

export const launchThread = Effect.fn("ThreadMessageIntake.launchThread")(function* (
  input: ThreadLaunch.ThreadLaunchInput,
) {
  if (input.threadId === undefined || !input.initialMessage?.attachments.length)
    return yield* claimAndLaunch(input);
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  return yield* threads
    .withIntakeReceipt(
      {
        commandId: input.commandId,
        threadId: input.threadId,
        type: input.reuseExistingThread ? "thread.metadata.update" : "thread.create",
      },
      (accepted) => (accepted ? launches.launch(input) : claimAndLaunch(input)),
      input.initialMessage ? ThreadLaunch.initialMessageCommandId(input.commandId) : undefined,
    )
    .pipe(
      Effect.catchTags({
        OrchestratorDispatchError: (cause) =>
          new ThreadLaunch.ThreadLaunchError({
            operation: "read-receipt",
            commandId: input.commandId,
            projectId: input.projectId,
            cause,
          }),
      }),
    );
});
