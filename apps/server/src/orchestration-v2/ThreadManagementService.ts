import {
  assertProviderInstanceEnabled as assertInstanceEnabled,
  ProjectAdmissionCommandId,
  ThreadManagementProviderInstanceDisabledError,
} from "./ProviderInstancePolicy.ts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import type { OrchestrationV2StoredEvent } from "@t3tools/contracts";
import * as ProviderCredentials from "../provider/ProviderCredentials.ts";
import * as ExecutionResources from "../execution/ExecutionResources.ts";
import { isHelperThreadId } from "@t3tools/contracts";
import type {
  OrchestrationV2SearchThreadInput,
  OrchestrationV2SearchThreadResult,
} from "@t3tools/contracts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
  ProjectionRecords,
  ShellSnapshotOptions,
} from "./ProjectionStore.ts";
import {
  type ChatAttachment,
  ChatTabsError,
  type ChatTabsCommand,
  isTerminalRunStatus,
  CommandId,
  MessageId,
  OrchestrationV2StopWorkflowError,
  OrchestrationV2BackgroundToolCallError,
  type OrchestrationV2BackgroundToolCallInput,
  type OrchestrationV2BackgroundToolCallResult,
  type OrchestrationV2StopWorkflowInput,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2Command,
  type OrchestrationV2GetTurnItemResult,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2CreationSource,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadTranscript,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  ProjectId,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  RunId,
  type ScheduledTaskId,
  ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import { threadTranscriptHeader } from "@t3tools/shared/threadTranscript";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { projectedRowEncodedBytes } from "./threadHistoryPaging.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as TerminalHandoffState from "./TerminalHandoffState.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import { DispatchModeLimit, exceededDispatchModeLimit } from "./DispatchModeLimit.ts";
import { projectTurnItemForDetail } from "./WireProjection.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChatTabs from "../sessionBoxes/chatTabs.ts";
import { AUTO_TITLE_COMMAND_PREFIX, boxTitles } from "../sessionBoxes/boxNamerCache.ts";

const isChatTabsError = Schema.is(ChatTabsError);

export type ThreadManagementSendMode = "auto" | "queue" | "steer" | "restart";

export interface ThreadManagementProvenance {
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export function withCreationProvenance(
  command: OrchestrationV2Command,
  provenance: ThreadManagementProvenance,
): OrchestrationV2Command {
  switch (command.type) {
    case "thread.create":
    case "message.dispatch":
    case "thread.fork":
    case "thread.merge_back":
    case "delegated_task.request":
      return { ...command, ...provenance };
    default:
      return command;
  }
}

export function existingThreadIdsForCommand(
  command: OrchestrationV2ServerCommand,
): ReadonlyArray<ThreadId> {
  switch (command.type) {
    case "thread.create":
      return [];
    // Read-state commands only rewrite the thread payload's visited/unread
    // watermark; they never touch messages, so they do not need the imported
    // v1 transcript hydrated first. Visits fire on every thread-activity bump
    // while a thread is open, so keeping them off the import path matters.
    case "thread.visit":
    case "thread.mark-unread":
      return [];
    case "thread.fork":
      return [command.sourceThreadId];
    case "thread.merge_back":
      return command.sourceThreadId === command.targetThreadId
        ? [command.sourceThreadId]
        : [command.sourceThreadId, command.targetThreadId];
    case "delegated_task.request":
    case "delegated_task.wake-policy":
    case "delegated_task.cancel-requested":
    case "delegated_task.completion-delivery.acknowledge":
    case "delegated_task.completion-delivery.dispose":
      return [command.parentThreadId];
    case "thread.created.record":
      return command.parentThreadId === command.targetThreadId
        ? [command.parentThreadId]
        : [command.parentThreadId, command.targetThreadId];
    default:
      return [command.threadId];
  }
}

export type ThreadManagementTerminalRunStatus = Extract<
  OrchestrationV2Run["status"],
  "completed" | "failed" | "cancelled" | "interrupted" | "rolled_back"
>;

export interface ThreadManagementSendInput {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly notifySenderOnCompletion?: boolean;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly modelSelection?: ModelSelection;
  readonly mode: ThreadManagementSendMode;
  readonly expectedRunId?: RunId;
  readonly steerExistingOnly?: boolean;
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

export interface ThreadManagementSendResult {
  readonly dispatch: Orchestrator.OrchestratorV2DispatchResult;
  readonly projection: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "messages" | "turnItems"
  >;
  readonly message: OrchestrationV2ConversationMessage;
  readonly run: OrchestrationV2Run;
  /** Null for queued sends: the user turn item materializes when the queued turn starts. */
  readonly turnItem: Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> | null;
  readonly delivery: "started" | "queued" | "steered" | "restarted";
}

export interface ThreadManagementWaitInput {
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly timeoutMs: number;
}

export interface ThreadManagementWaitResult {
  readonly threadId: ThreadId;
  readonly run: OrchestrationV2Run | null;
  readonly timedOut: boolean;
}

export interface ThreadManagementInterruptInput {
  readonly projectId: ProjectId;
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId?: RunId;
  readonly reason?: string;
}

export type ThreadManagementInterruptResult =
  | {
      readonly type: "interrupt_requested";
      readonly run: OrchestrationV2Run;
      readonly dispatch: Orchestrator.OrchestratorV2DispatchResult;
    }
  | { readonly type: "no_active_run" }
  | {
      readonly type: "already_terminal";
      readonly run: OrchestrationV2Run & { readonly status: ThreadManagementTerminalRunStatus };
    };

export class ThreadManagementThreadNotFoundError extends Schema.TaggedError<ThreadManagementThreadNotFoundError>()(
  "ThreadManagementThreadNotFoundError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} was not found in project ${this.projectId}.`;
  }
}

export class ThreadTranscriptTooLargeError extends Schema.TaggedError<ThreadTranscriptTooLargeError>()(
  "ThreadTranscriptTooLargeError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "The thread transcript exceeds the file attachment limit.";
  }
}

export class ThreadManagementRunNotFoundError extends Schema.TaggedError<ThreadManagementRunNotFoundError>()(
  "ThreadManagementRunNotFoundError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} does not belong to thread ${this.threadId}.`;
  }
}

export class ThreadManagementThreadArchivedError extends Schema.TaggedError<ThreadManagementThreadArchivedError>()(
  "ThreadManagementThreadArchivedError",
  {
    threadId: ThreadId,
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} is archived and cannot receive messages.`;
  }
}

export class ThreadManagementNoSteerableRunError extends Schema.TaggedError<ThreadManagementNoSteerableRunError>()(
  "ThreadManagementNoSteerableRunError",
  {
    threadId: ThreadId,
    mode: Schema.Literals(["steer", "restart"]),
  },
) {
  override get message(): string {
    return `Thread ${this.threadId} has no running turn that can be ${this.mode === "steer" ? "steered" : "restarted"}.`;
  }
}

export class ThreadManagementThreadNotInterruptibleError extends Schema.TaggedError<ThreadManagementThreadNotInterruptibleError>()(
  "ThreadManagementThreadNotInterruptibleError",
  {
    threadId: ThreadId,
    runId: RunId,
  },
) {
  override get message(): string {
    return `Run ${this.runId} is not currently interruptible.`;
  }
}

export class ThreadManagementProjectionLoadError extends Schema.TaggedError<ThreadManagementProjectionLoadError>()(
  "ThreadManagementProjectionLoadError",
  {
    projectId: ProjectId,
    threadId: ThreadId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to load thread ${this.threadId} in project ${this.projectId}.`;
  }
}

export class ThreadManagementProjectThreadsListError extends Schema.TaggedError<ThreadManagementProjectThreadsListError>()(
  "ThreadManagementProjectThreadsListError",
  {
    projectId: ProjectId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Unable to list threads in project ${this.projectId}.`;
  }
}

export class ThreadManagementDurableRunProjectionError extends Schema.TaggedError<ThreadManagementDurableRunProjectionError>()(
  "ThreadManagementDurableRunProjectionError",
  {
    threadId: ThreadId,
    messageId: MessageId,
  },
) {
  override get message(): string {
    return `Message ${this.messageId} was accepted on thread ${this.threadId} without a durable run projection.`;
  }
}

export { ThreadManagementProviderInstanceDisabledError };

export const ThreadManagementError = Schema.Union([
  ThreadManagementThreadNotFoundError,
  ThreadManagementRunNotFoundError,
  ThreadManagementThreadArchivedError,
  ThreadManagementNoSteerableRunError,
  ThreadManagementThreadNotInterruptibleError,
  ThreadManagementProjectionLoadError,
  ThreadManagementProjectThreadsListError,
  ThreadManagementDurableRunProjectionError,
  ThreadManagementProviderInstanceDisabledError,
]);
export type ThreadManagementError = typeof ThreadManagementError.Type;

type ThreadManagementFailure = ThreadManagementError | Orchestrator.OrchestratorV2Error;

export interface ThreadManagementServiceShape {
  readonly searchThreadStream: (
    input: OrchestrationV2SearchThreadInput,
  ) => Stream.Stream<OrchestrationV2SearchThreadResult, Orchestrator.OrchestratorV2Error>;
  readonly searchThread: (
    input: OrchestrationV2SearchThreadInput,
  ) => Effect.Effect<OrchestrationV2SearchThreadResult, Orchestrator.OrchestratorV2Error>;
  readonly ensureLegacyTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<void, LegacyV1ThreadImporter.LegacyV1ThreadImportError>;
  /**
   * The single chokepoint for commands that can start or wake provider work:
   * `message.dispatch` and `delegated_task.request` are refused here when the
   * resolved instance is off for the project, except a command id that
   * already has a receipt, which only replays its recorded result.
   */
  readonly dispatch: (
    command: OrchestrationV2ServerCommand,
  ) => Effect.Effect<
    Orchestrator.OrchestratorV2DispatchResult,
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly getThreadHistoryPage: Orchestrator.OrchestratorV2["Service"]["getThreadHistoryPage"];
  readonly getThreadMediaPage: Orchestrator.OrchestratorV2["Service"]["getThreadMediaPage"];
  readonly getTimelinePage: Orchestrator.OrchestratorV2["Service"]["getTimelinePage"];
  readonly getMessageCount: Orchestrator.OrchestratorV2["Service"]["getMessageCount"];
  /**
   * One turn item with the input and output the thread stream withholds,
   * bounded for the wire. Clients fetch it when a tool row is expanded.
   */
  readonly getTurnItem: (input: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Effect.Effect<OrchestrationV2GetTurnItemResult, Orchestrator.OrchestratorV2Error>;
  readonly getThreadRecords: Orchestrator.OrchestratorV2["Service"]["getThreadRecords"];
  readonly getThreadProjection: (
    threadId: ThreadId,
  ) => Effect.Effect<OrchestrationV2ThreadProjection, Orchestrator.OrchestratorV2Error>;
  readonly getCheckpointContext: Orchestrator.OrchestratorV2["Service"]["getCheckpointContext"];
  readonly getThreadSnapshot: Orchestrator.OrchestratorV2["Service"]["getThreadSnapshot"];
  readonly getThreadTranscript: (
    threadId: ThreadId,
  ) => Effect.Effect<
    OrchestrationV2ThreadTranscript,
    Orchestrator.OrchestratorV2Error | ThreadTranscriptTooLargeError,
    ServerEnvironment.ServerEnvironmentIdentity
  >;
  readonly getThreadSnapshotWindow: Orchestrator.OrchestratorV2["Service"]["getThreadSnapshotWindow"];
  readonly getProjectThreadRecords: <K extends ProjectionRecordField>(
    input: { readonly projectId: ProjectId; readonly threadId: ThreadId },
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) => Effect.Effect<
    ProjectionRecords<K>,
    ThreadManagementProjectionLoadError | ThreadManagementThreadNotFoundError
  >;
  readonly getProjectThread: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
  }) => Effect.Effect<OrchestrationV2ThreadProjection, ThreadManagementError>;
  readonly getShellSnapshot: Orchestrator.OrchestratorV2["Service"]["getShellSnapshot"];
  readonly readShellSnapshot: (
    options?: ShellSnapshotOptions,
  ) => Effect.Effect<
    Effect.Effect<OrchestrationV2ThreadShellSnapshot, Orchestrator.OrchestratorV2Error>,
    Orchestrator.OrchestratorV2Error
  >;
  readonly getThreadShell: Orchestrator.OrchestratorV2["Service"]["getThreadShell"];
  readonly listProjectThreads: (input: {
    readonly projectId: ProjectId;
    readonly includeSubagents: boolean;
  }) => Effect.Effect<ReadonlyArray<OrchestrationV2ThreadShell>, ThreadManagementError>;
  readonly sendToThread: (
    input: ThreadManagementSendInput,
  ) => Effect.Effect<ThreadManagementSendResult, ThreadManagementFailure>;
  /**
   * Refuses a new turn on an instance the project has effectively disabled.
   * A command that already has a receipt was let through before, so its
   * retry replays instead of being refused under newer settings.
   */
  readonly assertProviderInstanceEnabled: (input: {
    readonly projectId: ProjectId;
    readonly commandId: CommandId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<void, ThreadManagementProviderInstanceDisabledError>;
  /**
   * Effective enablement for candidate selection, without the receipt-replay
   * exemption `assertProviderInstanceEnabled` grants an accepted command.
   */
  readonly isProviderInstanceEnabledForProject: (input: {
    readonly projectId: ProjectId;
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<boolean>;
  /**
   * Whether `commandId` already has a receipt. A caller resolving a target
   * ahead of a dispatch under this same command id can use it to skip
   * project-enablement filtering: the dispatch will only replay the recorded
   * result, never start anything new, so the filter would just refuse a
   * retry the project's settings no longer allow fresh. `acceptedOnly` distinguishes
   * a successful launch claim from a refused claim when reconstructing delivery.
   */
  readonly hasReceipt: (
    commandId: CommandId,
    options?: { readonly acceptedOnly: boolean },
  ) => Effect.Effect<boolean>;
  /** Serializes intake retries, including their attachment claims, for this command ID. */
  readonly withIntakeReceipt: <A, E, R>(
    command: {
      commandId: CommandId;
      threadId: ThreadId;
      type: OrchestrationV2ServerCommand["type"];
    },
    run: (
      accepted: boolean,
      checkAccepted: Effect.Effect<boolean, Orchestrator.OrchestratorDispatchError>,
    ) => Effect.Effect<A, E, R>,
    initialMessageCommandId?: CommandId,
  ) => Effect.Effect<A, E | Orchestrator.OrchestratorDispatchError, R>;
  readonly waitForThreadStartup: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId | null;
    readonly afterSequence: number;
  }) => Effect.Effect<
    {
      readonly startup: "started" | "still starting" | "failed";
      readonly error?: string;
    },
    Orchestrator.OrchestratorV2Error
  >;
  readonly waitForThread: (
    input: ThreadManagementWaitInput,
  ) => Effect.Effect<ThreadManagementWaitResult, ThreadManagementError>;
  /**
   * Waits for `runId` to end, then settles the thread if the run completed.
   * Settling stops the provider session, so an agent that settles its own
   * thread uses this to wait for its turn to end. A run that ends any other
   * way leaves the thread active, as does anything `thread.settle` refuses
   * then, such as a queued message.
   */
  readonly settleAfterRun: (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) => Effect.Effect<void, ThreadManagementFailure>;
  /**
   * Settles a thread. When the thread's own agent asks, it is mid-turn, so
   * the thread settles through `settleAfterRun` once that turn ends.
   */
  readonly updateChatTabs: (input: ChatTabsCommand) => Effect.Effect<void, ChatTabsError>;
  readonly settleThread: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly byOwnAgent: boolean;
  }) => Effect.Effect<
    { readonly sequence: number } | { readonly settlesWhenTurnEnds: true },
    // Dispatches thread.settle, a command the enablement chokepoint never
    // gates; the type stays accurate anyway.
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly interruptThread: (
    input: ThreadManagementInterruptInput,
  ) => Effect.Effect<ThreadManagementInterruptResult, ThreadManagementFailure>;
  /**
   * Asks the provider to stop a running workflow coordinator. The provider's
   * own terminal notification then settles the coordinator and its members.
   */
  readonly stopWorkflow: (
    input: OrchestrationV2StopWorkflowInput,
  ) => Effect.Effect<void, OrchestrationV2StopWorkflowError>;
  /**
   * Moves the requested shell commands or subagents to the background so they
   * can release a waiting steer.
   */
  readonly backgroundToolCall: (
    input: OrchestrationV2BackgroundToolCallInput,
  ) => Effect.Effect<
    OrchestrationV2BackgroundToolCallResult,
    OrchestrationV2BackgroundToolCallError
  >;
  /**
   * Sends `thread.stop` to every delegated task under a thread, depth first. Their command IDs
   * derive from `commandId`, so a retry repeats nothing that already stopped. A task that
   * cannot be stopped does not keep the others running: all are tried, then it fails.
   */
  readonly stopDelegatedTasks: (input: {
    readonly threadId: ThreadId;
    readonly commandId: CommandId;
    readonly reason?: string | undefined;
  }) => Effect.Effect<
    void,
    // Dispatches thread.stop, a command the enablement chokepoint never
    // gates; the type stays accurate anyway.
    Orchestrator.OrchestratorV2Error | ThreadManagementProviderInstanceDisabledError
  >;
  readonly getThreadEventSequence: Orchestrator.OrchestratorV2["Service"]["getThreadEventSequence"];
  readonly recoverDelegatedTask: Orchestrator.OrchestratorV2["Service"]["recoverDelegatedTask"];
  readonly delegatedTaskResultPending: Orchestrator.OrchestratorV2["Service"]["delegatedTaskResultPending"];
  readonly streamStoredEvents: Orchestrator.OrchestratorV2["Service"]["streamStoredEvents"];
  readonly streamStoredEventsFrom: Orchestrator.OrchestratorV2["Service"]["streamStoredEventsFrom"];
  readonly streamDomainEvents: Orchestrator.OrchestratorV2["Service"]["streamDomainEvents"];
}

export class ThreadManagementService extends Context.Service<
  ThreadManagementService,
  ThreadManagementServiceShape
>()("t3/orchestration-v2/ThreadManagementService") {}

export function isActiveRun(run: OrchestrationV2Run): boolean {
  return (
    run.status === "preparing" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

export { isTerminalRunStatus };

export function latestRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  return projection.runs.toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

/** The newest run in `run`'s restart continuation chain, or `run` itself. */
function latestRestartContinuation(
  runs: ReadonlyArray<OrchestrationV2Run>,
  run: OrchestrationV2Run,
): OrchestrationV2Run {
  let current = run;
  for (let hops = 0; hops < runs.length; hops++) {
    const next = runs.find((candidate) => candidate.restartContinuationOfRunId === current.id);
    if (next === undefined) break;
    current = next;
  }
  return current;
}

export function latestActiveRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs">,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(isActiveRun)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

function latestSteerableRun(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
): OrchestrationV2Run | undefined {
  return projection.runs
    .filter(
      (run) =>
        run.status === "running" &&
        run.activeAttemptId !== null &&
        projection.providerTurns.some(
          (turn) => turn.runAttemptId === run.activeAttemptId && turn.status === "running",
        ),
    )
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
}

const SETTLE_AFTER_RUN_WAIT_MS = 24 * 60 * 60 * 1_000;

/**
 * A title set by hand (the user renaming a chat, or an agent asked to) is never replaced by
 * the box namer's retitles; asking to regenerate the title hands it back.
 */
function noteTitleOwner(command: OrchestrationV2ServerCommand) {
  if (command.type !== "thread.metadata.update") return;
  if (command.regenerateTitle === true) boxTitles.clearByHand(command.threadId);
  else if (command.title !== undefined && !command.commandId.startsWith(AUTO_TITLE_COMMAND_PREFIX))
    boxTitles.markByHand(command.threadId);
}

const make = Effect.gen(function* () {
  const chatTabs = Option.getOrElse(
    yield* Effect.serviceOption(ChatTabs.ChatTabs),
    () => ChatTabs.make().store,
  );

  const credentials = yield* Effect.serviceOption(ProviderCredentials.ProviderCredentials);
  const enrichProjection = (projection: OrchestrationV2ThreadProjection) =>
    Option.isSome(credentials)
      ? credentials.value.enrichProjection(projection)
      : Effect.succeed(projection);
  const enrichStored = (stored: OrchestrationV2StoredEvent) =>
    Option.isSome(credentials)
      ? credentials.value
          .enrichEvent(stored.event)
          .pipe(Effect.map((event) => ({ ...stored, event })))
      : Effect.succeed(stored);
  const terminal = yield* Effect.serviceOption(TerminalHandoffState.TerminalHandoffState);
  const threadDispatch = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const layerScope = yield* Effect.scope;
  const legacyImporter = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const comparisonLock = yield* Semaphore.make(1);

  const assertProviderInstanceEnabled: ThreadManagementServiceShape["assertProviderInstanceEnabled"] =
    (input) =>
      serverSettings.getProviderPolicy.pipe(
        Effect.flatMap((current) => assertInstanceEnabled(current, input)),
        // A racing dispatch can commit after the fast path read its receipt.
        // Let the orchestrator replay that decision under the thread lock.
        Effect.catch((error) =>
          receipts.getByCommandId(input.commandId).pipe(
            Effect.orElseSucceed(() => Option.none()),
            Effect.flatMap((receipt) =>
              Option.isSome(receipt)
                ? Effect.void
                : error._tag === "ServerSettingsError"
                  ? Effect.die(error)
                  : Effect.fail(error),
            ),
          ),
        ),
      );

  const isProviderInstanceEnabledForProject: ThreadManagementServiceShape["isProviderInstanceEnabledForProject"] =
    (input) =>
      serverSettings.getProviderPolicy.pipe(
        Effect.orDie,
        Effect.map((current) =>
          resolveProjectProviderInstanceEnabled(current, input.projectId, input.instanceId),
        ),
      );

  const hasReceipt: ThreadManagementServiceShape["hasReceipt"] = (commandId, options) =>
    receipts.getByCommandId(commandId).pipe(
      Effect.orElseSucceed(() => Option.none()),
      Effect.map(
        (receipt) =>
          Option.isSome(receipt) &&
          (options?.acceptedOnly !== true || receipt.value.status === "accepted"),
      ),
    );

  const ensureLegacyTranscript = Effect.fn(
    "orchestrationV2.threadManagement.ensureLegacyTranscript",
  )(function* (threadId: ThreadId) {
    yield* legacyImporter.ensureTranscript(threadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("Unable to hydrate migrated v1 thread transcript", {
          threadId,
          cause,
        }),
      ),
    );
  });

  const ensureProjectionTranscript = (threadId: ThreadId) =>
    ensureLegacyTranscript(threadId).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorProjectionError({
            threadId,
            cause,
          }),
      ),
    );

  const ensureCommandTranscripts = Effect.fn(
    "orchestrationV2.threadManagement.ensureCommandTranscripts",
  )(function* (command: OrchestrationV2ServerCommand) {
    yield* Effect.forEach(
      existingThreadIdsForCommand(command),
      (threadId) => ensureLegacyTranscript(threadId),
      { discard: true },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );
  });

  const getThreadProjection: ThreadManagementServiceShape["getThreadProjection"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadProjection(threadId)),
      Effect.flatMap(enrichProjection),
    );

  const getCheckpointContext: ThreadManagementServiceShape["getCheckpointContext"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getCheckpointContext(threadId)),
    );

  const getThreadSnapshot: ThreadManagementServiceShape["getThreadSnapshot"] = (threadId) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshot(threadId)),
      Effect.flatMap((snapshot) =>
        enrichProjection(snapshot.projection).pipe(
          Effect.map((projection) => ({ ...snapshot, projection })),
        ),
      ),
    );
  const getThreadTranscript = Effect.fn("orchestrationV2.threadManagement.getThreadTranscript")(
    function* (threadId: ThreadId) {
      const { projection } = yield* getThreadSnapshot(threadId);
      const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
      const transcript = {
        threadId: projection.thread.id,
        title: projection.thread.title,
        updatedAt: projection.updatedAt,
        items: projection.visibleTurnItems,
      };
      let sizeBytes = Buffer.byteLength(
        threadTranscriptHeader(yield* environment.getEnvironmentId, transcript),
        "utf8",
      );
      if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
        return yield* new ThreadTranscriptTooLargeError({ threadId });
      }
      for (const row of transcript.items) {
        sizeBytes += projectedRowEncodedBytes(row) + 1;
        if (sizeBytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          return yield* new ThreadTranscriptTooLargeError({ threadId });
        }
      }
      return transcript;
    },
  );
  const getThreadSnapshotWindow: ThreadManagementServiceShape["getThreadSnapshotWindow"] = (
    threadId,
    options,
  ) =>
    ensureProjectionTranscript(threadId).pipe(
      Effect.andThen(orchestrator.getThreadSnapshotWindow(threadId, options)),
      Effect.flatMap((snapshot) =>
        enrichProjection(snapshot.projection).pipe(
          Effect.map((projection) => ({ ...snapshot, projection })),
        ),
      ),
    );

  // Refuse early when the selected account is already disabled. The planner
  // checks again after resolving the actual target under the thread lock.
  const assertDispatchTargetEnabled = (command: OrchestrationV2ServerCommand) => {
    switch (command.type) {
      case "message.dispatch":
        return orchestrator.getThreadRecords(command.threadId, []).pipe(
          Effect.flatMap((projection) =>
            assertProviderInstanceEnabled({
              projectId: projection.thread.projectId,
              commandId: command.commandId,
              instanceId: (command.modelSelection ?? projection.thread.modelSelection).instanceId,
            }),
          ),
        );
      case "delegated_task.request":
        return orchestrator.getThreadRecords(command.parentThreadId, []).pipe(
          Effect.flatMap((parent) =>
            assertProviderInstanceEnabled({
              projectId: parent.thread.projectId,
              commandId: command.commandId,
              instanceId: command.modelSelection.instanceId,
            }),
          ),
        );
      default:
        return Effect.void;
    }
  };

  const readDispatchReceipt = (command: Pick<OrchestrationV2ServerCommand, "type" | "commandId">) =>
    receipts.getByCommandId(command.commandId).pipe(
      Effect.mapError(
        (cause) =>
          new Orchestrator.OrchestratorDispatchError({
            commandId: command.commandId,
            commandType: command.type,
            cause,
          }),
      ),
    );

  const intakeLock = yield* KeyedLock.make<CommandId>();
  const withIntakeReceipt: ThreadManagementServiceShape["withIntakeReceipt"] = (
    command,
    run,
    initialMessageCommandId,
  ) =>
    intakeLock.withLock(
      command.commandId,
      Effect.gen(function* () {
        const accepted = (commandId: CommandId, type: OrchestrationV2ServerCommand["type"]) =>
          Effect.gen(function* () {
            const receipt = yield* readDispatchReceipt({ commandId, type });
            if (Option.isNone(receipt)) return false;
            if (receipt.value.threadId !== command.threadId || receipt.value.commandType !== type) {
              return yield* new Orchestrator.OrchestratorDispatchError({
                commandId,
                commandType: type,
                cause: "Command ID belongs to another thread or command type.",
              });
            }
            return receipt.value.status === "accepted";
          });
        const checkAccepted = accepted(command.commandId, command.type);
        const claimed = yield* checkAccepted;
        // Creating the chat can commit before its first message does.
        const complete =
          claimed &&
          (initialMessageCommandId === undefined ||
            (yield* accepted(initialMessageCommandId, "message.dispatch")));
        return yield* run(complete, checkAccepted);
      }),
    );

  const dispatch: ThreadManagementServiceShape["dispatch"] = (command) => {
    const runCommand = orchestrator.dispatch(command);
    const execute = Effect.gen(function* () {
      yield* ensureCommandTranscripts(command);
      if (command.type !== "message.dispatch" && command.type !== "delegated_task.request")
        return yield* runCommand;
      const receipt = yield* readDispatchReceipt(command);
      if (Option.isSome(receipt)) {
        if (command.type === "message.dispatch" && receipt.value.commandType !== command.type) {
          return yield* new Orchestrator.OrchestratorCommandRejectedError({
            commandId: command.commandId,
            commandType: command.type,
            cause: "Command ID belongs to another command type.",
          });
        }
        return yield* runCommand;
      }
      yield* assertDispatchTargetEnabled(command);
      return yield* runCommand.pipe(
        Effect.provideService(ProjectAdmissionCommandId, command.commandId),
      );
    }).pipe(Effect.tap(() => Effect.sync(() => noteTitleOwner(command))));
    return command.type === "message.dispatch" && Option.isSome(terminal)
      ? terminal.value.withMessageDispatch(command.threadId, execute).pipe(
          // A reconnect can retry an already committed message after Terminal took ownership.
          // The orchestrator validates its receipt and returns the original events.
          Effect.catchTags({
            TerminalHandoffError: (error) =>
              readDispatchReceipt(command).pipe(
                Effect.flatMap((receipt) =>
                  Option.isSome(receipt) &&
                  receipt.value.threadId === command.threadId &&
                  receipt.value.commandType === command.type
                    ? orchestrator.dispatch(command)
                    : Effect.fail(error),
                ),
              ),
          }),
        )
      : execute;
  };

  const getProjectThread: ThreadManagementServiceShape["getProjectThread"] = (input) =>
    getThreadProjection(input.threadId).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectionLoadError({
            projectId: input.projectId,
            threadId: input.threadId,
            cause,
          }),
      ),
      Effect.flatMap((projection) =>
        projection.thread.projectId === input.projectId && projection.thread.deletedAt === null
          ? Effect.succeed(projection)
          : Effect.fail(
              new ThreadManagementThreadNotFoundError({
                projectId: input.projectId,
                threadId: input.threadId,
              }),
            ),
      ),
    );

  const getProjectThreadRecords: ThreadManagementServiceShape["getProjectThreadRecords"] = (
    input,
    fields,
    filter,
  ) =>
    ensureProjectionTranscript(input.threadId)
      .pipe(Effect.andThen(orchestrator.getThreadRecords(input.threadId, fields, filter)))
      .pipe(
        Effect.mapError(
          (cause) =>
            new ThreadManagementProjectionLoadError({
              projectId: input.projectId,
              threadId: input.threadId,
              cause,
            }),
        ),
        Effect.flatMap((projection) =>
          projection.thread.projectId === input.projectId && projection.thread.deletedAt === null
            ? Effect.succeed(projection)
            : Effect.fail(
                new ThreadManagementThreadNotFoundError({
                  projectId: input.projectId,
                  threadId: input.threadId,
                }),
              ),
        ),
      );

  const listProjectThreads: ThreadManagementServiceShape["listProjectThreads"] = (input) =>
    orchestrator.getShellSnapshot({ projectId: input.projectId, location: "active" }).pipe(
      Effect.mapError(
        (cause) =>
          new ThreadManagementProjectThreadsListError({
            projectId: input.projectId,
            cause,
          }),
      ),
      Effect.map((snapshot) =>
        snapshot.threads
          .filter((thread) => !isHelperThreadId(thread.id))
          .filter(
            (thread) =>
              input.includeSubagents || thread.lineage.relationshipToParent !== "subagent",
          )
          .toSorted(
            (left, right) =>
              DateTime.toEpochMillis(right.updatedAt) - DateTime.toEpochMillis(left.updatedAt) ||
              right.id.localeCompare(left.id),
          ),
      ),
    );

  const sendToThread: ThreadManagementServiceShape["sendToThread"] = (input) =>
    Effect.gen(function* () {
      const target = yield* getProjectThreadRecords(input, ["runs", "providerTurns"]);
      if (target.thread.archivedAt !== null) {
        return yield* new ThreadManagementThreadArchivedError({
          threadId: input.threadId,
        });
      }
      const steerableRun = latestSteerableRun(target);
      let dispatchMode: Extract<
        OrchestrationV2Command,
        { readonly type: "message.dispatch" }
      >["dispatchMode"];
      if (input.mode === "steer" || input.mode === "restart") {
        if (
          steerableRun === undefined ||
          (input.expectedRunId !== undefined && steerableRun.id !== input.expectedRunId)
        ) {
          return yield* new ThreadManagementNoSteerableRunError({
            threadId: input.threadId,
            mode: input.mode,
          });
        }
        dispatchMode = {
          type: input.mode === "steer" ? "steer_active" : "restart_active",
          targetRunId: steerableRun.id,
        };
      } else if (input.mode === "auto" && steerableRun !== undefined) {
        dispatchMode = { type: "steer_active", targetRunId: steerableRun.id };
      } else {
        dispatchMode = {
          type: input.mode === "queue" ? "queue_after_active" : "start_immediately",
        };
      }

      const dispatched = yield* dispatch({
        type: "message.dispatch",
        commandId: input.commandId,
        threadId: input.threadId,
        messageId: input.messageId,
        ...(input.scheduledTaskId === undefined ? {} : { scheduledTaskId: input.scheduledTaskId }),
        ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
        ...(input.notifySenderOnCompletion && { notifySenderOnCompletion: true }),
        text: input.text,
        attachments: input.attachments,
        ...(input.steerExistingOnly === true && steerableRun !== undefined
          ? { steerExistingOnly: true, modelSelection: steerableRun.modelSelection }
          : input.modelSelection === undefined
            ? {}
            : { modelSelection: input.modelSelection }),
        ...(input.mode === "auto" ? { deliveryIntent: "auto" as const } : {}),
        ...(input.mode === "queue" ? { explicitQueue: true as const } : {}),
        dispatchMode,
        createdBy: input.createdBy,
        creationSource: input.creationSource,
      });
      const projection = yield* getProjectThreadRecords(input, ["runs", "messages", "turnItems"], {
        messageIds: [input.messageId],
        turnItemTypes: ["user_message"],
      });
      const message = projection.messages.find((candidate) => candidate.id === input.messageId);
      const run =
        message?.runId === null || message?.runId === undefined
          ? undefined
          : projection.runs.find((candidate) => candidate.id === message.runId);
      const turnItem =
        projection.turnItems.find(
          (
            candidate,
          ): candidate is Extract<OrchestrationV2TurnItem, { readonly type: "user_message" }> =>
            candidate.type === "user_message" && candidate.messageId === input.messageId,
        ) ?? null;
      // A queued message's user turn item is deliberately not emitted at
      // dispatch time — it materializes when the queued turn actually starts,
      // so it can map onto the provider turn. Every other dispatch mode still
      // produces its turn item transactionally with the run.
      if (
        message === undefined ||
        run === undefined ||
        (turnItem === null && run.status !== "queued")
      ) {
        return yield* new ThreadManagementDurableRunProjectionError({
          threadId: input.threadId,
          messageId: input.messageId,
        });
      }
      const delivery: ThreadManagementSendResult["delivery"] =
        turnItem === null || turnItem.inputIntent === "queued_turn"
          ? "queued"
          : turnItem.inputIntent === "turn_start"
            ? "started"
            : input.mode === "restart"
              ? "restarted"
              : "steered";
      return { dispatch: dispatched, projection, message, run, turnItem, delivery };
    });

  const waitForThreadStartup: ThreadManagementServiceShape["waitForThreadStartup"] = (input) =>
    Effect.gen(function* () {
      if (input.runId === null) return { startup: "still starting" as const };
      const initial = yield* orchestrator.getThreadShell(input.threadId);
      if (initial?.latestRunId === input.runId) {
        if (initial.status === "failed")
          return {
            startup: "failed" as const,
            error: (initial.lastError ?? "Unknown error").slice(0, 200),
          };
        if (
          initial.status === "completed" ||
          initial.status === "waiting" ||
          initial.createdChatPreview?.trim()
        )
          return { startup: "started" as const };
      }
      // Provider session/turn creation is only a handshake. Wait for actual output or work,
      // so a provider that connects and immediately rejects billing reports its failure here.
      const signal = yield* Stream.merge(
        orchestrator.streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence: input.afterSequence,
          eventType: "run.updated",
        }),
        orchestrator.streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence: input.afterSequence,
          eventType: "turn-item.updated",
        }),
      ).pipe(
        Stream.filter(({ event }) => {
          if (event.type === "run.updated")
            return (
              event.payload.id === input.runId &&
              ["failed", "completed", "waiting", "cancelled", "interrupted"].includes(
                event.payload.status,
              )
            );
          if (event.type !== "turn-item.updated" || event.payload.runId !== input.runId)
            return false;
          const item = event.payload;
          if (item.type === "assistant_message" || item.type === "reasoning")
            return item.text.trim().length > 0;
          // Workspace preparation is server work, not evidence that the provider is alive.
          if (item.providerTurnId === null && item.nativeItemRef === null) return false;
          return [
            "dynamic_tool",
            "command_execution",
            "file_change",
            "file_search",
            "web_search",
            "subagent",
            "user_input_request",
            "approval_request",
          ].includes(item.type);
        }),
        Stream.runHead,
        Effect.timeoutOption("20 seconds"),
      );
      // A failure can race the first output or the timeout. The shell read wins that race.
      const shell = yield* orchestrator.getThreadShell(input.threadId);
      if (shell?.latestRunId === input.runId && shell.status === "failed")
        return {
          startup: "failed" as const,
          error: (shell.lastError ?? "Unknown error").slice(0, 200),
        };
      return {
        startup: Option.isSome(Option.flatten(signal))
          ? ("started" as const)
          : ("still starting" as const),
      };
    });

  const waitForThread: ThreadManagementServiceShape["waitForThread"] = (input) =>
    Effect.gen(function* () {
      const loadError = (cause: unknown) =>
        new ThreadManagementProjectionLoadError({
          projectId: input.projectId,
          threadId: input.threadId,
          cause,
        });
      // Taken before the first read, so a run update between that read and
      // the subscription below still replays.
      const afterSequence = yield* orchestrator
        .getThreadEventSequence(input.threadId)
        .pipe(Effect.mapError(loadError));
      const target = yield* getProjectThreadRecords(input, ["runs"]);
      const selectedRun =
        input.runId === undefined
          ? latestRun(target)
          : target.runs.find((candidate) => candidate.id === input.runId);
      if (input.runId !== undefined && selectedRun === undefined) {
        return yield* new ThreadManagementRunNotFoundError({
          threadId: input.threadId,
          runId: input.runId,
        });
      }
      if (selectedRun === undefined) {
        return { threadId: input.threadId, run: null, timedOut: false };
      }
      // A restart cuts a run and continues it as a new run. Follow that chain,
      // so a cut run is not the answer while its continuation is pending.
      const outcome = (runs: ReadonlyArray<OrchestrationV2Run>) =>
        Effect.gen(function* () {
          const current = runs.find((candidate) => candidate.id === selectedRun.id);
          if (current === undefined) {
            return yield* new ThreadManagementRunNotFoundError({
              threadId: input.threadId,
              runId: selectedRun.id,
            });
          }
          const run = latestRestartContinuation(runs, current);
          const pending =
            isTerminalRunStatus(run.status) &&
            (yield* orchestrator.restartContinuationPending(run));
          return { run, pending, settled: isTerminalRunStatus(run.status) && !pending };
        });
      const initial = yield* outcome(target.runs);
      if (initial.settled) {
        return { threadId: input.threadId, run: initial.run, timedOut: false };
      }

      // Re-read the runs only when the thread records an update to the waited
      // run or a continuation, or its deletion, instead of polling the
      // projection for up to an hour. Each stream keeps one event type, so
      // transcript events never fill its buffer. A declined continuation
      // records no event, so its effect settling wakes the wait too.
      const readOutcome = getProjectThreadRecords(input, ["runs"]).pipe(
        Effect.flatMap((current) => outcome(current.runs)),
      );
      const updates = Stream.merge(
        orchestrator.streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence,
          eventType: "run.updated",
        }),
        orchestrator.streamStoredEventsFrom({
          threadId: input.threadId,
          afterSequence,
          eventType: "thread.deleted",
        }),
      ).pipe(
        Stream.mapError(loadError),
        Stream.filter(
          (stored) =>
            stored.event.type !== "run.updated" ||
            stored.event.payload.id === selectedRun.id ||
            stored.event.payload.restartContinuationOfRunId !== undefined,
        ),
        Stream.mapEffect(() => readOutcome),
      );
      const wait = Stream.concat(Stream.make(initial), updates).pipe(
        Stream.switchMap((current) =>
          current.pending
            ? Stream.fromEffect(
                orchestrator
                  .awaitRestartContinuation(current.run)
                  .pipe(Effect.andThen(readOutcome)),
              )
            : Stream.make(current),
        ),
        Stream.filter((current) => current.settled),
        Stream.runHead,
        Effect.timeoutOption(Duration.millis(Math.max(1, input.timeoutMs))),
      );
      const waited = Option.flatten(yield* wait);
      if (Option.isSome(waited)) {
        return { threadId: input.threadId, run: waited.value.run, timedOut: false };
      }
      // The run may have reached a terminal status while the timeout was
      // winning the race; the final projection read decides what actually
      // happened, so only a still-active run counts as timed out.
      const final = yield* outcome((yield* getProjectThreadRecords(input, ["runs"])).runs);
      return { threadId: input.threadId, run: final.run, timedOut: !final.settled };
    });

  const settleAfterRun: ThreadManagementServiceShape["settleAfterRun"] = Effect.fn(
    "orchestrationV2.threadManagement.settleAfterRun",
  )(function* (input) {
    // A turn that outlives this wait leaves its thread active.
    const { run } = yield* waitForThread({ ...input, timeoutMs: SETTLE_AFTER_RUN_WAIT_MS });
    if (run?.status !== "completed") return;
    yield* dispatch({
      type: "thread.settle",
      commandId: CommandId.make(`server:settle-after-run:${input.runId}`),
      threadId: input.threadId,
    });
  });

  const settleThread: ThreadManagementServiceShape["settleThread"] = Effect.fn(
    "orchestrationV2.threadManagement.settleThread",
  )(function* (input) {
    const shell = input.byOwnAgent ? yield* orchestrator.getThreadShell(input.threadId) : null;
    if (shell != null && shell.activeRunId !== null) {
      yield* settleAfterRun({
        projectId: shell.projectId,
        threadId: shell.id,
        runId: shell.activeRunId,
      }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(layerScope));
      return { settlesWhenTurnEnds: true } as const;
    }
    const result = yield* dispatch({
      type: "thread.settle",
      commandId: input.commandId,
      threadId: input.threadId,
    });
    return { sequence: result.sequence };
  });

  const updateChatTabs: ThreadManagementServiceShape["updateChatTabs"] = Effect.fn(
    "orchestrationV2.threadManagement.updateChatTabs",
  )(
    function* (input) {
      if (input.action === "continue-comparison") {
        const group = chatTabs.comparisonById(input.comparisonId);
        if (group === null || !group.threadIds.includes(input.threadId)) {
          return yield* new ChatTabsError({ message: "This comparison is no longer available." });
        }
        const selected = yield* orchestrator.getThreadShell(input.threadId);
        if (selected === null || selected.deletedAt != null || selected.archivedAt != null) {
          return yield* new ChatTabsError({
            message: "This chat is unavailable. Choose another chat to continue.",
          });
        }
        // Keep membership until every other chat has settled, so failures remain reachable
        // and continuation can be retried from any client. No chat or worktree is deleted.
        for (const threadId of group.threadIds.filter((id) => id !== input.threadId)) {
          const records = yield* orchestrator.getThreadRecords(threadId, [
            "runs",
            "runtimeRequests",
          ]);
          if (records.thread.deletedAt != null || records.thread.archivedAt != null) continue;
          const commandPrefix = `comparison:${group.id}:${threadId}`;
          for (const run of records.runs.filter((run) => run.status === "queued")) {
            yield* dispatch({
              type: "queued-run.cancel",
              commandId: CommandId.make(`${commandPrefix}:cancel:${run.id}`),
              threadId,
              runId: run.id,
            });
          }
          for (const request of records.runtimeRequests.filter(
            (request) => request.status === "pending",
          )) {
            yield* dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make(`${commandPrefix}:respond:${request.id}`),
              threadId,
              requestId: request.id,
              decision: "cancel",
            });
          }
          const active = records.runs.findLast((run) =>
            ["preparing", "starting", "running", "waiting"].includes(run.status),
          );
          if (active) {
            yield* dispatch({
              type: "run.interrupt",
              commandId: CommandId.make(`${commandPrefix}:stop:${active.id}`),
              threadId,
              runId: active.id,
              holdQueue: true,
              reason: "Continued with another comparison chat.",
            });
            const outcome = yield* waitForThread({
              projectId: records.thread.projectId,
              threadId,
              runId: active.id,
              timeoutMs: 30_000,
            });
            if (outcome.timedOut)
              return yield* new ChatTabsError({
                message: "A chat is still stopping. Try again in a moment.",
              });
          }
          yield* settleThread({
            threadId,
            commandId: CommandId.make(
              `${commandPrefix}:settle:${DateTime.toEpochMillis(records.thread.updatedAt)}`,
            ),
            byOwnAgent: false,
          });
        }
        const chosen = yield* orchestrator.getThreadShell(input.threadId);
        if (chosen === null || chosen.deletedAt != null || chosen.archivedAt != null) {
          return yield* new ChatTabsError({
            message: "This chat is unavailable. Choose another chat to continue.",
          });
        }
        if (chosen.settledAt != null) {
          yield* dispatch({
            type: "thread.unsettle",
            commandId: CommandId.make(
              `comparison:${group.id}:continue:${input.threadId}:${DateTime.toEpochMillis(chosen.updatedAt)}`,
            ),
            threadId: input.threadId,
            reason: "user",
          });
        }
        chatTabs.endComparison(group.id);
        return;
      }
      const ids =
        input.action === "move"
          ? input.threadIds
          : input.action === "compare"
            ? input.comparison.threadIds
            : [];
      const shells = (yield* Effect.forEach(ids, (id) => orchestrator.getThreadShell(id), {
        concurrency: 4,
      })).filter((shell) => shell !== null);
      if (input.action === "compare" && shells.length !== ids.length)
        return yield* new ChatTabsError({
          message: "A comparison chat is unavailable. Try again in a moment.",
        });
      if (input.action === "compare" && new Set(shells.map((shell) => shell.projectId)).size !== 1)
        return yield* new ChatTabsError({ message: "Comparison chats must use the same folder." });
      const titles = new Map(shells.map((shell) => [shell.id, shell.title]));
      yield* chatTabs.command(input, {
        titleOf: (id) => titles.get(ThreadId.make(id)) ?? null,
        now: DateTime.toEpochMillis(yield* DateTime.now),
      });
    },
    comparisonLock.withPermits(1),
    Effect.mapError((error) =>
      isChatTabsError(error)
        ? error
        : new ChatTabsError({
            message: "Could not update the comparison or chat tab. Your chats are still saved.",
            cause: error,
          }),
    ),
  );

  const interruptThread: ThreadManagementServiceShape["interruptThread"] = (input) =>
    Effect.gen(function* () {
      const target = yield* getProjectThreadRecords(input, ["runs", "providerTurns"]);
      const explicitRun =
        input.runId === undefined
          ? undefined
          : target.runs.find((candidate) => candidate.id === input.runId);
      if (input.runId !== undefined && explicitRun === undefined) {
        return yield* new ThreadManagementRunNotFoundError({
          threadId: input.threadId,
          runId: input.runId,
        });
      }
      if (explicitRun !== undefined && isTerminalRunStatus(explicitRun.status)) {
        return {
          type: "already_terminal",
          run: explicitRun as OrchestrationV2Run & {
            readonly status: ThreadManagementTerminalRunStatus;
          },
        } as const;
      }
      const interruptibleRun = latestActiveRun(target);
      if (interruptibleRun === undefined) {
        if (input.runId === undefined) {
          return { type: "no_active_run" } as const;
        }
        return yield* new ThreadManagementThreadNotInterruptibleError({
          threadId: input.threadId,
          runId: input.runId,
        });
      }
      if (input.runId !== undefined && interruptibleRun.id !== input.runId) {
        return yield* new ThreadManagementThreadNotInterruptibleError({
          threadId: input.threadId,
          runId: input.runId,
        });
      }
      const dispatch = yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: input.commandId,
        threadId: input.threadId,
        runId: interruptibleRun.id,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      });
      const signal = dispatch.storedEvents.find(
        ({ event }) =>
          event.threadId === input.threadId &&
          event.type === "turn-item.updated" &&
          event.payload.type === "run_interrupt_request",
      );
      // A retried interrupt can replay the receipt of an earlier turn.
      const run =
        signal === undefined || signal.event.runId === interruptibleRun.id
          ? interruptibleRun
          : (target.runs.find((candidate) => candidate.id === signal.event.runId) ??
            interruptibleRun);
      if (isTerminalRunStatus(run.status)) {
        return { type: "already_terminal", run: { ...run, status: run.status } } as const;
      }
      return { type: "interrupt_requested", run, dispatch } as const;
    });

  const stopWorkflow: ThreadManagementServiceShape["stopWorkflow"] = (input) =>
    Effect.gen(function* () {
      const records = yield* orchestrator
        .getThreadRecords(input.threadId, ["subagents", "runs", "providerThreads"])
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (records.thread.deletedAt !== null) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      // A limited caller (an agent over MCP) may not stop work on a thread
      // running above its own modes. Checked under the thread lock, where the
      // thread's user cannot raise the modes between this read and the stop.
      const limit = yield* DispatchModeLimit;
      const exceeded =
        limit === undefined ? undefined : exceededDispatchModeLimit(limit, records.thread);
      if (limit !== undefined && exceeded !== undefined) {
        if (limit.refused !== undefined) {
          yield* Ref.set(limit.refused, {
            threadId: input.threadId,
            runtimeMode: records.thread.runtimeMode,
            interactionMode: records.thread.interactionMode,
            mode: exceeded,
          });
        }
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const task = records.subagents.find((candidate) => candidate.id === input.subagentId);
      if (
        task === undefined ||
        task.threadId !== input.threadId ||
        task.workflow === undefined ||
        task.status !== "running"
      ) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "not-running" });
      }
      if (
        task.remote !== undefined ||
        task.origin !== "provider_native" ||
        task.driver !== "claudeAgent"
      ) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      const providerThreadId =
        task.providerThreadId ??
        records.runs.find((run) => run.id === task.runId)?.providerThreadId;
      const providerThread = records.providerThreads.find(
        (candidate) =>
          candidate.id === providerThreadId &&
          candidate.appThreadId === input.threadId &&
          candidate.providerInstanceId === task.providerInstanceId &&
          candidate.driver === task.driver,
      );
      const taskId = task.nativeTaskRef?.nativeId;
      if (providerThread?.providerSessionId == null || taskId == null || taskId.length === 0) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      const runtime = yield* sessions
        .get(providerThread.providerSessionId)
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable", cause }),
          ),
        );
      if (Option.isNone(runtime)) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unavailable" });
      }
      if (runtime.value.stopTask === undefined) {
        return yield* new OrchestrationV2StopWorkflowError({ ...input, reason: "unsupported" });
      }
      // Bounded so a provider that never answers cannot hold the thread lock.
      yield* runtime.value.stopTask({ providerThread, taskId }).pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError(
          (cause) =>
            new OrchestrationV2StopWorkflowError({
              ...input,
              reason: "stop-failed",
              cause,
            }),
        ),
      );
    }).pipe((effect) => threadDispatch.withLock(input.threadId, effect));

  const backgroundToolCall: ThreadManagementServiceShape["backgroundToolCall"] = (input) =>
    Effect.gen(function* () {
      const { threadId, turnItemId, additionalTurnItemIds } = input;
      const batch =
        additionalTurnItemIds === undefined ? undefined : { handledBatch: true as const };
      const fail = (
        itemId: TurnItemId,
        reason: OrchestrationV2BackgroundToolCallError["reason"],
        cause?: unknown,
      ) =>
        new OrchestrationV2BackgroundToolCallError({
          threadId,
          turnItemId: itemId,
          reason,
          ...batch,
          ...(cause === undefined ? {} : { cause }),
        });
      const records = yield* orchestrator
        .getThreadRecords(threadId, ["providerThreads"])
        .pipe(Effect.mapError((cause) => fail(turnItemId, "unavailable", cause)));
      if (records.thread.deletedAt !== null) return yield* fail(turnItemId, "unavailable");

      const move = Effect.fnUntraced(function* (itemId: TurnItemId) {
        const item = yield* orchestrator
          .getTurnItem({ threadId, itemId })
          .pipe(Effect.mapError((cause) => fail(itemId, "unavailable", cause)));
        if (
          item === null ||
          (item.type !== "command_execution" && item.type !== "subagent") ||
          item.status !== "running"
        ) {
          return false;
        }
        const toolUseId = item.nativeItemRef?.nativeId;
        const providerThread = records.providerThreads.find(
          (candidate) =>
            candidate.id === item.providerThreadId && candidate.appThreadId === threadId,
        );
        if (
          providerThread?.providerSessionId == null ||
          toolUseId == null ||
          toolUseId.length === 0
        ) {
          return yield* fail(itemId, "unavailable");
        }
        const runtime = yield* sessions
          .get(providerThread.providerSessionId)
          .pipe(Effect.mapError((cause) => fail(itemId, "unavailable", cause)));
        if (Option.isNone(runtime)) return yield* fail(itemId, "unavailable");
        if (runtime.value.backgroundToolCall === undefined)
          return yield* fail(itemId, "unsupported");
        // Claude can finish one call before it publishes the results of the whole batch.
        return yield* runtime.value.backgroundToolCall({ providerThread, toolUseId }).pipe(
          Effect.timeout("15 seconds"),
          Effect.mapError((cause) => fail(itemId, "failed", cause)),
        );
      });

      if (additionalTurnItemIds === undefined) {
        if (!(yield* move(turnItemId))) return yield* fail(turnItemId, "not-running");
        return;
      }
      const [moved, failures] = yield* Effect.partition(
        new Set([turnItemId, ...additionalTurnItemIds]),
        move,
        { concurrency: "unbounded" },
      );
      const failure = failures[0];
      if (!moved.includes(true) && failure !== undefined) return yield* failure;
      return batch;
    }).pipe((effect) => threadDispatch.withLock(input.threadId, effect));

  const ownership = yield* ExecutionResources.ExecutionResources;
  const stopDelegatedTasks: ThreadManagementServiceShape["stopDelegatedTasks"] = (input) =>
    ownership
      .stopOwned({ ...input, kind: "subagent" })
      .pipe(
        Effect.mapError(
          (cause) =>
            new Orchestrator.OrchestratorProjectionError({ threadId: input.threadId, cause }),
        ),
      );

  return ThreadManagementService.of({
    ensureLegacyTranscript,
    searchThreadStream: (input) =>
      Stream.unwrap(
        ensureProjectionTranscript(input.threadId).pipe(
          Effect.as(orchestrator.searchThreadStream(input)),
        ),
      ),
    searchThread: (input) =>
      ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.searchThread(input)),
      ),
    dispatch,
    getThreadHistoryPage: (threadId, cursor, throughEntryId, conversationOnly) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(
          orchestrator.getThreadHistoryPage(threadId, cursor, throughEntryId, conversationOnly),
        ),
      ),
    getThreadMediaPage: (threadId, cursor) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getThreadMediaPage(threadId, cursor)),
      ),
    getTimelinePage: (threadId, options) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getTimelinePage(threadId, options)),
      ),
    getMessageCount: (threadId) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getMessageCount(threadId)),
      ),
    getTurnItem: (input) =>
      ensureProjectionTranscript(input.threadId).pipe(
        Effect.andThen(orchestrator.getTurnItem(input)),
        Effect.map((item) => ({ item: item === null ? null : projectTurnItemForDetail(item) })),
      ),
    getThreadRecords: (threadId, fields, filter) =>
      ensureProjectionTranscript(threadId).pipe(
        Effect.andThen(orchestrator.getThreadRecords(threadId, fields, filter)),
      ),
    getThreadProjection,
    getCheckpointContext,
    getThreadSnapshot,
    getThreadTranscript,
    getThreadSnapshotWindow,
    getProjectThreadRecords,
    getProjectThread,
    getShellSnapshot: orchestrator.getShellSnapshot,
    readShellSnapshot: orchestrator.readShellSnapshot,
    getThreadShell: orchestrator.getThreadShell,
    listProjectThreads,
    sendToThread,
    assertProviderInstanceEnabled,
    isProviderInstanceEnabledForProject,
    hasReceipt,
    withIntakeReceipt,
    waitForThreadStartup,
    waitForThread,
    settleAfterRun,
    settleThread,
    updateChatTabs,
    interruptThread,
    stopDelegatedTasks,
    stopWorkflow,
    backgroundToolCall,
    getThreadEventSequence: orchestrator.getThreadEventSequence,
    recoverDelegatedTask: orchestrator.recoverDelegatedTask,
    delegatedTaskResultPending: orchestrator.delegatedTaskResultPending,
    streamStoredEvents: orchestrator.streamStoredEvents.pipe(Stream.mapEffect(enrichStored)),
    streamStoredEventsFrom: (input) =>
      orchestrator.streamStoredEventsFrom(input).pipe(Stream.mapEffect(enrichStored)),
    streamDomainEvents: orchestrator.streamDomainEvents,
  });
});

const layerLegacyV1ThreadImporterNoop = Layer.succeed(
  LegacyV1ThreadImporter.LegacyV1ThreadImporter,
  LegacyV1ThreadImporter.LegacyV1ThreadImporter.of({
    pendingThreadCount: Effect.succeed(0),
    reconcileShells: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    ensureTranscript: () => Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
    importPendingTranscripts: Effect.succeed({ importedThreadCount: 0, importedMessageCount: 0 }),
  }),
);

export const layer: Layer.Layer<
  ThreadManagementService,
  never,
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ServerSettings.ServerSettingsService
  | CommandReceiptStore.CommandReceiptStoreV2
> = Layer.effect(ThreadManagementService, make).pipe(
  Layer.provide(layerLegacyV1ThreadImporterNoop),
  Layer.provide(ThreadCommandExecutor.layer),
  Layer.provide(ExecutionResources.layer),
);

export const layerWithLegacyImporter: Layer.Layer<
  ThreadManagementService,
  never,
  | LegacyV1ThreadImporter.LegacyV1ThreadImporter
  | Orchestrator.OrchestratorV2
  | ProviderSessionManager.ProviderSessionManagerV2
  | ServerSettings.ServerSettingsService
  | CommandReceiptStore.CommandReceiptStoreV2
> = Layer.effect(ThreadManagementService, make).pipe(
  Layer.provide(ThreadCommandExecutor.layer),
  Layer.provide(ExecutionResources.layer),
);
