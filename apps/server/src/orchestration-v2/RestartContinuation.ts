import { latestExecutedRun, runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  type ChatAttachment,
  CommandId,
  latestProviderTurnForAttempt,
  type OrchestrationMessageContext,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type { AccountMoveRequest } from "./EffectOutbox.ts";
import type { ProjectionRuntimeRecoveryState } from "./ProjectionStore.ts";

import * as ServerSettings from "../serverSettings.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  continuesAccountMove,
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  isAwaitedWork,
  isRestartContinuationSource,
  withDriverShellWake,
  isRestartNoteSource,
  neverReachedProvider,
  RESTART_CONTINUE_PROMPT,
  RESTART_LOST_REQUEST_NOTE,
  restartCancelledBackgroundWorkNote,
  restartContinuationNote,
  restartContinuationMessageId,
  restartStartsOver,
} from "./RestartBackgroundNote.ts";
import { unreadMidTurnMessages, withUnreadMessages } from "./MidTurnMessageReplay.ts";
import { WORKSPACE_PREPARATION_INPUT } from "./workspacePreparation.ts";

/** A move the user already requested is deliverable even when automatic recovery is off. */
export function undeliveredAccountMove(
  run: OrchestrationV2Run,
  projection: Pick<ProjectionRuntimeRecoveryState, "runs" | "attempts" | "providerTurns">,
) {
  return (
    neverReachedProvider(run, projection.attempts, projection.providerTurns) &&
    continuesAccountMove(run, projection.runs, projection.attempts, projection.providerTurns)
  );
}

/** Consecutive automatic continuations allowed before a person has to step in. */
const MAX_CONTINUATION_CHAIN = 3;

/**
 * Whether a restart must leave this run for the user: the thread is put away
 * or the provider turn already ended. Checked when intent is recorded and
 * again when the continuation is delivered. A `settled` run is woken for the
 * awaited work it lost, so its ended provider turn does not block it. A
 * question or approval the restart closed does not block either: the
 * continuation tells the agent to ask again (`restartClosedRequest`).
 */
function restartContinuationBlocked(
  projection: Pick<ProjectionRuntimeRecoveryState, "thread" | "providerTurns" | "turnItems">,
  source: OrchestrationV2Run,
  now: DateTime.Utc,
  settled: boolean,
): boolean {
  const { thread } = projection;
  if (
    thread.archivedAt !== null ||
    thread.deletedAt !== null ||
    thread.settledOverride === "settled" ||
    (thread.snoozedUntil != null && DateTime.isGreaterThan(thread.snoozedUntil, now))
  )
    return true;
  const turn = latestProviderTurnForAttempt(projection.providerTurns, source.activeAttemptId);
  return (
    !settled &&
    turn !== undefined &&
    (turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted")
  );
}

/**
 * Whether the restart closed a question or approval the cut turn was waiting
 * on. Recovery ends live callbacks without answering them; a message-capable
 * question stays answerable and is not counted.
 */
function restartClosedRequest(
  projection: Pick<ProjectionRuntimeRecoveryState, "runtimeRequests" | "providerTurns">,
  source: OrchestrationV2Run,
): boolean {
  const turn = latestProviderTurnForAttempt(projection.providerTurns, source.activeAttemptId);
  return (
    turn !== undefined &&
    projection.runtimeRequests.some(
      (request) =>
        // Tool calls and auth refreshes do not wait on a person.
        request.kind !== "dynamic_tool_call" &&
        request.kind !== "auth_refresh" &&
        request.providerTurnId === turn.id &&
        (request.status === "expired" || request.status === "cancelled") &&
        request.responseCapability.type === "not_resumable",
    )
  );
}

/**
 * Open awaited work (see `isAwaitedWork`) on a provider thread. App-owned
 * delegations are not counted: their own threads continue and report back.
 */
function hasOpenAwaitedWork(
  projection: Pick<ProjectionRuntimeRecoveryState, "runs" | "turnItems">,
  providerThread: ProjectionRuntimeRecoveryState["providerThreads"][number],
): boolean {
  const openItem = projection.turnItems.some((item) => {
    if (item.status !== "pending" && item.status !== "running" && item.status !== "waiting")
      return false;
    if (item.type === "subagent" && item.origin === "app_owned" && item.childThreadId !== null)
      return false;
    const work = cancelledTurnItemWork(item);
    const providerThreadId =
      item.providerThreadId ??
      projection.runs.find((run) => run.id === item.runId)?.providerThreadId;
    return (
      work !== undefined &&
      isAwaitedWork(withDriverShellWake(work, providerThread.driver)) &&
      providerThreadId === providerThread.id
    );
  });
  return (
    openItem ||
    (providerThread.ownerNodeId === null &&
      (providerThread.pendingBackgroundTasks ?? []).some((task) =>
        isAwaitedWork(withDriverShellWake(cancelledRosterTaskWork(task), providerThread.driver)),
      ))
  );
}

/**
 * The run a restart continues: an unfinished root turn, a run cut before it
 * reached its provider (it starts over), or a settled one waiting on awaited
 * work that the restart cancels. A settled run needs a live session, so stale
 * records from an older crash never wake it. Other leftover work is cleaned up
 * and reported on the next user turn.
 */
export function restartContinuationRun(
  projection: Pick<
    ProjectionRuntimeRecoveryState,
    | "thread"
    | "runs"
    | "providerThreads"
    | "providerSessions"
    | "providerTurns"
    | "runtimeRequests"
    | "turnItems"
    | "attempts"
  >,
  now: DateTime.Utc,
): OrchestrationV2Run | undefined {
  const run = latestExecutedRun(projection.runs);
  if (!run) return;
  // Nothing reached the provider, so no native state is needed to start over.
  if (
    (run.status === "preparing" || run.status === "starting" || run.status === "running") &&
    neverReachedProvider(run, projection.attempts, projection.providerTurns)
  )
    return restartContinuationBlocked(projection, run, now, false) ||
      projection.thread.providerInstanceId !== run.providerInstanceId
      ? undefined
      : run;
  const preparedContinuation =
    run.status === "starting" && run.restartContinuationOfRunId !== undefined;
  const settled = run.status === "completed" || run.status === "waiting";
  if (run.status !== "running" && !preparedContinuation && !settled) return;
  if (restartContinuationBlocked(projection, run, now, settled)) return;
  const liveTurnRequired = !preparedContinuation && !settled;
  if (projection.thread.providerInstanceId !== run.providerInstanceId) return;
  const providerThread = projection.providerThreads.find(
    (thread) => thread.id === run.providerThreadId,
  );
  if (
    !providerThread ||
    providerThread.appThreadId !== projection.thread.id ||
    providerThread.ownerNodeId !== null ||
    providerThread.providerInstanceId !== run.providerInstanceId ||
    providerThread.nativeThreadRef?.nativeId == null ||
    providerThread.nativeThreadRef.strength !== "strong" ||
    providerThread.nativeThreadRef.driver !== providerThread.driver ||
    (liveTurnRequired && providerThread.status !== "active") ||
    providerThread.status === "closed" ||
    providerThread.status === "archived"
  )
    return;
  const session = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread.providerSessionId,
  );
  // Most adapters keep a live session "ready" through its turns, so only a
  // stopped or failed session rules out a live turn.
  if (
    session === undefined ||
    session.providerInstanceId !== run.providerInstanceId ||
    session.driver !== providerThread.driver ||
    (!preparedContinuation && (session.status === "stopped" || session.status === "error"))
  )
    return;
  if (settled) return hasOpenAwaitedWork(projection, providerThread) ? run : undefined;
  if (
    liveTurnRequired &&
    !projection.providerTurns.some(
      (turn) =>
        turn.providerThreadId === providerThread.id &&
        turn.runAttemptId === run.activeAttemptId &&
        turn.status === "running",
    )
  )
    return;
  return run;
}

/**
 * Dispatches the restart continuation of `sourceRunId`. Returns the
 * continuation's run when it may still need its workspace prepared.
 */
export const continueRestartedRun = Effect.fn("RestartContinuation.continueRestartedRun")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly sourceRunId: RunId;
    readonly accountMove?: AccountMoveRequest | undefined;
  }) {
    const settings = yield* ServerSettings.ServerSettingsService;
    const currentSettings = yield* settings.getSettings;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const messageId = restartContinuationMessageId(input.sourceRunId);
    const projection = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "runs", "providerTurns", "attempts", "runtimeRequests", "turnItems"],
      { messageIds: [messageId], unorderedMessages: true, turnItemTypes: ["secret_request"] },
    );
    const source = projection.runs.find((run) => run.id === input.sourceRunId);
    if (
      input.accountMove === undefined &&
      !(source && undeliveredAccountMove(source, projection)) &&
      !resolveProjectSettings(currentSettings, projection.thread.projectId).settings
        .continueThreadsAfterServerUpdate
    )
      return;
    const delivered = projection.messages.find((message) => message.id === messageId);
    // Already dispatched: its run may still need the preparation a crash cut.
    if (delivered !== undefined) return delivered.runId ?? undefined;
    // Reconciliation cancels a waiting run it cannot checkpoint, so a settled
    // source can be cancelled too. It continues only for awaited work.
    if (
      !source ||
      (input.accountMove !== undefined
        ? source.status !== "interrupted" && source.status !== "cancelled"
        : !isRestartContinuationSource(source, projection.providerTurns) ||
          restartContinuationBlocked(
            projection,
            source,
            yield* DateTime.now,
            isRestartNoteSource(source, projection.providerTurns),
          ))
    )
      return;
    // A newer turn takes precedence. Cancelling an unstarted queue entry does not.
    const latest = latestExecutedRun(projection.runs);
    if (latest !== null && latest.id !== source.id && runRanAfter(latest, source)) return;
    if (
      input.accountMove === undefined &&
      projection.thread.providerInstanceId !== source.providerInstanceId
    )
      return;
    // A turn that keeps crashing the server would otherwise restart it forever.
    let chainLength = 0;
    // A user-requested account move starts a new consecutive-restart chain.
    let run: OrchestrationV2Run | undefined = source;
    while (
      input.accountMove === undefined &&
      run?.restartContinuationOfRunId !== undefined &&
      chainLength < MAX_CONTINUATION_CHAIN
    ) {
      const previous: OrchestrationV2Run | undefined = projection.runs.find(
        (candidate) => candidate.id === run?.restartContinuationOfRunId,
      );
      if (
        run.accountMoveContinuation ||
        (previous && previous.providerInstanceId !== run.providerInstanceId)
      )
        break;
      chainLength += 1;
      run = previous;
    }
    if (chainLength >= MAX_CONTINUATION_CHAIN) {
      yield* Effect.logWarning("Not continuing a run restarted too many times in a row", {
        threadId: input.threadId,
        sourceRunId: input.sourceRunId,
      });
      return;
    }
    const sourceRecords = yield* threads.getThreadRecords(
      input.threadId,
      ["messages", "turnItems"],
      {
        messageIds: [source.userMessageId],
        turnItemRunIds: [source.id],
        turnItemTypes: ["run_interrupt_request"],
      },
    );
    // The user asked this run to stop before the restart cut it.
    if (
      sourceRecords.turnItems.some(
        (item) =>
          item.runId === source.id && item.type === "run_interrupt_request" && !item.forAccountMove,
      )
    )
      return;
    const sourceMessage = sourceRecords.messages.find(
      (message) => message.id === source.userMessageId,
    );
    if (
      input.accountMove === undefined &&
      sourceMessage !== undefined &&
      isNativeMaintenanceCommand(sourceMessage)
    )
      return;
    const startsOver = restartStartsOver(
      source,
      projection.runs,
      projection.attempts,
      projection.providerTurns,
    );
    let continuation: {
      readonly text: string;
      readonly context?: OrchestrationMessageContext | undefined;
      readonly attachments: ReadonlyArray<ChatAttachment>;
      readonly summary: string;
      readonly prepare: boolean;
    };
    if (startsOver) {
      // Nothing reached the provider: send the original message again, after
      // the workspace preparation the restart cut, if any.
      if (sourceMessage === undefined) return;
      const { turnItems } = yield* threads.getThreadRecords(input.threadId, ["turnItems"], {
        turnItemRunIds: [source.id],
        turnItemTypes: ["command_execution"],
      });
      const preparation = turnItems.find(
        (item) =>
          item.runId === source.id &&
          item.type === "command_execution" &&
          item.input === WORKSPACE_PREPARATION_INPUT,
      );
      continuation = {
        text: sourceMessage.text,
        context: sourceMessage.context,
        attachments: sourceMessage.attachments,
        summary: "SSHCode restarted and started this again",
        prepare:
          source.workspacePreparation !== undefined &&
          preparation !== undefined &&
          preparation.status !== "completed",
      };
    } else {
      const note = restartContinuationNote(
        source,
        projection.runs,
        projection.providerTurns,
        projection.attempts,
      );
      const noteText =
        note.work.length === 0
          ? undefined
          : restartCancelledBackgroundWorkNote(note.work, input.accountMove !== undefined);
      const settled = input.accountMove?.settled ?? note.settled;
      const notes = [
        ...(noteText === undefined ? [] : [noteText]),
        ...(restartClosedRequest(projection, source) ? [RESTART_LOST_REQUEST_NOTE] : []),
      ];
      const prompt =
        notes.length === 0
          ? RESTART_CONTINUE_PROMPT
          : [...notes, ...(settled ? [] : [RESTART_CONTINUE_PROMPT])].join("\n\n");
      // A settled turn already took its messages; a cut one may not have read them.
      const unread = settled ? [] : yield* unreadMidTurnMessages(threads, input.threadId, source);
      continuation = {
        ...withUnreadMessages(prompt, unread),
        summary: settled
          ? "SSHCode restarted and stopped background work"
          : "SSHCode restarted and resumed this turn",
        prepare: false,
      };
    }
    const dispatched = yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:restart-continuation:${input.sourceRunId}`),
        threadId: input.threadId,
        messageId,
        text: continuation.text,
        ...(continuation.context === undefined ? {} : { context: continuation.context }),
        // Shown as a work log row; the prompt the agent got is its detail.
        notification: {
          source: { kind: "system" },
          outcome: "updated",
          summary:
            input.accountMove === undefined
              ? continuation.summary
              : `Continued on ${input.accountMove.accountName}`,
          detail: continuation.text,
        },
        attachments: continuation.attachments,
        ...(input.accountMove ? {} : { modelSelection: source.modelSelection }),
        dispatchMode:
          continuation.prepare && source.workspacePreparation !== undefined
            ? { type: "defer_start", workspaceStrategy: source.workspacePreparation }
            : { type: "start_immediately" },
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: input.sourceRunId,
      })
      .pipe(
        // The project turned this instance off since the restart. No turn
        // resumes, and the success path below still runs so a delegated
        // child waiting on this run is recovered immediately instead of
        // after EffectWorker exhausts its retries on a refusal that will
        // not change.
        Effect.catchTags({
          ThreadManagementProviderInstanceDisabledError: (error) =>
            Effect.logInfo("orchestration-v2.restart-continuation.instance-disabled", {
              threadId: input.threadId,
              sourceRunId: input.sourceRunId,
              projectId: error.projectId,
              instanceId: error.instanceId,
            }).pipe(Effect.as(undefined)),
        }),
      );
    if (!continuation.prepare) return;
    const created = dispatched?.storedEvents.find((stored) => stored.event.type === "run.created");
    return created?.event.type === "run.created" ? created.event.payload.id : undefined;
  },
  // A delegated child this declined to continue still owes its parent a
  // result. Once a continuation run exists this is a no-op; that run settles it.
  (effect, input) =>
    effect.pipe(
      Effect.tap(
        Effect.gen(function* () {
          const threads = yield* ThreadManagementService.ThreadManagementService;
          yield* threads.recoverDelegatedTask(input.threadId, input.sourceRunId);
        }),
      ),
    ),
);
