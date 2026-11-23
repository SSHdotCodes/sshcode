import { modelSelectionsEqual } from "@t3tools/shared/model";
import { projectComposerContextForProvider } from "@t3tools/shared/composerContextReferences";
import { SUBAGENTS_OFF_USER_LINE, SUBAGENTS_ON_USER_LINE } from "@t3tools/shared/chatControls";
import {
  CommandId,
  TerminalHandoffError,
  latestProviderTurnForAttempt,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import { withWorkspaceLease } from "../workspace/workspaceLease.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as EventSink from "./EventSink.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  handoffTokenCapConfig,
  handoffBudget,
  attachmentTokenAllowance,
  contextUsageForHandoff,
  historicalMessage,
  latestNativeContextUsage,
  renderHandoffWorkspace,
  scaledHandoffTokenCap,
} from "@t3tools/provider-core/server/handoffBudget";
import * as HandoffBriefService from "./HandoffBriefService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { deliverContextHandoffs } from "./ContextHandoffDelivery.ts";
import { nativeContextState } from "./nativeContextState.ts";
import { delegatedCompletionWakeDetail, resultsForNextTurn } from "./NotificationMailbox.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import { workspaceSetupNotice } from "./workspacePreparation.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ChatControls from "../sessionBoxes/chatControls.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import {
  knownProviderFailureMessage,
  makeProviderFailure,
  providerFailureRootCause,
} from "@t3tools/provider-core/server/failure";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as TerminalHandoffState from "./TerminalHandoffState.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import {
  continuesAccountMove,
  isRestartNoteContinuation,
  pendingRestartCancelledBackgroundWork,
  RESTART_CONTINUE_PROMPT,
  restartCancelledBackgroundWorkNote,
} from "./RestartBackgroundNote.ts";

const isTerminalHandoffError = Schema.is(TerminalHandoffError);

export class ProviderTurnStartError extends Schema.TaggedError<ProviderTurnStartError>()(
  "ProviderTurnStartError",
  {
    runId: RunId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return isTerminalHandoffError(this.cause)
      ? this.cause.message
      : "Provider turn failed to start.";
  }
}

const isProviderTurnStartError = Schema.is(ProviderTurnStartError);

/**
 * First-turn line for a subagent the user started themselves. The lead wrote no brief for
 * it, so its only route to background is the lead's chat. Provider input only: the chat
 * shows the task as the user typed it.
 */
export function userStartedSubagentNotice(
  thread: Pick<
    OrchestrationV2ThreadProjection["thread"],
    "lineage" | "createdBy" | "creationSource"
  >,
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "startedAt">>,
  run: Pick<OrchestrationV2Run, "id" | "ordinal">,
): string | undefined {
  // Records written before lineage existed carry none; they are ordinary chats.
  const lineage = thread.lineage as
    | OrchestrationV2ThreadProjection["thread"]["lineage"]
    | undefined;
  if (
    lineage?.relationshipToParent !== "subagent" ||
    lineage.parentThreadId === null ||
    thread.createdBy !== "user" ||
    thread.creationSource === "provider" ||
    // Once only: a restart may continue a first run that never reached the provider.
    runs.some(
      (other) => other.id !== run.id && other.ordinal < run.ordinal && other.startedAt !== null,
    )
  ) {
    return undefined;
  }
  return `The user started this task from chat ${lineage.parentThreadId}. Read that chat with t3_thread_read when you need background.`;
}

/** Claude refuses to replace a process running background work before it reads the prompt. */
const refusedBeforePrompt = (error: unknown): boolean =>
  Predicate.isTagged(error, "ClaudeBackgroundWorkBlocksQueryReplacementError") ||
  (Predicate.hasProperty(error, "cause") && refusedBeforePrompt(error.cause));

export interface ProviderTurnStartServiceV2Shape {
  /**
   * Starts the run's provider turn. When `willRetry` is true, a session open
   * failure is returned so the caller can retry. Otherwise the run is settled
   * as failed.
   */
  readonly start: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly willRetry?: boolean;
  }) => Effect.Effect<void, ProviderTurnStartError>;
}

export class ProviderTurnStartServiceV2 extends Context.Service<
  ProviderTurnStartServiceV2,
  ProviderTurnStartServiceV2Shape
>()("t3/orchestration-v2/ProviderTurnStartService/ProviderTurnStartServiceV2") {}

// How long a send waits for the outgoing model's brief before handing off without it.
const HANDOFF_BRIEF_WAIT_MS = 30_000;
const HANDOFF_GIT_STATUS_TIMEOUT = Duration.seconds(3);

const isProviderAdapterOpenSessionError = Schema.is(
  ProviderAdapter.ProviderAdapterOpenSessionError,
);

export const layer: Layer.Layer<
  ProviderTurnStartServiceV2,
  never,
  | EventSink.EventSinkV2
  | ContextHandoffService.ContextHandoffServiceV2
  | IdAllocator.IdAllocatorV2
  | FileSystem.FileSystem
  | Path.Path
  | GitWorkflowService.GitWorkflowService
  | ProjectService.ProjectService
  | ProviderAuthService.ProviderAuthService
  | ProjectionStore.ProjectionStoreV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | RunExecutionService.RunExecutionServiceV2
  | RuntimePolicy.RuntimePolicyV2
> = Layer.effect(
  ProviderTurnStartServiceV2,
  Effect.gen(function* () {
    const chatControls = Option.getOrElse(
      yield* Effect.serviceOption(ChatControls.ChatControls),
      () => ChatControls.make().store,
    );

    const terminal = yield* Effect.serviceOption(TerminalHandoffState.TerminalHandoffState);
    const eventSink = yield* EventSink.EventSinkV2;
    const contextHandoffService = yield* ContextHandoffService.ContextHandoffServiceV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
    const projects = yield* ProjectService.ProjectService;
    const providerAuth = yield* ProviderAuthService.ProviderAuthService;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
    const runExecution = yield* RunExecutionService.RunExecutionServiceV2;
    const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
    // Both only enrich a handoff; runtimes without them deliver it plain.
    const handoffBriefs = yield* Effect.serviceOption(HandoffBriefService.HandoffBriefService);
    const git = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);

    // These callbacks outlive startup while a run drains background work. Build
    // them outside start's scope so they cannot retain its full thread history.
    const makeRunControls = (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly attemptId: OrchestrationV2RunAttempt["id"];
      readonly providerThreadId: OrchestrationV2ProviderThread["id"];
      readonly runOrdinal: number;
      readonly inheritedBackgroundTurnItems: ReturnType<
        typeof RunExecutionService.selectInheritedBackgroundTurnItems
      >;
    }) => {
      // Guards and background routing need live execution state, not a fresh
      // allocation of every completed message and tool output in the thread.
      // `false` means the run moved on or is gone. A failed read is an error,
      // so the caller fails the start or the run instead of skipping it.
      const isCurrentAttemptInStatus = (expectedStatus: OrchestrationV2Run["status"]) =>
        projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
          Effect.map((current) => {
            const run = current.runs.find((candidate) => candidate.id === input.runId);
            return run?.activeAttemptId === input.attemptId && run.status === expectedStatus;
          }),
        );
      return {
        isCurrentAttemptInStatus,
        loadInheritedBackgroundTurnItems: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) =>
              RunExecutionService.selectInheritedBackgroundTurnItems({
                threadId: input.threadId,
                currentProviderThreadId: input.providerThreadId,
                currentRunOrdinal: input.runOrdinal,
                runs: current.runs,
                turnItems: current.turnItems,
              }),
            ),
            Effect.catchCause(() => Effect.succeed(input.inheritedBackgroundTurnItems)),
          ),
        shouldStartProviderTurn: () => isCurrentAttemptInStatus("running"),
        shouldFinalizeRun: () =>
          projectionStore.getRuntimeRecoveryProjection(input.threadId).pipe(
            Effect.map((current) => {
              const run = current.runs.find((candidate) => candidate.id === input.runId);
              return (
                run?.activeAttemptId === input.attemptId &&
                (run.status === "starting" || run.status === "running")
              );
            }),
          ),
        hasUnpairedRunInterruptRequest: () =>
          projectionStore
            .hasUnpairedRunInterruptRequest(
              input.threadId,
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-request",
              }),
              idAllocator.derive.runSignalTurnItem({
                runId: input.runId,
                signal: "interrupt-result",
              }),
            )
            .pipe(Effect.catchCause(() => Effect.succeed(false))),
      };
    };

    const makeTerminalGuardedSession = (
      state: TerminalHandoffState.TerminalHandoffState["Service"],
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
    ): ProviderAdapter.ProviderAdapterV2SessionRuntime => {
      const start = (input: ProviderAdapter.ProviderAdapterV2TurnInput, compact = false) =>
        state
          .withStart(
            input.threadId,
            compact ? session.compactThread!(input) : session.startTurn(input),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: session.driver,
                  threadId: input.threadId,
                  providerThreadId: input.providerThread.id,
                  runId: input.runId,
                  cause,
                }),
            ),
          );
      return {
        ...session,
        startTurn: (input) => start(input),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
                start(input, true),
            }),
      };
    };

    const makeDeliverySession = (
      session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      startWithHandoffs: (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact?: boolean,
      ) => ReturnType<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>,
    ) => {
      let deliver: typeof startWithHandoffs | undefined = startWithHandoffs;
      const start = (
        input: Parameters<ProviderAdapter.ProviderAdapterV2SessionRuntime["startTurn"]>[0],
        compact = false,
      ) =>
        Effect.suspend(() => {
          if (deliver !== undefined) return deliver(input, compact);
          return compact && session.compactThread !== undefined
            ? session.compactThread(input)
            : session.startTurn(input);
        }).pipe(
          // Only startup needs the handoff history. The event worker keeps this
          // session alive afterward, including when background work remains.
          Effect.ensuring(
            Effect.sync(() => {
              deliver = undefined;
            }),
          ),
        );
      return {
        ...session,
        startTurn: (input: Parameters<typeof session.startTurn>[0]) => start(input),
        ...(session.compactThread === undefined
          ? {}
          : {
              compactThread: (input: Parameters<typeof session.startTurn>[0]) => start(input, true),
            }),
      };
    };

    const start = Effect.fn("orchestrationV2.providerTurnStart.start")(function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly willRetry?: boolean;
    }) {
      const { runId } = input;
      const projection = yield* projectionStore.getTurnStartContext(input.threadId, runId);
      const run = projection.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) {
        return yield* new ProviderTurnStartError({ runId, cause: `Run ${runId} was not found.` });
      }
      if (run.status !== "starting") {
        // The effect is idempotent once the run has advanced or terminalized.
        return;
      }
      // A brief written for another target ends, with the session it holds open, before
      // this turn opens one. A brief for this target is waited for until the deadline.
      if (Option.isSome(handoffBriefs))
        yield* handoffBriefs.value.settle({
          threadId: input.threadId,
          instanceId: run.providerInstanceId,
        });
      const briefDeadlineMs = (yield* Clock.currentTimeMillis) + HANDOFF_BRIEF_WAIT_MS;
      const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId);
      const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
      const providerThread = projection.providerThreads.find(
        (candidate) => candidate.id === run.providerThreadId,
      );
      const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
      const checkpointScope = projection.checkpointScopes.find(
        (candidate) => candidate.id === rootNode?.checkpointScopeId,
      );
      const handoffs = projection.contextHandoffs.filter(
        (handoff) =>
          handoff.status === "ready" &&
          (handoff.targetRunId === run.id ||
            (handoff.toProviderThreadId === run.providerThreadId &&
              projection.runs.some(
                (source) =>
                  source.id === handoff.targetRunId &&
                  (source.status === "failed" ||
                    source.status === "interrupted" ||
                    (source.status === "completed" &&
                      handoff.delivery === undefined &&
                      projection.messages.some(
                        (message) =>
                          message.id === source.userMessageId &&
                          message.attachments.length === 0 &&
                          message.text.trim().toLowerCase() === "/compact",
                      ))),
              ))),
      );
      const nativeForkTransfer = projection.contextTransfers.find(
        (transfer) =>
          transfer.type === "fork" &&
          transfer.targetThreadId === input.threadId &&
          transfer.targetRunId === run.id &&
          transfer.status === "pending" &&
          transfer.resolution === null,
      );
      if (
        rootNode === undefined ||
        attempt === undefined ||
        providerThread === undefined ||
        providerThread.providerSessionId === null ||
        message === undefined ||
        checkpointScope === undefined
      ) {
        return yield* new ProviderTurnStartError({
          runId,
          cause: `Run ${runId} is missing its execution projection state.`,
        });
      }
      const providerSessionId = providerThread.providerSessionId;
      // Settles a run that never reached the provider: one signal turn item plus
      // terminal run, attempt and root node, written only while the run is still
      // the current starting attempt.
      let settlementAttempted = false;
      const settleRunBeforeStart = Effect.fn("orchestrationV2.providerTurnStart.settleBeforeStart")(
        function* (input: {
          readonly signal: string;
          readonly status: "completed" | "failed";
          readonly now: DateTime.Utc;
          /** Omitted when the run never started, so `startedAt` stays as projected. */
          readonly startedAt?: DateTime.Utc;
          readonly providerInstanceId: OrchestrationV2Run["providerInstanceId"];
          readonly itemProviderThreadId: OrchestrationV2ProviderThread["id"];
          readonly item:
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "error" }>,
                "type" | "title" | "failure"
              >
            | Pick<
                Extract<OrchestrationV2TurnItem, { type: "command_execution" }>,
                "type" | "title" | "input" | "output" | "exitCode"
              >;
          /** Emitted after the run events when the provider thread should go idle. */
          readonly providerThreadUpdate?: OrchestrationV2ProviderThread;
        }) {
          settlementAttempted = true;
          const { now, status } = input;
          const started = input.startedAt === undefined ? {} : { startedAt: input.startedAt };
          const item: OrchestrationV2TurnItem = {
            id: idAllocator.derive.runSignalTurnItem({ runId, signal: input.signal }),
            threadId: projection.thread.id,
            runId,
            nodeId: rootNode.id,
            providerThreadId: input.itemProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal:
              Math.max(
                0,
                ...projection.turnItems
                  .filter((item) => item.runId === runId)
                  .map((item) => item.ordinal),
              ) + 1,
            status,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            ...input.item,
          };
          const eventPayloads = [
            { type: "turn-item.updated", payload: item },
            { type: "run.updated", payload: { ...run, status, ...started, completedAt: now } },
            {
              type: "run-attempt.updated",
              payload: { ...attempt, status, ...started, completedAt: now },
            },
            {
              type: "node.updated",
              payload: { ...rootNode, status, ...started, completedAt: now },
            },
            ...(input.providerThreadUpdate === undefined
              ? []
              : [
                  {
                    type: "provider-thread.updated" as const,
                    payload: input.providerThreadUpdate,
                  },
                ]),
          ] as const;
          const events = yield* Effect.forEach(eventPayloads, (event) =>
            Effect.gen(function* () {
              return {
                ...event,
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                threadId: projection.thread.id,
                runId,
                nodeId: rootNode.id,
                providerInstanceId: input.providerInstanceId,
                occurredAt: now,
              } satisfies OrchestrationV2DomainEvent;
            }),
          );
          yield* eventSink.writeIfRunCurrent({
            threadId: projection.thread.id,
            runId,
            activeAttemptId: attempt.id,
            expectedStatus: "starting",
            events,
          });
        },
      );
      return yield* Effect.gen(function* () {
        if (message.attachments.length === 0 && message.text.trimStart().startsWith("/")) {
          const isEmptyCompaction =
            message.text.trim().toLowerCase() === "/compact" && !projection.hasConversation;
          // Preparing a run may already point the thread at a newly selected
          // provider. Account commands still belong to its last native session.
          const nativeThreads = new Map(
            projection.providerThreads
              .filter(
                (candidate) => candidate.ownerNodeId === null && candidate.nativeThreadRef !== null,
              )
              .map((candidate) => [candidate.id, candidate]),
          );
          const previousNativeRun = projection.runs.reduce<OrchestrationV2Run | undefined>(
            (previous, candidate) =>
              candidate.ordinal < run.ordinal &&
              candidate.providerThreadId !== null &&
              nativeThreads.has(candidate.providerThreadId) &&
              (previous === undefined || candidate.ordinal > previous.ordinal)
                ? candidate
                : previous,
            undefined,
          );
          const nativeThread = nativeThreads.get(
            previousNativeRun?.providerThreadId ??
              projection.thread.activeProviderThreadId ??
              providerThread.id,
          );
          const authInstanceId = nativeThread?.providerInstanceId ?? run.providerInstanceId;
          const authResult = isEmptyCompaction
            ? null
            : yield* Effect.result(
                providerAuth.tryHandlePromptCommand({
                  instanceId: authInstanceId,
                  text: projectComposerContextForProvider({
                    text: message.text,
                    records: message.context?.records ?? [],
                  }),
                  hasAttachments: false,
                }),
              );
          if (isEmptyCompaction || authResult?._tag === "Failure" || authResult?.success) {
            const now = yield* DateTime.now;
            const failure = isEmptyCompaction
              ? makeProviderFailure({
                  class: "validation_error",
                  message: "Start a conversation before compacting this thread.",
                })
              : authResult?._tag === "Failure"
                ? makeProviderFailure({
                    class: "permission_error",
                    message: authResult.failure.detail,
                  })
                : undefined;
            const status = failure === undefined ? "completed" : "failed";
            yield* settleRunBeforeStart({
              signal: isEmptyCompaction ? "empty-compaction" : "provider-sign-out",
              status,
              now,
              startedAt: now,
              providerInstanceId: authInstanceId,
              itemProviderThreadId: nativeThread?.id ?? providerThread.id,
              item:
                failure !== undefined
                  ? {
                      type: "error",
                      title: isEmptyCompaction
                        ? "Cannot compact an empty thread"
                        : "Provider sign-out failed",
                      failure,
                    }
                  : {
                      type: "command_execution",
                      title: "Provider signed out",
                      input: message.text.trim(),
                      output: "Provider signed out",
                      exitCode: 0,
                    },
              providerThreadUpdate: {
                ...providerThread,
                status: providerThread.nativeThreadRef === null ? "not_loaded" : "idle",
                updatedAt: now,
              },
            });
            return;
          }
        }
        const { worktreePath, branch } = projection.thread;
        if (worktreePath !== null && branch !== null) {
          const exists = yield* fileSystem
            .exists(worktreePath)
            .pipe(Effect.orElseSucceed(() => true));
          if (!exists) {
            const project = yield* projects.getById(projection.thread.projectId).pipe(
              Effect.map(Option.getOrUndefined),
              Effect.orElseSucceed(() => undefined),
            );
            if (project !== undefined) {
              yield* Effect.logWarning("provider turn start recreating missing worktree", {
                threadId: projection.thread.id,
                worktreePath,
                branch,
              });
              yield* gitWorkflow.pruneWorktrees({ cwd: project.workspaceRoot }).pipe(
                Effect.andThen(
                  gitWorkflow.createWorktree({
                    cwd: project.workspaceRoot,
                    refName: branch,
                    path: worktreePath,
                  }),
                ),
                Effect.catchCause((cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.failCause(cause)
                    : Effect.logWarning("provider turn start failed to recreate worktree", {
                        threadId: projection.thread.id,
                        worktreePath,
                        cause: Cause.pretty(cause),
                      }),
                ),
              );
            }
          }
        }
        const selectInheritedBackgroundItems = (
          current: ProjectionStore.ProjectionRuntimeRecoveryState,
        ): ReturnType<typeof RunExecutionService.selectInheritedBackgroundTurnItems> =>
          RunExecutionService.selectInheritedBackgroundTurnItems({
            threadId: current.thread.id,
            currentProviderThreadId: providerThread.id,
            currentRunOrdinal: run.ordinal,
            runs: current.runs,
            turnItems: current.turnItems,
          });
        const inheritedBackgroundTurnItems = yield* projectionStore
          .getRuntimeRecoveryProjection(projection.thread.id)
          .pipe(Effect.map(selectInheritedBackgroundItems));
        const runControls = makeRunControls({
          threadId: projection.thread.id,
          runId: run.id,
          attemptId: attempt.id,
          providerThreadId: providerThread.id,
          runOrdinal: run.ordinal,
          inheritedBackgroundTurnItems,
        });
        const { isCurrentAttemptInStatus } = runControls;

        const resolvedRuntimePolicy = yield* runtimePolicy.resolve({
          thread: projection.thread,
          modelSelection: run.modelSelection,
        });
        if (!(yield* isCurrentAttemptInStatus("starting"))) return;
        const existingSessionProjection = projection.providerSessions.find(
          (candidate) => candidate.id === providerSessionId,
        );
        const sessionResult = yield* Effect.result(
          providerSessions.open({
            threadId: projection.thread.id,
            providerSessionId,
            modelSelection: run.modelSelection,
            runtimePolicy: resolvedRuntimePolicy,
            ...(existingSessionProjection === undefined
              ? {}
              : { resumeFromSession: existingSessionProjection }),
            ...(providerThread.nativeThreadRef?.nativeId == null
              ? {}
              : { initialNativeThreadId: providerThread.nativeThreadRef.nativeId }),
            ...(providerThread.nativeMetadata?.itemIdentityVersion === undefined
              ? {}
              : {
                  initialProviderItemIdentityVersion:
                    providerThread.nativeMetadata.itemIdentityVersion,
                }),
          }),
        );
        // The last start attempt fails the run with the provider's own reason
        // instead of leaving it `starting` after the effect gives up. A run that
        // already left `starting` is not overwritten, and a failed write returns
        // its error to the effect worker.
        const startFailure = (error: Error) => {
          const root = providerFailureRootCause(error);
          return makeProviderFailure({
            cause: error,
            message: knownProviderFailureMessage(error) ?? root.message ?? error.message,
            code: root.kind,
            class: "provider_error",
          });
        };
        const settleStartFailure = (failed: {
          readonly signal: string;
          readonly title: string;
          readonly failure: ReturnType<typeof startFailure>;
        }) =>
          Effect.gen(function* () {
            yield* settleRunBeforeStart({
              signal: failed.signal,
              status: "failed",
              now: yield* DateTime.now,
              providerInstanceId: run.providerInstanceId,
              itemProviderThreadId: providerThread.id,
              item: { type: "error", title: failed.title, failure: failed.failure },
            });
          });
        if (sessionResult._tag === "Failure") {
          const failure = sessionResult.failure;
          const requiresSignIn =
            "cause" in failure &&
            isProviderAdapterOpenSessionError(failure.cause) &&
            failure.cause.requiresSignIn === true;
          const classified = startFailure(failure);
          if (input.willRetry === true && !requiresSignIn && classified.class !== "usage_limit")
            return yield* failure;
          yield* settleStartFailure({
            signal: "provider-session-open-failure",
            title: "Provider session failed to open",
            failure: classified,
          });
          return;
        }
        let session = sessionResult.success;
        if (!(yield* isCurrentAttemptInStatus("starting"))) return;
        // Only the provider's own thread load fails the run on the last attempt;
        // store, id and handoff failures around it keep their typed errors.
        const loadFromProvider = (
          load: Effect.Effect<
            OrchestrationV2ProviderThread,
            ProviderAdapter.ProviderAdapterV2Error
          >,
        ) =>
          Effect.gen(function* () {
            const loaded = yield* Effect.result(load);
            if (loaded._tag === "Success") return loaded.success;
            const classified = startFailure(loaded.failure);
            if (input.willRetry === true && classified.class !== "usage_limit")
              return yield* loaded.failure;
            yield* settleStartFailure({
              signal: "provider-thread-load-failure",
              title: "Provider turn failed to start",
              failure: classified,
            });
            return undefined;
          });
        let limitedSource: OrchestrationV2Run | undefined;
        let retryLimitedRecovery = false;
        // A provider's terminal refusal is stronger evidence than cached quota windows,
        // which may be stale, account-wide, or scoped to another model.
        for (const source of projection.runs.toReversed()) {
          if (source.ordinal >= run.ordinal) continue;
          if (source.status !== "failed") break;
          if (modelSelectionsEqual(source.modelSelection, run.modelSelection)) {
            if (!handoffs.some((handoff) => handoff.targetRunId === source.id)) break;
            retryLimitedRecovery = true;
            continue;
          }
          if (
            (yield* projectionStore.getTurnStartHistory(input.threadId, [source.id])).some(
              (item) => item.type === "error" && item.failure.class === "usage_limit",
            )
          )
            limitedSource = source;
          break;
        }
        let effectiveHandoffs = handoffs;
        let resumeFellBack = false;
        const replaceWithHandoff = Effect.fnUntraced(function* () {
          if (!(yield* isCurrentAttemptInStatus("starting"))) return undefined;
          let replacement = yield* loadFromProvider(
            session.ensureThread({
              threadId: projection.thread.id,
              title: projection.thread.title,
              modelSelection: run.modelSelection,
              runtimePolicy: resolvedRuntimePolicy,
              providerSessionId,
              // The native ref is dropped so the adapter binds a fresh native
              // session instead of retrying the resume that just failed, while
              // still adopting this row's identity.
              existingProviderThread: {
                ...providerThread,
                nativeThreadRef: null,
                nativeConversationHeadRef: null,
                contextUsage: null,
              },
            }),
          );
          if (replacement === undefined) return undefined;
          if (!(yield* isCurrentAttemptInStatus("starting"))) return undefined;
          if (
            providerThread.nativeThreadRef?.nativeId != null &&
            replacement.nativeThreadRef?.nativeId === providerThread.nativeThreadRef.nativeId
          ) {
            // Some single-session harnesses bind ensureThread to their current native
            // session. Reopen the destination host without a resume id in that case.
            yield* providerSessions.release({ providerSessionId, reason: "manual_shutdown" });
            const opened = yield* Effect.result(
              providerSessions.open({
                threadId: projection.thread.id,
                providerSessionId,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
              }),
            );
            if (opened._tag === "Failure") {
              const classified = startFailure(opened.failure);
              if (input.willRetry === true && classified.class !== "usage_limit")
                return yield* opened.failure;
              yield* settleStartFailure({
                signal: "provider-session-open-failure",
                title: "Provider session failed to open",
                failure: classified,
              });
              return undefined;
            }
            session = opened.success;
            if (!(yield* isCurrentAttemptInStatus("starting"))) return undefined;
            replacement = yield* loadFromProvider(
              session.ensureThread({
                threadId: projection.thread.id,
                title: projection.thread.title,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                providerSessionId,
                existingProviderThread: {
                  ...providerThread,
                  nativeThreadRef: null,
                  nativeConversationHeadRef: null,
                  contextUsage: null,
                },
              }),
            );
            if (replacement === undefined) return undefined;
          }
          const transferId = yield* idAllocator.allocate.contextTransfer({
            sourceThreadId: projection.thread.id,
            targetThreadId: projection.thread.id,
            type: "provider_resume_fallback",
          });
          const createdAt = yield* DateTime.now;
          const handoff = yield* contextHandoffService.prepareProviderHandoff({
            threadId: projection.thread.id,
            targetRunId: run.id,
            transferId,
            fromProviderThreadIds: [providerThread.id],
            toProviderThreadId: providerThread.id,
            fromProviderInstanceId: providerThread.providerInstanceId,
            toProviderInstanceId: run.providerInstanceId,
            coveredRunOrdinals: { from: 1, to: Math.max(1, run.ordinal - 1) },
            strategy: "full_thread_summary",
            runs: projection.runs,
            items: (yield* projectionStore.getThreadRecords(input.threadId, ["turnItems"], {
              turnItemRunIds: [
                null,
                ...projection.runs
                  .filter(
                    (source) =>
                      source.ordinal < run.ordinal &&
                      ContextHandoffService.isHandoffSourceRun(source),
                  )
                  .map((source) => source.id),
              ],
            })).turnItems,
            createdAt,
          });
          effectiveHandoffs = [
            ...effectiveHandoffs.filter((candidate) => candidate.targetRunId !== run.id),
            handoff,
            ...effectiveHandoffs.filter((candidate) => candidate.targetRunId === run.id),
          ];
          resumeFellBack = true;
          yield* eventSink.write({
            events: [
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-handoff.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: handoff,
              },
              {
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "context-transfer.updated",
                threadId: projection.thread.id,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: createdAt,
                payload: {
                  id: transferId,
                  type: "provider_handoff",
                  sourceThreadId: projection.thread.id,
                  targetThreadId: projection.thread.id,
                  sourcePoint: { threadId: projection.thread.id },
                  basePoint: null,
                  sourceProviderInstanceId: providerThread.providerInstanceId,
                  targetProviderInstanceId: run.providerInstanceId,
                  targetRunId: run.id,
                  status: "resolved_portable",
                  resolution: { strategy: "portable_context", contextHandoffId: handoff.id },
                  createdBy: "system",
                  error: null,
                  createdAt,
                  updatedAt: createdAt,
                  consumedAt: null,
                },
              },
            ],
          });
          return replacement;
        });
        let loadedProviderThread = yield* Effect.gen(function* () {
          if (nativeForkTransfer !== undefined) {
            const sourceProjection = yield* projectionStore.getThreadRecords(
              nativeForkTransfer.sourceThreadId,
              ["runs", "providerThreads", "attempts", "providerTurns"],
            );
            const sourceRun = sourceProjection.runs.find(
              (candidate) => candidate.id === nativeForkTransfer.sourcePoint.runId,
            );
            const sourceProviderThread = sourceProjection.providerThreads.find(
              (candidate) => candidate.id === sourceRun?.providerThreadId,
            );
            const sourceAttempt = sourceProjection.attempts.find(
              (candidate) => candidate.id === sourceRun?.activeAttemptId,
            );
            const sourceProviderTurn =
              latestProviderTurnForAttempt(sourceProjection.providerTurns, sourceAttempt?.id) ??
              sourceProjection.providerTurns.find(
                (candidate) => candidate.id === sourceAttempt?.providerTurnId,
              );
            if (sourceRun === undefined || sourceProviderThread === undefined) {
              return yield* new ProviderTurnStartError({
                runId,
                cause: `Native fork transfer ${nativeForkTransfer.id} has no source provider execution.`,
              });
            }
            return yield* loadFromProvider(
              session.forkThread({
                sourceProviderThread,
                sourceProviderTurns: sourceProjection.providerTurns,
                targetThreadId: projection.thread.id,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                ...(sourceProviderTurn === undefined
                  ? {}
                  : { providerTurnId: sourceProviderTurn.id }),
              }),
            );
          }
          if (providerThread.nativeThreadRef === null) {
            // Hand the run's provider thread to the adapter so it adopts this
            // row's identity when attaching native state. An adapter that mints
            // its own row instead leaves two live rows per app thread, and
            // `activeProviderThreadId` then flaps between them on every update.
            return yield* loadFromProvider(
              session.ensureThread({
                threadId: projection.thread.id,
                title: projection.thread.title,
                modelSelection: run.modelSelection,
                runtimePolicy: resolvedRuntimePolicy,
                providerSessionId,
                existingProviderThread: providerThread,
              }),
            );
          }
          const uncertainDelivery = projection.contextHandoffs.some(
            (handoff) =>
              handoff.toProviderThreadId === providerThread.id &&
              handoff.delivery?.nativeThreadId === providerThread.nativeThreadRef?.nativeId &&
              handoff.delivery?.status === "pending",
          );
          const resumed = yield* Effect.result(
            uncertainDelivery
              ? Effect.fail(
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: session.driver,
                    threadId: projection.thread.id,
                    providerThreadId: providerThread.id,
                    runId,
                    cause: "Uncertain native history injection",
                  }),
                )
              : session.resumeThread({
                  providerThread,
                  threadId: projection.thread.id,
                  modelSelection: run.modelSelection,
                  runtimePolicy: resolvedRuntimePolicy,
                }),
          );
          if (resumed._tag === "Success") {
            return resumed.success;
          }

          // Automatic retries resume the existing native transcript only. An
          // uncertain resume needs a person, since replay into a fresh thread
          // could repeat a tool whose side effect completed before the failure.
          if (
            run.providerRetryContinuationOfRunId !== undefined ||
            startFailure(resumed.failure).class === "usage_limit"
          ) {
            return yield* loadFromProvider(Effect.fail(resumed.failure));
          }
          yield* Effect.logWarning("Provider resume failed; attempting a fresh native session", {
            driver: session.driver,
            providerThreadId: providerThread.id,
            runId,
            reason: uncertainDelivery ? "uncertain_history_delivery" : "resume_failed",
            errorTag: resumed.failure._tag,
          });
          return yield* replaceWithHandoff();
        });
        // The last attempt already failed the run.
        if (loadedProviderThread === undefined) return;
        const originalUserText = projectComposerContextForProvider({
          text: message.text,
          records: message.context?.records ?? [],
        });
        const knownModelWindow = session.getModelContextWindow?.(
          run.modelSelection,
          resolvedRuntimePolicy.cwd,
        );
        // Only started runs reached the provider-thread update below. Queued runs and
        // failures during session setup cannot establish a new telemetry selection.
        const measuredContext = latestNativeContextUsage(projection, providerThread);
        const previousSelection =
          measuredContext?.modelSelection ??
          projection.runs.findLast(
            (source) =>
              source.ordinal < run.ordinal &&
              source.status !== "rolled_back" &&
              source.startedAt !== null &&
              source.providerThreadId === providerThread.id,
          )?.modelSelection;
        const sameSelection =
          previousSelection === undefined ||
          modelSelectionsEqual(previousSelection, run.modelSelection);
        const threadUsage = loadedProviderThread.contextUsage ?? providerThread.contextUsage;
        const previousUsage = measuredContext
          ? { ...threadUsage, ...measuredContext.usage }
          : threadUsage;
        const reuseTelemetry =
          sameSelection ||
          (previousSelection !== undefined &&
            session.canReuseContextUsage?.(previousSelection, run.modelSelection) === true);

        const pendingHandoff = effectiveHandoffs.some(
          (handoff) =>
            handoff.delivery?.nativeThreadId !== loadedProviderThread?.nativeThreadRef?.nativeId ||
            handoff.delivery?.status === "pending",
        );
        if (
          (limitedSource !== undefined ||
            (pendingHandoff && !isNativeMaintenanceCommand(message))) &&
          run.providerRetryContinuationOfRunId === undefined &&
          !resumeFellBack &&
          providerThread.nativeThreadRef !== null &&
          loadedProviderThread.nativeThreadRef?.nativeId === providerThread.nativeThreadRef.nativeId
        ) {
          const usage = contextUsageForHandoff({
            sameNativeThread: true,
            sameSelection,
            reuseTelemetry,
            previousUsage,
            knownModelWindow,
          });
          const nativeContextEstimate =
            usage == null
              ? nativeContextState({
                  projection,
                  providerThread,
                  run,
                  nativeThreadId: loadedProviderThread.nativeThreadRef?.nativeId,
                }).estimateHistory(yield* projectionStore.getTurnStartHistory(input.threadId))
              : 0;
          const budgetInput = {
            tokenCap: DEFAULT_HANDOFF_TOKEN_CAP,
            userText: originalUserText,
            attachments: message.attachments,
            providerThread: { ...loadedProviderThread, contextUsage: usage },
            nativeContextEstimate,
            modelContextWindow: knownModelWindow ?? usage?.maxTokens,
          };
          // A required handoff cannot reach a full returning transcript. Only
          // replace it when a fresh transcript has room for that handoff.
          const needsFreshHandoff =
            pendingHandoff &&
            handoffBudget(budgetInput) < 2_048 &&
            handoffBudget({
              ...budgetInput,
              providerThread: { ...loadedProviderThread, contextUsage: null },
              nativeContextEstimate: 0,
            }) >= 2_048;
          if (
            (limitedSource !== undefined &&
              knownModelWindow !== undefined &&
              (usage?.usedTokens ?? nativeContextEstimate) +
                Buffer.byteLength(originalUserText) +
                attachmentTokenAllowance(message.attachments) >
                knownModelWindow) ||
            needsFreshHandoff
          ) {
            loadedProviderThread = yield* replaceWithHandoff();
            if (loadedProviderThread === undefined) return;
          }
        }
        const recoverySource =
          limitedSource !== undefined &&
          (retryLimitedRecovery ||
            effectiveHandoffs.some(
              (handoff) =>
                handoff.delivery?.nativeThreadId !==
                  loadedProviderThread.nativeThreadRef?.nativeId ||
                handoff.delivery?.status === "pending",
            ))
            ? limitedSource
            : undefined;
        if (!(yield* isCurrentAttemptInStatus("starting"))) {
          return;
        }
        const now = yield* DateTime.now;
        const sameNativeThread =
          loadedProviderThread.nativeThreadRef?.nativeId ===
          providerThread.nativeThreadRef?.nativeId;
        // Persist before delivery. Keep this native transcript's measured
        // occupancy. A different model drops compaction telemetry and uses the
        // new window when that window is known.
        const handoffUsage = contextUsageForHandoff({
          sameNativeThread,
          sameSelection,
          reuseTelemetry,
          previousUsage,
          knownModelWindow,
        });
        const runningProviderThread: OrchestrationV2ProviderThread = {
          ...loadedProviderThread,
          contextUsage: handoffUsage,
          id: providerThread.id,
          driver: session.driver,
          providerInstanceId: run.providerInstanceId,
          providerSessionId,
          appThreadId: projection.thread.id,
          ownerNodeId: providerThread.ownerNodeId,
          firstRunOrdinal: providerThread.firstRunOrdinal ?? run.ordinal,
          lastRunOrdinal: run.ordinal,
          handoffIds: providerThread.handoffIds,
          forkedFrom: providerThread.forkedFrom,
          status: "active",
          createdAt: providerThread.createdAt,
          updatedAt: now,
        };
        const carriedTasks = isNativeMaintenanceCommand(message)
          ? []
          : resultsForNextTurn(projection);
        const carriedTaskIds = carriedTasks.map((task) => task.id);
        const runningRun: OrchestrationV2Run = {
          ...run,
          status: "running",
          startedAt: run.startedAt ?? now,
          ...(carriedTaskIds.length ? { carriedTaskIds } : {}),
        };
        const runningAttempt: OrchestrationV2RunAttempt = {
          ...attempt,
          ...(run.providerRetryContinuationOfRunId === undefined
            ? {}
            : { providerStartRequested: false }),
          ...(runningProviderThread.nativeThreadRef?.nativeId == null
            ? {}
            : { nativeThreadId: runningProviderThread.nativeThreadRef.nativeId }),
          status: "running",
          startedAt: now,
        };
        const runningRootNode: OrchestrationV2ExecutionNode = {
          ...rootNode,
          status: "running",
          startedAt: now,
        };
        const events: Array<OrchestrationV2DomainEvent> = [
          {
            id: yield* idAllocator.allocate.event({
              threadId: projection.thread.id,
              providerSessionId,
            }),
            type: "provider-session.updated",
            threadId: projection.thread.id,
            driver: session.driver,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: session.providerSession,
          },
          {
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "provider-thread.updated",
            threadId: projection.thread.id,
            driver: session.driver,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: runningProviderThread,
          },
          ...(nativeForkTransfer === undefined || runningProviderThread.nativeThreadRef === null
            ? []
            : [
                {
                  id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                  type: "context-transfer.updated" as const,
                  threadId: projection.thread.id,
                  runId: run.id,
                  driver: session.driver,
                  providerInstanceId: run.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    ...nativeForkTransfer,
                    targetProviderInstanceId: run.providerInstanceId,
                    targetRunId: run.id,
                    status: "consumed" as const,
                    resolution: {
                      strategy: "native_fork" as const,
                      providerThreadRef: runningProviderThread.nativeThreadRef,
                    },
                    error: null,
                    updatedAt: now,
                    consumedAt: now,
                  },
                },
              ]),
          {
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "run.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: runningRun,
          },
          {
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "run-attempt.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: runningAttempt,
          },
          {
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "node.updated",
            threadId: projection.thread.id,
            runId: run.id,
            nodeId: rootNode.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: runningRootNode,
          },
        ];
        if (recoverySource !== undefined) {
          events.push({
            id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
            type: "turn-item.updated",
            threadId: projection.thread.id,
            runId: run.id,
            providerInstanceId: run.providerInstanceId,
            occurredAt: now,
            payload: {
              id: idAllocator.derive.runSignalTurnItem({ runId, signal: "limit-context-recovery" }),
              threadId: projection.thread.id,
              runId,
              nodeId: rootNode.id,
              providerThreadId: providerThread.id,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: Math.max(0, ...projection.turnItems.map((item) => item.ordinal)) + 1,
              status: "completed",
              title: "Context recovery",
              type: "system_notice",
              message: `Using ${run.modelSelection.model} to summarize context because ${recoverySource.modelSelection.model}'s usage limit was reached. The full conversation remains saved; omitted history can be retrieved from this chat.`,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          });
        }
        const routableSubagents = projection.subagents.filter(
          (subagent) =>
            subagent.remote === undefined &&
            RunExecutionService.canRouteRelatedSubagent(subagent.status),
        );
        // A new session gets the current rules; only an existing session
        // needs a notice to supersede its earlier subagent policy.
        const subagentsNoticeLine = chatControls.consumeSubagentNotice(
          projection.thread.id,
          projection.thread.activeProviderThreadId !== null,
        )
          ? `${chatControls.subagentsEnabled(projection.thread.id) ? SUBAGENTS_ON_USER_LINE : SUBAGENTS_OFF_USER_LINE}\n`
          : "";
        // A subagent whose worktree setup did not complete learns it before its task.
        const setupNotice = workspaceSetupNotice(projection.turnItems, run.id);
        // A subagent the user started has no brief from the lead: point it at the lead's chat.
        const userStartNotice = userStartedSubagentNotice(projection.thread, projection.runs, run);
        const userText =
          (carriedTaskIds.length
            ? `${delegatedCompletionWakeDetail(carriedTaskIds, carriedTasks)}\n\n`
            : "") +
          (setupNotice === undefined ? "" : `${setupNotice}\n\n`) +
          (userStartNotice === undefined ? "" : `${userStartNotice}\n\n`) +
          subagentsNoticeLine +
          (recoverySource !== undefined
            ? [
                `The previous model (${recoverySource.modelSelection.model}) reached its usage limit. Recover context using the selected model (${run.modelSelection.model}); do not ask the previous model to summarize.`,
                "Use the historical context and its t3_thread_read recovery references to recover omitted details as needed. Write a concise continuation summary preserving the user's goals, constraints, decisions, changes, and unfinished work.",
                message.attachments.length === 0 &&
                originalUserText.trim().toLowerCase() === "/compact"
                  ? "The user requested compaction. Reply with the summary and wait for the next request."
                  : `Then continue with the user's request:\n${originalUserText}`,
              ].join("\n\n")
            : originalUserText);
        // Delivered once: this run's provider turn marks the work as told. A
        // restart continuation is prompted by its own text or resumes natively.
        // It is prompted when it carries more than the bare resume prompt: a
        // note, re-sent messages, or the message of a run that never started.
        const promptedContinuation =
          run.restartContinuationOfRunId !== undefined &&
          (continuesAccountMove(
            run,
            projection.runs,
            projection.attempts,
            projection.providerTurns,
          ) ||
            carriedTaskIds.length > 0 ||
            message.text !== RESTART_CONTINUE_PROMPT ||
            message.attachments.length > 0 ||
            isRestartNoteContinuation(
              run,
              projection.runs,
              projection.providerTurns,
              projection.attempts,
            ));
        const restartCancelledWork = pendingRestartCancelledBackgroundWork({
          runs: projection.runs,
          providerTurns: projection.providerTurns,
          compactionMessageIds: new Set(
            projection.messages
              .filter(
                (candidate) =>
                  candidate.attachments.length === 0 &&
                  candidate.text.trim().toLowerCase() === "/compact",
              )
              .map((candidate) => candidate.id),
          ),
          run,
          attempts: projection.attempts,
        });
        const restartNote =
          restartCancelledWork.length === 0
            ? ""
            : restartCancelledBackgroundWorkNote(restartCancelledWork);
        const fixedTokenCap = yield* handoffTokenCapConfig.pipe(
          Effect.orElseSucceed(() => Option.none<number>()),
        );
        const {
          deliveredItemIds,
          coveredItemIds,
          acceptedAttempts,
          nativeInputRunIds,
          legacyInputRunIds,
          missedRuns,
          missedRunIds,
          estimateHistory,
        } = nativeContextState({
          projection,
          providerThread,
          run,
          nativeThreadId: runningProviderThread.nativeThreadRef?.nativeId,
        });
        const nativeContextEstimate = sameNativeThread
          ? projectionStore.getTurnStartHistory(input.threadId).pipe(Effect.map(estimateHistory))
          : Effect.succeed(0);
        // Providers that report their window only after a turn (ACP, Codex) start a fresh
        // handoff thread knowing nothing; what the instance reported before stands in.
        const modelContextWindow =
          knownModelWindow ??
          (handoffUsage !== null || reuseTelemetry ? previousUsage?.maxTokens : undefined) ??
          (effectiveHandoffs.length === 0
            ? undefined
            : yield* (
                projectionStore.getReportedContextWindow?.(run.providerInstanceId) ??
                  Effect.succeed(undefined)
              ));
        const tokenCap = Option.getOrElse(fixedTokenCap, () =>
          scaledHandoffTokenCap(modelContextWindow),
        );
        // What a move to another model adds to the history: the outgoing model's brief and
        // the workspace. A merge-back carries history only. Read once, whatever the number of
        // delivery attempts.
        const switchHandoffs = effectiveHandoffs.filter(
          (handoff) =>
            handoff.targetRunId === run.id &&
            handoff.transferId != null &&
            handoff.strategy !== "fork_delta_summary",
        );
        const handoffBrief = yield* Effect.cached(
          switchHandoffs.length === 0 ||
            Option.isNone(handoffBriefs) ||
            switchHandoffs.some((handoff) => handoff.brief !== undefined)
            ? Effect.succeed(Option.none<HandoffBriefService.HandoffBrief>())
            : handoffBriefs.value.take({
                threadId: input.threadId,
                targetInstanceId: run.providerInstanceId,
                deadlineMs: briefDeadlineMs,
              }),
        );
        const handoffWorkspace = yield* Effect.cached(
          switchHandoffs.length === 0
            ? Effect.succeed("")
            : Effect.gen(function* () {
                const cwd = resolvedRuntimePolicy.cwd ?? projection.thread.worktreePath;
                const status =
                  cwd === null || Option.isNone(git)
                    ? undefined
                    : Option.getOrUndefined(
                        yield* git.value.statusDetailsLocal(cwd, { includeDivergence: false }).pipe(
                          Effect.timeoutOption(HANDOFF_GIT_STATUS_TIMEOUT),
                          Effect.orElseSucceed(() => Option.none()),
                        ),
                      );
                return renderHandoffWorkspace({
                  branch: status?.branch ?? projection.thread.branch,
                  worktreePath: projection.thread.worktreePath,
                  folder: cwd,
                  status:
                    status?.isRepo === true
                      ? {
                          files: status.workingTree.files.map((file) => file.path),
                          insertions: status.workingTree.insertions,
                          deletions: status.workingTree.deletions,
                        }
                      : null,
                  changedFiles: [
                    ...new Set(
                      switchHandoffs.flatMap((handoff) => handoff.history?.changedFiles ?? []),
                    ),
                  ],
                  pendingWork: switchHandoffs.flatMap(
                    (handoff) => handoff.history?.pendingWork ?? [],
                  ),
                });
              }),
        );
        // Replacing a native thread clears its usage, not the selected model's capacity.
        const budgetProviderThread = {
          ...runningProviderThread,
          contextUsage: handoffUsage,
        };
        const missedItems =
          resumeFellBack || missedRunIds.size === 0
            ? []
            : (yield* projectionStore.getTurnStartHistory(input.threadId, [
                ...missedRunIds,
              ])).filter(
                (item) =>
                  item.runId !== null &&
                  missedRunIds.has(item.runId) &&
                  !coveredItemIds.has(item.id) &&
                  historicalMessage(item) !== null,
              );
        const runningWrite = yield* eventSink.writeIfRunCurrent({
          threadId: projection.thread.id,
          runId: run.id,
          activeAttemptId: attempt.id,
          expectedStatus: "starting",
          events,
        });
        if (!runningWrite.committed) {
          return;
        }
        // The timeline row says the brief came along.
        const labelHandoffItemsWithBrief = (brief: HandoffBriefService.HandoffBrief) =>
          Effect.gen(function* () {
            const handoffIds = new Set(switchHandoffs.map((handoff) => handoff.id));
            const items = projection.turnItems.flatMap((item) =>
              item.type === "handoff" &&
              handoffIds.has(item.contextHandoffId) &&
              item.brief === undefined
                ? [item]
                : [],
            );
            if (items.length === 0) return;
            const updatedAt = yield* DateTime.now;
            const events: Array<OrchestrationV2DomainEvent> = [];
            for (const item of items)
              events.push({
                id: yield* idAllocator.allocate.event({ threadId: projection.thread.id }),
                type: "turn-item.updated",
                threadId: projection.thread.id,
                runId: run.id,
                ...(item.nodeId === null ? {} : { nodeId: item.nodeId }),
                providerInstanceId: run.providerInstanceId,
                occurredAt: updatedAt,
                payload: {
                  ...item,
                  brief: { providerInstanceId: brief.providerInstanceId, model: brief.model },
                  updatedAt,
                },
              });
            yield* eventSink.write({ events });
          });
        const startWithHandoffs = (
          turnInput: Parameters<typeof session.startTurn>[0],
          compact = false,
        ) =>
          Effect.gen(function* () {
            // A failed turn/start can leave the requested turn absent from
            // native history even when its preceding handoff was injected.
            const retryHandoff =
              missedItems.length === 0
                ? []
                : [
                    yield* contextHandoffService.prepareProviderHandoff({
                      threadId: projection.thread.id,
                      targetRunId: run.id,
                      transferId: null,
                      fromProviderThreadIds: [providerThread.id],
                      toProviderThreadId: providerThread.id,
                      fromProviderInstanceId: run.providerInstanceId,
                      toProviderInstanceId: run.providerInstanceId,
                      coveredRunOrdinals: {
                        from: missedRuns[0]!.ordinal,
                        to: missedRuns.at(-1)!.ordinal,
                      },
                      strategy: "delta_since_target_last_seen",
                      items: missedItems,
                      runs: projection.runs,
                      createdAt: yield* DateTime.now,
                    }),
                  ];
            const brief = Option.getOrUndefined(yield* handoffBrief);
            const workspace = yield* handoffWorkspace;
            const deliver = (handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>) =>
              deliverContextHandoffs({
                handoffs,
                brief,
                workspace,
                deferInline: compact && recoverySource === undefined,
                providerThread: runningProviderThread,
                budget: Effect.gen(function* () {
                  return handoffBudget({
                    tokenCap,
                    modelContextWindow,
                    // The note is sent with the user text, so it spends the same allowance.
                    userText: restartNote === "" ? userText : `${restartNote}\n\n${userText}`,
                    attachments: message.attachments,
                    providerThread: budgetProviderThread,
                    nativeContextEstimate:
                      budgetProviderThread.contextUsage?.usedTokens === undefined
                        ? yield* nativeContextEstimate
                        : 0,
                  });
                }),
                alreadyDeliveredItemIds: deliveredItemIds,
                ...(session.injectHistory === undefined
                  ? {}
                  : {
                      inject: (history: ProviderAdapter.ProviderAdapterV2HistoricalContext) =>
                        session.injectHistory!({
                          providerThread: runningProviderThread,
                          ...history,
                        }),
                    }),
                persist: (handoff) =>
                  Effect.gen(function* () {
                    const updatedAt = yield* DateTime.now;
                    yield* eventSink.write({
                      events: [
                        {
                          id: yield* idAllocator.allocate.event({
                            threadId: projection.thread.id,
                          }),
                          type: "context-handoff.updated",
                          threadId: projection.thread.id,
                          runId: run.id,
                          providerInstanceId: run.providerInstanceId,
                          occurredAt: updatedAt,
                          payload: { ...handoff, updatedAt },
                        },
                      ],
                    });
                  }),
              });
            // Replaying a failed run's content into the same native thread is
            // optional. When it does not fit beside the native transcript, skip it
            // rather than fail: the failed runs stay missed, so a later turn
            // replays them once the provider has compacted. Failing here would
            // add this run to the missed set and refuse every later message.
            const delivery = yield* deliver([...effectiveHandoffs, ...retryHandoff]).pipe(
              Effect.catchTags({
                ContextHandoffBudgetError: (error) =>
                  retryHandoff.length === 0
                    ? Effect.fail(error)
                    : Effect.logInfo("Skipping missed-run replay that does not fit", {
                        runId: run.id,
                        missedRunIds: [...missedRunIds],
                      }).pipe(Effect.andThen(deliver(effectiveHandoffs))),
              }),
            );
            if (delivery.briefIncluded && brief !== undefined)
              yield* labelHandoffItemsWithBrief(brief).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Failed to label a handoff with its brief", {
                    runId: run.id,
                    cause,
                  }),
                ),
              );
            if (!(yield* isCurrentAttemptInStatus("running"))) return;
            const start =
              compact && recoverySource === undefined ? session.compactThread! : session.startTurn;
            const context = [delivery.context, restartNote]
              .filter((part) => part !== "")
              .join("\n\n");
            // A prompted continuation has no turn to resume; its text is the prompt.
            const { restartContinuationOfRunId: _resumedRunId, ...promptedInput } = turnInput;
            yield* start({
              ...(promptedContinuation ? promptedInput : turnInput),
              message: {
                ...turnInput.message,
                text: context === "" ? userText : `${context}\n\nUser message:\n${userText}`,
              },
            }).pipe(
              // A pending marker would make the next turn abandon this native
              // session, though the refused prompt never reached it.
              Effect.tapError((error) =>
                refusedBeforePrompt(error)
                  ? delivery.unsent.pipe(
                      Effect.catchCause(() =>
                        Effect.logWarning("Failed to restore unsent context handoffs", {
                          runId: run.id,
                        }),
                      ),
                    )
                  : Effect.void,
              ),
            );
            // The provider already accepted the turn. A stale pending marker
            // can force a fresh thread later, but must not stop live ingestion.
            yield* delivery.delivered.pipe(
              Effect.catchCause(() =>
                Effect.logWarning("Failed to record accepted context handoff delivery", {
                  runId: run.id,
                  deliveryStatus: "pending",
                }),
              ),
            );
          }).pipe(
            Effect.mapError((cause) =>
              cause._tag === "ProviderAdapterTurnStartError"
                ? cause
                : new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver: session.driver,
                    threadId: projection.thread.id,
                    providerThreadId: providerThread.id,
                    runId: run.id,
                    cause,
                  }),
            ),
          );
        const deliverySession =
          effectiveHandoffs.length === 0 &&
          missedItems.length === 0 &&
          restartNote === "" &&
          !promptedContinuation
            ? session
            : makeDeliverySession(session, startWithHandoffs);
        return runExecution.startRootRun({
          commandId: CommandId.make(`command:effect:provider-turn.start:${run.id}`),
          appThread: projection.thread,
          providerSessionId,
          session: Option.isNone(terminal)
            ? deliverySession
            : makeTerminalGuardedSession(terminal.value, deliverySession),
          run: runningRun,
          rootNode: runningRootNode,
          checkpointScope,
          providerThread: runningProviderThread,
          attempt: runningAttempt,
          attemptId: attempt.id,
          loadInheritedBackgroundTurnItems: runControls.loadInheritedBackgroundTurnItems,
          relatedThreadIds: routableSubagents.flatMap((subagent) =>
            subagent.childThreadId === null ? [] : [subagent.childThreadId],
          ),
          relatedProviderThreadIds: routableSubagents.flatMap((subagent) =>
            subagent.providerThreadId === null ? [] : [subagent.providerThreadId],
          ),
          providerTurnOrdinal:
            Math.max(
              0,
              ...projection.providerTurns
                .filter((turn) => turn.providerThreadId === providerThread.id)
                .map((turn) => turn.ordinal),
            ) + 1,
          // Legacy accepted attempts have no native id. They count only before
          // a replacement, while no accepted attempt records a native identity.
          nativeThreadHasTurns:
            nativeInputRunIds.size > 0 ||
            (legacyInputRunIds.size > 0 &&
              sameNativeThread &&
              !acceptedAttempts.some((source) => source.nativeThreadId !== undefined)),
          shouldStartProviderTurn: runControls.shouldStartProviderTurn,
          shouldFinalizeRun: runControls.shouldFinalizeRun,
          hasUnpairedRunInterruptRequest: runControls.hasUnpairedRunInterruptRequest,
          message: {
            messageId: message.id,
            text: userText,
            attachments: message.attachments,
            createdBy: message.createdBy,
            creationSource: message.creationSource,
            ...(message.scheduledTaskId === undefined
              ? {}
              : { scheduledTaskId: message.scheduledTaskId }),
            ...(message.senderThreadId === undefined
              ? {}
              : { senderThreadId: message.senderThreadId }),
          },
          modelSelection: run.modelSelection,
          runtimePolicy: resolvedRuntimePolicy,
        });
      }).pipe(
        Effect.catch((cause) => {
          if (input.willRetry === true || settlementAttempted) return Effect.fail(cause);
          return Effect.gen(function* () {
            // The outbox keeps the full cause only until it is pruned, so the
            // run's error item keeps its kind and redacted message.
            const rootCause = providerFailureRootCause(cause);
            yield* settleRunBeforeStart({
              signal: "provider-start-setup-failure",
              status: "failed",
              now: yield* DateTime.now,
              providerInstanceId: run.providerInstanceId,
              itemProviderThreadId: providerThread.id,
              item: {
                type: "error",
                title: "Provider turn failed to start",
                failure: makeProviderFailure({
                  cause,
                  message:
                    knownProviderFailureMessage(cause) ?? rootCause.message ?? "Run setup failed.",
                  code: rootCause.kind,
                  class: "unknown",
                }),
              },
            });
            return yield* Effect.fail(cause);
          });
        }),
      );
    });

    return ProviderTurnStartServiceV2.of({
      start: (input) =>
        Effect.gen(function* () {
          // Storage cleanup removes worktrees under the same lease. Only startup
          // holds it; the provider turn runs after it is released.
          const { thread } = yield* projectionStore.getThreadRecords(input.threadId, []);
          const setup =
            thread.worktreePath === null
              ? start(input)
              : withWorkspaceLease(path.resolve(thread.worktreePath), start(input));
          const providerTurn = yield* Option.isSome(terminal)
            ? terminal.value.withStart(input.threadId, setup)
            : setup;
          if (providerTurn !== undefined) yield* providerTurn;
        }).pipe(
          Effect.mapError((cause) =>
            isProviderTurnStartError(cause)
              ? cause
              : new ProviderTurnStartError({ runId: input.runId, cause }),
          ),
        ),
    });
  }),
);
