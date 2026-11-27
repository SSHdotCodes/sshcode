import { accountAcceptsModel, accountPool } from "@t3tools/shared/accountBalance";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  type ChatAttachment,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  type OrchestrationV2ProviderThreadNativeMetadata,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2StartSubagentInput,
  type OrchestrationV2StartSubagentResult,
  OrchestrationV2StartSubagentError,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2WorkspacePreparation,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  ProjectId,
  type RunId,
  type RuntimeMode,
  type ScheduledTaskId,
  ThreadId,
  activeProviderFailure,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import {
  buildTemporaryWorktreeBranchName,
  flattenTemporaryWorktreeBranchName,
  isTemporaryWorktreeBranch,
  WORKTREE_BRANCH_PREFIX,
} from "@t3tools/shared/git";

import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as WarmWorktreePool from "../project/WarmWorktreePool.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { accountUnavailable } from "../provider/accountAvailability.ts";
import { isUsageLimitReadingStale } from "../provider/usageLimitFreshness.ts";
import { preferSiblingAccount } from "../provider/siblingAccount.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as Orchestrator from "./Orchestrator.ts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";

export type ThreadLaunchWorkspaceStrategy =
  | { readonly type: "root"; readonly branch?: string | undefined }
  | {
      readonly type: "existing_worktree";
      readonly worktreePath: string;
      readonly branch?: string | undefined;
    }
  | {
      readonly type: "worktree";
      readonly baseRef: string;
      readonly branch?: string | undefined;
      readonly startFromOrigin?: boolean | undefined;
    };

export interface ThreadLaunchInitialMessage {
  /** Scheduled drafts fall back to normal delivery if another send gets there first. */
  readonly deliveryIntent?: "auto";
  readonly messageId?: MessageId;
  readonly scheduledTaskId?: ScheduledTaskId;
  readonly senderThreadId?: ThreadId;
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly context?: import("@t3tools/contracts").OrchestrationMessageContext | undefined;
}

export interface ThreadLaunchInput {
  readonly commandId: CommandId;
  readonly threadId?: ThreadId;
  readonly reuseExistingThread?: boolean;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly generateTitle?: boolean;
  readonly modelSelection: ModelSelection;
  /**
   * For launches nobody is watching (a schedule): when the selection's account is nearly out
   * of its limit for the model, or refusing work on one, and the user's other account of the
   * same provider has room, start there. A chat the user starts keeps the account they picked.
   */
  readonly preferAccountWithRoom?: boolean;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
  readonly workspaceStrategy: ThreadLaunchWorkspaceStrategy;
  readonly initialMessage?: ThreadLaunchInitialMessage;
  readonly importedNativeThread?: {
    readonly ref: {
      readonly driver: ProviderDriverKind;
      readonly nativeId: string;
      readonly strength: "strong";
    };
    readonly metadata?: OrchestrationV2ProviderThreadNativeMetadata;
  };
  readonly createdBy: OrchestrationV2Actor;
  readonly creationSource: OrchestrationV2CreationSource;
}

/** What workspace preparation reads from a launch; a retry rebuilds it from the run. */
type PreparationInput = Pick<ThreadLaunchInput, "commandId" | "projectId" | "initialMessage"> & {
  readonly workspaceStrategy: OrchestrationV2WorkspacePreparation;
  /**
   * Set when a retry reuses the worktree its failed attempt created and
   * recorded. Its setup is tracked like a new one, but the thread already
   * records the workspace, and a branch rename may still be running.
   */
  readonly reusedWorktree?: { readonly baseRef: string; readonly sourcePath?: string | undefined };
  /** Start the agent only after a new worktree's setup script exits, even an async one. */
  readonly holdForSetup?: boolean;
};

export interface ThreadLaunchPreparationInput {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}

export interface ThreadLaunchResult {
  readonly threadId: ThreadId;
  readonly projection: OrchestrationV2ThreadProjection;
  readonly resumed: boolean;
}

export class ThreadLaunchError extends Schema.TaggedError<ThreadLaunchError>()(
  "ThreadLaunchError",
  {
    operation: Schema.Literals([
      "resolve-project",
      "read-receipt",
      "generate-metadata",
      "provision-worktree",
      "run-setup-script",
      "create-thread",
      "update-thread",
      "dispatch-message",
      "release-run",
      "fail-run",
    ]),
    commandId: CommandId,
    projectId: ProjectId,
    threadId: Schema.optional(ThreadId),
    notAccepted: Schema.optionalKey(Schema.Literal(true)),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread launch ${this.commandId} failed during ${this.operation}.`;
  }
}

/** A new worktree was asked to start from a ref that gives it no commit. */
export class ThreadLaunchBaseRefError extends Schema.TaggedError<ThreadLaunchBaseRefError>()(
  "ThreadLaunchBaseRefError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    workspaceRoot: Schema.String,
    baseRef: Schema.String,
  },
) {
  override get message(): string {
    return `Base ref "${this.baseRef}" does not resolve to a commit in project "${this.projectTitle}" (${this.workspaceRoot}).`;
  }
}

export class ThreadLaunchService extends Context.Service<
  ThreadLaunchService,
  {
    readonly launch: (
      input: ThreadLaunchInput,
    ) => Effect.Effect<
      ThreadLaunchResult,
      ThreadLaunchError | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
    /**
     * Fails when a new worktree's base ref cannot give provisioning a commit.
     * `launch` accepts such a launch and reports the failure inside the
     * thread; a caller that needs it before a thread exists checks first.
     */
    readonly checkWorktreeBase: (
      input: Pick<PreparationInput, "projectId" | "workspaceStrategy">,
    ) => Effect.Effect<void, ThreadLaunchBaseRefError>;
    /** True only when the project's folder is known not to be a Git repository. */
    readonly isNonGitProject: (projectId: ProjectId) => Effect.Effect<boolean>;
    /** Dispatches prepared-run.retry and prepares the run's workspace again. */
    readonly retryPreparation: (input: ThreadLaunchPreparationInput) => Effect.Effect<
      Orchestrator.OrchestratorV2DispatchResult,
      // Dispatches prepared-run.retry, a command the enablement chokepoint
      // never gates; the type stays accurate anyway.
      | Orchestrator.OrchestratorV2Error
      | ThreadManagement.ThreadManagementProviderInstanceDisabledError
    >;
    readonly prepareRun: (input: ThreadLaunchPreparationInput) => Effect.Effect<void>;
    /**
     * The user starts a subagent in a lead chat on the model they picked. The lead gets the
     * card and the result; nothing is added to the lead's instructions or tools.
     */
    readonly startUserSubagent: (
      input: OrchestrationV2StartSubagentInput,
    ) => Effect.Effect<OrchestrationV2StartSubagentResult, OrchestrationV2StartSubagentError>;
  }
>()("t3/orchestration-v2/ThreadLaunchService") {}

/** How many of the lead's latest subagents are asked where they worked. */
const SIBLING_REPOSITORY_LOOKBACK = 3;

/** Newest first: the subagents the lead (or the user) started in this chat. */
export function latestAppOwnedSubagents(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
  limit: number,
): ReadonlyArray<OrchestrationV2Subagent> {
  const started = (task: OrchestrationV2Subagent) =>
    DateTime.toEpochMillis(task.startedAt ?? task.updatedAt);
  return subagents
    .filter((task) => task.origin === "app_owned" && task.childThreadId !== null)
    .sort((left, right) => started(right) - started(left))
    .slice(0, limit);
}

export const initialMessageCommandId = (launchCommandId: CommandId) =>
  CommandId.make(`${launchCommandId}:initial-message`);

const isThreadLaunchError = Schema.is(ThreadLaunchError);

function failureDetail(error: unknown): string {
  if (isThreadLaunchError(error)) {
    const cause = error.cause;
    const detail = cause instanceof Error ? cause.message : String(cause);
    return `Workspace preparation failed during ${error.operation.replaceAll("-", " ")}: ${detail}`;
  }
  return `Workspace preparation failed: ${error instanceof Error ? error.message : String(error)}`;
}

function errorText(error: unknown): string {
  const cause = isThreadLaunchError(error) ? error.cause : error;
  return cause instanceof Error ? cause.message : String(cause);
}

/** How long a subagent waits for its worktree's setup before starting anyway. */
const SUBAGENT_SETUP_TIMEOUT = "10 minutes";
/**
 * Subagent setups of one repository share its disk and CPU, so concurrent installs all
 * finish together: on 2026-11-25 six took 205-230 s each where one alone took about 40 s,
 * and no child started for four minutes. Two at a time starts the first children in about
 * a minute without one stuck setup holding up the rest.
 */
const SUBAGENT_SETUPS_PER_REPOSITORY = 2;

/** Told to the subagent on its first prompt, so missing dependencies are no surprise. */
const setupFailureNotice = (reason: string) =>
  `Project setup ${reason}; dependencies may be missing.`;

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const setupTracker = yield* WorktreeSetupTracker.WorktreeSetupTracker;
  const cloneTracker = yield* ProjectCloneTracker.ProjectCloneTracker;
  const terminals = yield* TerminalManager.TerminalManager;
  const git = yield* GitWorkflow.GitWorkflowService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const warmWorktrees = yield* WarmWorktreePool.WarmWorktreePool;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const preparationScope = yield* Scope.make("sequential");
  const scheduledLaunches = yield* Ref.make<ReadonlySet<CommandId>>(new Set());
  yield* Effect.addFinalizer(() => Scope.close(preparationScope, Exit.void));
  const subagentSetupGates = new Map<string, Semaphore.Semaphore>();
  const subagentSetupGate = (repository: string) => {
    let gate = subagentSetupGates.get(repository);
    if (gate === undefined) {
      gate = Semaphore.makeUnsafe(SUBAGENT_SETUPS_PER_REPOSITORY);
      subagentSetupGates.set(repository, gate);
    }
    return gate;
  };

  const mapError =
    (
      input: PreparationInput,
      operation: ThreadLaunchError["operation"],
      threadId?: ThreadId,
      notAccepted?: true,
    ) =>
    (cause: unknown) =>
      new ThreadLaunchError({
        operation,
        ...(notAccepted ? { notAccepted } : {}),
        commandId: input.commandId,
        projectId: input.projectId,
        ...(threadId === undefined ? {} : { threadId }),
        cause,
      });

  const readReceipt = (input: ThreadLaunchInput, commandId: CommandId) =>
    receipts
      .getByCommandId(commandId)
      .pipe(Effect.mapError(mapError(input, "read-receipt", input.threadId)));

  const withAccountWithRoom = (input: ThreadLaunchInput) =>
    Effect.gen(function* () {
      if (input.preferAccountWithRoom !== true) return input;
      // A launch that already has a receipt replays what it recorded, the account included:
      // the chat may have been created on another account before the first attempt stopped,
      // and its first message must not start on the one that was asked for.
      const receipt = yield* receipts.getByCommandId(input.commandId);
      if (Option.isSome(receipt)) {
        if (receipt.value.status !== "accepted") return input;
        const recorded = (yield* threads.getThreadProjection(receipt.value.threadId)).thread
          .modelSelection;
        return recorded.model === input.modelSelection.model &&
          recorded.instanceId !== input.modelSelection.instanceId
          ? {
              ...input,
              modelSelection: { ...input.modelSelection, instanceId: recorded.instanceId },
            }
          : input;
      }
      const settings = yield* serverSettings.getSettings;
      if (!settings.balanceAccounts) return input;
      const cached = yield* providerRegistry.getProviders;
      const acceptsModel = accountAcceptsModel(settings, input.projectId);
      const accepts = (provider: (typeof cached)[number]) =>
        acceptsModel(provider, input.modelSelection.model);
      const pool = accountPool(cached, input.modelSelection, accepts);
      if (pool.length === 0) return input;
      const checkedAt = yield* Clock.currentTimeMillis;
      const stale = pool.some(
        (provider) =>
          provider.usageLimits &&
          isUsageLimitReadingStale(provider.driver, provider.usageLimits, checkedAt),
      );
      // Unattended work can wake up to yesterday's readings. The registry coalesces
      // probes and bounds the wait for the whole pool, even if a provider hangs.
      const providers = stale
        ? yield* providerRegistry.getProvidersForUsageLimits(
            pool.map((provider) => provider.instanceId),
          )
        : cached;
      const current = providers.find(
        (provider) => provider.instanceId === input.modelSelection.instanceId,
      );
      if (!current) return input;
      const now = stale ? yield* Clock.currentTimeMillis : checkedAt;
      const blocked = accountUnavailable(current, now, input.modelSelection.model);
      const refusal = activeProviderFailure(current, now, input.modelSelection.model)?.kind;
      // A usage limit and a sign-out are routed around; other account trouble is reported as
      // it is.
      if (
        blocked !== undefined &&
        refusal !== "authentication_error" &&
        (blocked.recheckAt === undefined || refusal !== "usage_limit")
      )
        return input;
      const candidates: Array<(typeof providers)[number]> = [];
      for (const candidate of stale
        ? accountPool(providers, input.modelSelection, accepts)
        : pool) {
        if (
          candidate.instanceId === current.instanceId ||
          accountUnavailable(candidate, now, input.modelSelection.model) !== undefined
        )
          continue;
        if (
          yield* threads.isProviderInstanceEnabledForProject({
            projectId: input.projectId,
            instanceId: candidate.instanceId,
          })
        )
          candidates.push(candidate);
      }
      const moved = preferSiblingAccount({
        current,
        candidates,
        model: input.modelSelection.model,
        options: input.modelSelection.options,
        accepts,
        limitReached: blocked !== undefined && refusal === "usage_limit",
        balance: settings.balanceAccounts,
        now,
      });
      if (moved === undefined) return input;
      yield* Effect.logInfo(moved.notice, { commandId: input.commandId });
      return {
        ...input,
        modelSelection: { ...input.modelSelection, instanceId: moved.provider.instanceId },
      };
      // Choosing an account must never be what stops a launch.
    }).pipe(Effect.catchCause(() => Effect.succeed(input)));

  const validateReusableThread = Effect.fn("ThreadLaunchService.validateReusableThread")(function* (
    input: ThreadLaunchInput,
    threadId: ThreadId,
  ) {
    const projection = yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
    if (
      projection.thread.projectId !== input.projectId ||
      projection.thread.archivedAt !== null ||
      projection.thread.deletedAt !== null ||
      (yield* threads
        .getMessageCount(threadId)
        .pipe(Effect.mapError(mapError(input, "update-thread", threadId)))) > 0 ||
      projection.runs.length > 0
    ) {
      return yield* mapError(
        input,
        "update-thread",
        threadId,
      )("Only an empty active thread in the target project can change workspace during launch.");
    }
  });

  const checkWorktreeBase: ThreadLaunchService["Service"]["checkWorktreeBase"] = Effect.fn(
    "ThreadLaunchService.checkWorktreeBase",
  )(function* (input) {
    const strategy = input.workspaceStrategy;
    // `:/text` is a commit search, which cannot be asked for a commit type.
    if (strategy.type !== "worktree" || strategy.baseRef.startsWith(":")) return;
    const { baseRef } = strategy;
    // Anything this cannot establish is left for the launch to report: a
    // missing project, a folder that is not a repository, a failing Git.
    const unresolved = yield* Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
      if (project === undefined) return undefined;
      const cwd = strategy.sourcePath ?? project.workspaceRoot;
      // `git worktree add` reads `-` as the previous checkout.
      if (yield* git.hasCommit({ cwd, refName: baseRef === "-" ? "@{-1}" : baseRef }))
        return undefined;
      // Provisioning fetches the base from origin when it can, and runs a
      // repository with no commits yet without a worktree.
      if (
        strategy.startFromOrigin === true &&
        (yield* git.remoteExists({ cwd, remoteName: "origin" }))
      )
        return undefined;
      // `git worktree add` also starts from a remote-tracking branch of that
      // name; any ref carrying it is reason enough to let Git decide.
      if (yield* git.hasRefNamed({ cwd, refName: baseRef })) return undefined;
      return (yield* git.hasCommit({ cwd, refName: "HEAD" }))
        ? { ...project, workspaceRoot: cwd }
        : undefined;
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (unresolved !== undefined)
      return yield* new ThreadLaunchBaseRefError({
        projectId: unresolved.id,
        projectTitle: unresolved.title,
        workspaceRoot: unresolved.workspaceRoot,
        baseRef,
      });
  });

  const prepareInBackground = Effect.fn("ThreadLaunchService.prepareInBackground")(function* (
    input: PreparationInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const project = yield* projects.getById(input.projectId).pipe(
      Effect.mapError(mapError(input, "resolve-project", threadId)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(mapError(input, "resolve-project", threadId)("Project no longer exists.")),
          onSome: Effect.succeed,
        }),
      ),
    );

    const reused = input.reusedWorktree;
    const sourceCwd =
      input.workspaceStrategy.type === "worktree"
        ? (input.workspaceStrategy.sourcePath ?? project.workspaceRoot)
        : (reused?.sourcePath ?? project.workspaceRoot);
    const tracked = input.workspaceStrategy.type === "worktree" || reused !== undefined;
    let createdWorktreePath: string | null = null;
    let warmLease: NonNullable<Effect.Success<ReturnType<typeof warmWorktrees.claim>>> | undefined;
    let setupTerminalId: string | null = null;
    let workspaceRecorded = false;
    let runReleased = false;
    let releaseSetupGate: Effect.Effect<void> = Effect.void;
    if (input.workspaceStrategy.type === "worktree") {
      yield* setupTracker.begin({
        threadId,
        branch: input.workspaceStrategy.branch ?? null,
        baseRef: input.workspaceStrategy.baseRef,
        stages: ["fetch", "checkout", "setup-script", "agent"],
        fiber: yield* Effect.fiber,
      });
    } else if (reused !== undefined) {
      yield* setupTracker.begin({
        threadId,
        branch: input.workspaceStrategy.branch ?? null,
        baseRef: reused.baseRef,
        stages: ["setup-script", "agent"],
        fiber: yield* Effect.fiber,
      });
    }
    yield* Effect.gen(function* () {
      const initialMessage = input.initialMessage;
      const generateBranchNameFor = (cwd: string, message: ThreadLaunchInitialMessage) =>
        Effect.gen(function* () {
          const settings = resolveProjectSettings(
            yield* serverSettings.getSettings,
            input.projectId,
          ).settings;
          const modelSelection =
            settings.sourceControlWriterModelSelection === null
              ? settings.textGenerationModelSelection
              : ServerSettings.resolveSourceControlWriterModelSelection(
                  settings,
                  yield* providerRegistry.getProviders,
                  input.projectId,
                );
          return yield* textGeneration
            .generateBranchName({
              naming: {
                mode: settings.branchNamingMode,
                prefix: settings.branchNamePrefix,
                instructions: settings.branchNameInstructions,
              },
              cwd,
              message: message.text,
              attachments: message.attachments,
              ...(message.context ? { context: message.context } : {}),
              modelSelection,
            })
            .pipe(
              Effect.map((result) => ({
                branch: result.branch,
                exactName: settings.branchNamingMode === "custom",
              })),
            );
        });

      // The server owns worktree naming: without an explicit branch, provision
      // under a temporary `t3/<hash>` name so the worktree never waits on
      // name generation, then rename in the background below.
      const requestedBranch = input.workspaceStrategy.branch;
      let branch: string | null;
      if (input.workspaceStrategy.type === "worktree" && requestedBranch === undefined) {
        const uuid = yield* randomUuidV4;
        branch = buildTemporaryWorktreeBranchName(() => uuid.replaceAll("-", ""));
      } else {
        branch = requestedBranch ?? null;
      }
      let worktreePath =
        input.workspaceStrategy.type === "existing_worktree"
          ? input.workspaceStrategy.worktreePath
          : null;
      if (input.workspaceStrategy.type === "worktree") {
        if (runId !== null) {
          yield* threads
            .dispatch({
              type: "prepared-run.progress",
              commandId: CommandId.make(`${input.commandId}:progress:worktree`),
              threadId,
              runId,
              phase: "worktree",
            })
            .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
        }
        let startRef = input.workspaceStrategy.baseRef;
        // "Start from origin" is a stored default; repos without the requested
        // remote branch fall back to the local base branch.
        const startFromOrigin =
          input.workspaceStrategy.startFromOrigin === true &&
          (yield* git
            .remoteExists({ cwd: sourceCwd, remoteName: "origin" })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId))));
        yield* setupTracker.stageStatus(threadId, "fetch", startFromOrigin ? "running" : "skipped");
        if (startFromOrigin) {
          yield* git
            .fetchRemote({
              cwd: sourceCwd,
              remoteName: "origin",
              refName: input.workspaceStrategy.baseRef,
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
          const remoteBaseExists = yield* git
            .remoteBranchExists({
              cwd: sourceCwd,
              refName: input.workspaceStrategy.baseRef,
              remoteName: "origin",
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
          if (remoteBaseExists) {
            startRef = yield* git
              .resolveRemoteTrackingCommit({
                cwd: sourceCwd,
                refName: input.workspaceStrategy.baseRef,
                fallbackRemoteName: "origin",
              })
              .pipe(
                Effect.map((resolved) => resolved.commitSha),
                Effect.mapError(mapError(input, "provision-worktree", threadId)),
              );
          }
        }
        if (startFromOrigin) yield* setupTracker.stageStatus(threadId, "fetch", "done");
        if (
          branch !== null &&
          isTemporaryWorktreeBranch(branch) &&
          (yield* git
            .hasCommit({
              cwd: sourceCwd,
              refName: `refs/heads/${WORKTREE_BRANCH_PREFIX}`,
            })
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId))))
        ) {
          branch = flattenTemporaryWorktreeBranchName(branch);
        }
        yield* setupTracker.stageStatus(threadId, "checkout", "running");
        const warm =
          input.holdForSetup === true && input.workspaceStrategy.parentSnapshot === undefined
            ? yield* warmWorktrees.claim({
                threadId,
                projectId: input.projectId,
                cwd: sourceCwd,
                ref: startRef,
                baseRef: input.workspaceStrategy.baseRef,
                branch: branch!,
                onClaimed: (lease) => {
                  warmLease = lease;
                },
              })
            : null;
        const worktree =
          warm !== null
            ? { worktree: { path: warm.path, refName: branch! } }
            : yield* git
                .createWorktree(
                  {
                    cwd: sourceCwd,
                    refName: startRef,
                    newRefName: branch!,
                    baseRefName: input.workspaceStrategy.baseRef,
                    path: null,
                  },
                  {
                    progress: {
                      onWorktreeClaimed: (path) =>
                        Effect.sync(() => {
                          createdWorktreePath = path;
                        }),
                      onCheckoutProgress: (progress) =>
                        setupTracker.stage(threadId, "checkout", { percent: progress.percent }),
                    },
                  },
                )
                .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
        worktreePath = worktree.worktree.path;
        branch = worktree.worktree.refName;
        createdWorktreePath = worktreePath;
        if (input.workspaceStrategy.parentSnapshot !== undefined) {
          yield* git
            .applyParentEdits(input.workspaceStrategy.parentSnapshot, worktreePath)
            .pipe(Effect.mapError(mapError(input, "provision-worktree", threadId)));
        }
        yield* setupTracker.update(threadId, (snapshot) => ({ ...snapshot, worktreePath, branch }));
        yield* setupTracker.stageStatus(threadId, "checkout", "done");
      }

      // A reused worktree is already recorded, and rewriting it could undo
      // the first attempt's branch rename.
      if (reused === undefined) {
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`${input.commandId}:workspace`),
            threadId,
            branch,
            worktreePath,
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      workspaceRecorded = true;
      if (warmLease) yield* warmLease.publish;

      // Rename temporary branches (server-invented above, or sent by clients
      // that name worktrees themselves) in the background so generation latency
      // never delays provisioning or the provider turn. The temporary name
      // simply sticks if generation or the rename fails.
      if (
        reused === undefined &&
        worktreePath !== null &&
        branch !== null &&
        initialMessage !== undefined &&
        isTemporaryWorktreeBranch(branch)
      ) {
        const oldBranch = branch;
        const worktreeCwd = worktreePath;
        yield* generateBranchNameFor(worktreeCwd, initialMessage).pipe(
          Effect.flatMap(({ branch: newBranch, exactName }) =>
            git.renameBranch({
              cwd: worktreeCwd,
              oldBranch,
              newBranch,
              ...(exactName ? { exactName: true } : {}),
            }),
          ),
          Effect.flatMap((renamed) =>
            Effect.gen(function* () {
              yield* threads
                .dispatch({
                  type: "thread.metadata.update",
                  commandId: CommandId.make(`${input.commandId}:branch-rename`),
                  threadId,
                  branch: renamed.branch,
                  worktreePath: worktreeCwd,
                  expectedBranch: oldBranch,
                  expectedWorktreePath: worktreeCwd,
                })
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("Parent thread worktree branch update failed", {
                      threadId,
                      cause,
                    }),
                  ),
                );
              // Updating the parent first makes later subagents inherit the new name.
              // Re-read after each pass for children of subagents updated in that pass.
              const visited = new Set([threadId]);
              while (true) {
                const snapshot = yield* threads.getShellSnapshot({ worktreePath: worktreeCwd });
                const sharing = [...snapshot.threads, ...snapshot.archivedThreads].filter(
                  (thread) =>
                    !visited.has(thread.id) &&
                    thread.worktreePath === worktreeCwd &&
                    thread.branch === oldBranch,
                );
                if (sharing.length === 0) break;
                for (const thread of sharing) {
                  visited.add(thread.id);
                  yield* threads
                    .dispatch({
                      type: "thread.metadata.update",
                      commandId: CommandId.make(`${input.commandId}:branch-rename:${thread.id}`),
                      threadId: thread.id,
                      branch: renamed.branch,
                      expectedBranch: oldBranch,
                      expectedWorktreePath: worktreeCwd,
                    })
                    .pipe(
                      Effect.catchCause((cause) =>
                        Effect.logWarning("Shared thread worktree branch update failed", {
                          threadId: thread.id,
                          cause,
                        }),
                      ),
                    );
                }
              }
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("Thread worktree branch rename failed", {
              commandId: input.commandId,
              threadId,
              oldBranch,
              cause,
            }),
          ),
          Effect.forkIn(preparationScope),
        );
      }

      const cwd = worktreePath ?? project.workspaceRoot;
      if (runId !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.progress",
            commandId: CommandId.make(`${input.commandId}:progress:setup`),
            threadId,
            runId,
            phase: "setup",
          })
          .pipe(Effect.mapError(mapError(input, "update-thread", threadId)));
      }
      yield* setupTracker.stageStatus(threadId, "setup-script", "running");
      // A subagent in a new worktree has nobody watching its setup card, so it
      // waits for setup and is told plainly when setup did not complete.
      const holdForSetup = input.holdForSetup === true && tracked;
      let setupNotice: string | undefined;
      if (holdForSetup && warmLease === undefined) {
        const gate = subagentSetupGate(sourceCwd);
        // Only the wait for a free slot can be interrupted. Taking the slot and
        // arming its release happen in one uninterruptible step, so a
        // cancelled launch never strands a permit.
        const waited = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            let waited = false;
            while (!(yield* Semaphore.takeIfAvailable(gate, 1))) {
              if (!waited) {
                waited = true;
                yield* setupTracker.stageStatus(
                  threadId,
                  "setup-script",
                  "running",
                  "Waiting for other subagent setups",
                );
              }
              yield* restore(Semaphore.withPermits(gate, 1)(Effect.void));
            }
            let held = true;
            releaseSetupGate = Effect.suspend(() => {
              if (!held) return Effect.void;
              held = false;
              return Semaphore.release(gate, 1).pipe(Effect.asVoid);
            });
            return waited;
          }),
        );
        if (waited) yield* setupTracker.stageStatus(threadId, "setup-script", "running", null);
      }
      const started =
        warmLease !== undefined
          ? Exit.succeed({ status: "no-script" } as const)
          : yield* setupScripts
              .runForThread({
                threadId,
                projectId: input.projectId,
                projectCwd: sourceCwd,
                worktreePath: cwd,
                useWorktreeProjectFile: tracked,
                ...(holdForSetup ? { subagentWorktree: true } : {}),
                ...(tracked
                  ? {
                      observeCompletion: {
                        onOutputLine: (line: string) =>
                          setupTracker.appendTail(threadId, "setup-script", line),
                      },
                    }
                  : {}),
                project: {
                  id: project.id,
                  workspaceRoot: sourceCwd,
                  scripts: project.scripts,
                },
              })
              .pipe(Effect.mapError(mapError(input, "run-setup-script", threadId)), Effect.exit);
      if (Exit.isFailure(started) && !holdForSetup) return yield* Effect.failCause(started.cause);
      const setup = Exit.isSuccess(started) ? started.value : null;

      let awaitAsyncSetup = Effect.void;
      if (setup === null) {
        yield* setupTracker.stageStatus(threadId, "setup-script", "failed");
        setupNotice = setupFailureNotice(
          `could not start (${errorText(Exit.isFailure(started) ? Cause.squash(started.cause) : null)})`,
        );
      } else if (setup.status === "started") {
        setupTerminalId = setup.terminalId;
        yield* setupTracker.update(threadId, (snapshot) => ({
          ...snapshot,
          setupScript: {
            name: setup.scriptName,
            command: setup.scriptCommand,
            terminalId: setup.terminalId,
          },
        }));
        if (setup.completion && holdForSetup) {
          const completion = yield* setup.completion.pipe(
            Effect.timeoutOption(SUBAGENT_SETUP_TIMEOUT),
          );
          if (Option.isNone(completion)) {
            yield* setupTracker.stageStatus(threadId, "setup-script", "failed", "still running");
            setupNotice = setupFailureNotice(`was still running after ${SUBAGENT_SETUP_TIMEOUT}`);
          } else {
            const { exitCode } = completion.value;
            yield* setupTracker.stage(threadId, "setup-script", {
              status: exitCode === 0 ? "done" : "failed",
              detail: `exited with ${exitCode ?? "no exit code"}`,
            });
            if (exitCode !== 0) {
              const lastLine = (yield* setupTracker.get(threadId))?.stages
                .find((stage) => stage.id === "setup-script")
                ?.tail.at(-1);
              setupNotice = setupFailureNotice(
                `failed (exit ${exitCode ?? "unknown"}${lastLine ? `: ${lastLine}` : ""})`,
              );
            } else if (
              input.workspaceStrategy.type === "worktree" &&
              input.workspaceStrategy.parentSnapshot === undefined
            ) {
              yield* warmWorktrees.recordSetup({
                projectId: input.projectId,
                cwd: sourceCwd,
                worktreePath: cwd,
                command: setup.scriptCommand,
              });
            }
          }
        } else if (setup.completion) {
          const awaitCompletion = Effect.gen(function* () {
            const completion = yield* setup.completion!;
            yield* setupTracker.stage(threadId, "setup-script", {
              status: completion.exitCode === 0 ? "done" : "failed",
              detail: `exited with ${completion.exitCode ?? "no exit code"}`,
            });
            if (completion.exitCode !== 0 && !setup.async)
              return yield* mapError(
                input,
                "run-setup-script",
                threadId,
              )(`Setup script exited with ${completion.exitCode ?? "no exit code"}.`);
          });
          if (setup.async) {
            awaitAsyncSetup = awaitCompletion.pipe(
              Effect.catchCause((cause) =>
                setupTracker.stage(threadId, "setup-script", {
                  status: "failed",
                  detail: failureDetail(Cause.squash(cause)),
                }),
              ),
            );
          } else {
            yield* awaitCompletion;
          }
        } else {
          yield* setupTracker.stageStatus(threadId, "setup-script", "done");
        }
      } else {
        yield* setupTracker.stageStatus(
          threadId,
          "setup-script",
          "skipped",
          warmLease ? "Dependencies ready" : undefined,
        );
      }
      yield* releaseSetupGate;
      yield* setupTracker.markUncancellable(threadId);
      yield* setupTracker.stageStatus(threadId, "agent", "running");
      if (runId !== null) {
        yield* threads
          .dispatch({
            type: "prepared-run.release",
            commandId: CommandId.make(`${input.commandId}:release`),
            threadId,
            runId,
            ...(setupNotice === undefined ? {} : { setupNotice }),
          })
          .pipe(
            Effect.mapError(mapError(input, "release-run", threadId)),
            Effect.tap(() =>
              Effect.sync(() => {
                runReleased = true;
              }),
            ),
            Effect.uninterruptible,
          );
      }
      yield* setupTracker.stageStatus(threadId, "agent", "done");
      yield* awaitAsyncSetup;
      yield* setupTracker.finish(threadId, "done");
    }).pipe(
      Effect.onError((cause) =>
        Effect.gen(function* () {
          yield* releaseSetupGate;
          if (warmLease && !workspaceRecorded) {
            yield* warmLease.abandon;
            // The pool reconciles its durable lease against the thread before removal.
            createdWorktreePath = null;
          } else if (warmLease) {
            yield* warmLease.publish;
          }
          const cancelled = Cause.hasInterruptsOnly(cause);
          yield* setupTracker.finish(
            threadId,
            cancelled ? "cancelled" : "failed",
            cancelled ? null : failureDetail(Cause.squash(cause)),
          );
          if (cancelled && setupTerminalId)
            yield* terminals
              .close({ threadId, terminalId: setupTerminalId, deleteHistory: true })
              .pipe(Effect.ignore);
          if (
            tracked &&
            createdWorktreePath &&
            ((cancelled && !runReleased) || !workspaceRecorded)
          ) {
            const removedPath = createdWorktreePath;
            // The thread forgets the worktree only once it is gone; a failed
            // removal leaves the directory for the user to clean up rather than
            // reusing a checkout that may be half written.
            yield* git
              .removeWorktree({ cwd: sourceCwd, path: removedPath, force: true }, { abandon: true })
              .pipe(
                Effect.andThen(
                  threads
                    .dispatch({
                      type: "thread.metadata.update",
                      commandId: CommandId.make(`${input.commandId}:cancel-workspace`),
                      threadId,
                      worktreePath: null,
                      branch: null,
                    })
                    .pipe(Effect.ignore),
                ),
                Effect.catchCause((removeCause) =>
                  Effect.logWarning("Failed to remove an abandoned thread worktree", {
                    commandId: input.commandId,
                    threadId,
                    path: removedPath,
                    cause: removeCause,
                  }),
                ),
              );
          }
        }),
      ),
    );
  });

  const failPreparedRun = (
    input: Pick<PreparationInput, "commandId">,
    threadId: ThreadId,
    runId: RunId | null,
    cause: unknown,
  ) =>
    runId === null
      ? Effect.logWarning("Thread workspace preparation failed", {
          commandId: input.commandId,
          threadId,
          cause,
        })
      : threads
          .dispatch({
            type: "prepared-run.fail",
            commandId: CommandId.make(`${input.commandId}:fail`),
            threadId,
            runId,
            failure: makeProviderFailure({
              cause,
              message: failureDetail(cause),
              class: "validation_error",
              retryable: false,
            }),
          })
          .pipe(
            Effect.catchCause((persistCause) =>
              Effect.logWarning("Failed to persist thread workspace preparation failure", {
                commandId: input.commandId,
                threadId,
                cause,
                persistCause,
              }),
            ),
          );

  const reservePreparation = (commandId: CommandId) =>
    Ref.modify(scheduledLaunches, (scheduled) => {
      if (scheduled.has(commandId)) return [false, scheduled] as const;
      const next = new Set(scheduled);
      next.add(commandId);
      return [true, next] as const;
    });

  const releasePreparation = (commandId: CommandId) =>
    Ref.update(scheduledLaunches, (scheduled) => {
      const next = new Set(scheduled);
      next.delete(commandId);
      return next;
    });

  const schedulePreparation = Effect.fn("ThreadLaunchService.schedulePreparation")(function* (
    input: PreparationInput,
    threadId: ThreadId,
    runId: RunId | null,
  ) {
    const preparation = Effect.gen(function* () {
      const prepare = prepareInBackground(input, threadId, runId);
      if (
        runId === null ||
        (input.workspaceStrategy.type !== "worktree" && input.reusedWorktree === undefined)
      ) {
        return yield* prepare;
      }
      const afterSequence = yield* threads.getThreadEventSequence(threadId);
      const projection = yield* threads.getThreadRecords(threadId, ["runs"]);
      if (projection.runs.find((run) => run.id === runId)?.status !== "preparing") return;
      const interruption = threads
        .streamStoredEventsFrom({ threadId, afterSequence, eventType: "run.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "run.updated" &&
              stored.event.payload.id === runId &&
              (stored.event.payload.status === "interrupted" ||
                stored.event.payload.status === "cancelled"),
          ),
          Stream.runHead,
          Effect.flatMap((event) => (Option.isSome(event) ? Effect.interrupt : Effect.never)),
        );
      yield* Effect.raceFirst(prepare, interruption);
    });
    yield* preparation.pipe(
      Effect.onError((cause) =>
        failPreparedRun(
          input,
          threadId,
          runId,
          Cause.hasInterruptsOnly(cause) ? "Worktree setup cancelled." : Cause.squash(cause),
        ),
      ),
      Effect.ignoreCause,
      Effect.ensuring(releasePreparation(input.commandId)),
      Effect.forkIn(preparationScope),
    );
  });

  const launch: ThreadLaunchService["Service"]["launch"] = Effect.fn("ThreadLaunchService.launch")(
    function* (requested) {
      const input = yield* withAccountWithRoom(requested);
      const launchReceipt = yield* readReceipt(input, input.commandId);
      const claim = Option.getOrUndefined(launchReceipt);
      const claimType = input.reuseExistingThread ? "thread.metadata.update" : "thread.create";
      if (
        claim &&
        (claim.commandType !== claimType ||
          (input.threadId !== undefined && claim.threadId !== input.threadId))
      ) {
        return yield* mapError(
          input,
          input.reuseExistingThread ? "update-thread" : "create-thread",
          input.threadId,
          true,
        )(
          `Command ${input.commandId} was recorded for another thread or command type and cannot be replayed for this launch.`,
        );
      }
      const initialReceipt =
        claim?.status === "accepted" && input.initialMessage
          ? yield* readReceipt(input, initialMessageCommandId(input.commandId))
          : Option.none();
      if (
        Option.isSome(initialReceipt) &&
        (initialReceipt.value.threadId !== claim?.threadId ||
          initialReceipt.value.commandType !== "message.dispatch")
      ) {
        return yield* mapError(
          input,
          "read-receipt",
          input.threadId,
        )("Initial message command ID belongs to another thread or command type.");
      }
      const replay =
        claim?.status === "accepted" &&
        (!input.initialMessage ||
          (Option.isSome(initialReceipt) && initialReceipt.value.status === "accepted"));
      if (!replay) {
        const refuseProject = mapError(input, "resolve-project", input.threadId, true);
        yield* ProjectCloneTracker.rejectCommandsDuringClone(cloneTracker, {
          type: "thread.create",
          projectId: input.projectId,
        }).pipe(Effect.mapError(refuseProject));
        const project = yield* projects
          .getById(input.projectId)
          .pipe(Effect.mapError(mapError(input, "resolve-project")));
        if (Option.isNone(project)) return yield* refuseProject("Project not found.");
        if (project.value.id !== input.projectId)
          return yield* refuseProject("Project identity changed.");
        yield* threads.assertProviderInstanceEnabled({
          projectId: input.projectId,
          commandId: input.commandId,
          instanceId: input.modelSelection.instanceId,
        });
      }
      if (input.reuseExistingThread === true && input.threadId === undefined) {
        return yield* mapError(
          input,
          "update-thread",
        )("Reusing an existing thread requires a thread id.");
      }
      return yield* Effect.gen(function* () {
        // A retried launch has no client-supplied id to replay against, so
        // recover the thread id its accepted create was recorded under before
        // allocating another one; a fresh id would only collide with the
        // recorded receipt.
        const candidateThreadId =
          input.threadId ??
          (claim?.status === "accepted" ? claim.threadId : undefined) ??
          (yield* ids.allocate
            .thread({ projectId: input.projectId })
            .pipe(Effect.mapError(mapError(input, "create-thread"))));
        if (replay || (input.threadId === undefined && claim?.status === "accepted")) {
          const shell = yield* threads
            .getThreadShell(candidateThreadId)
            .pipe(Effect.mapError(mapError(input, "create-thread", candidateThreadId)));
          if (shell === null) {
            return yield* mapError(input, "create-thread", candidateThreadId)("Thread not found.");
          }
          if (shell.projectId !== input.projectId) {
            return yield* mapError(
              input,
              "resolve-project",
              candidateThreadId,
            )("Project identity changed.");
          }
        }

        if (input.reuseExistingThread === true && Option.isNone(launchReceipt)) {
          yield* validateReusableThread(input, candidateThreadId);
        }

        // A Scratch thread launched at the project root runs in a folder of its
        // own. Only the first attempt claims one; a retry replays its create.
        const workspaceStrategy: ThreadLaunchWorkspaceStrategy =
          input.workspaceStrategy.type === "root" && Option.isNone(launchReceipt)
            ? Option.match(
                yield* managedFolders
                  .folderForThread({
                    projectId: input.projectId,
                    threadId: candidateThreadId,
                    text: input.initialMessage?.text ?? input.title,
                  })
                  .pipe(Effect.mapError(mapError(input, "provision-worktree", candidateThreadId))),
                {
                  onNone: () => input.workspaceStrategy,
                  onSome: (worktreePath) => ({ type: "existing_worktree", worktreePath }),
                },
              )
            : input.workspaceStrategy;
        const initialBranch = workspaceStrategy.branch ?? null;
        const initialWorktreePath =
          workspaceStrategy.type === "existing_worktree" ? workspaceStrategy.worktreePath : null;
        const claimDispatch =
          input.reuseExistingThread === true
            ? threads.dispatch({
                type: "thread.metadata.update",
                commandId: input.commandId,
                threadId: candidateThreadId,
                expectedEmpty: true,
              })
            : threads.dispatch({
                type: "thread.create",
                commandId: input.commandId,
                threadId: candidateThreadId,
                projectId: input.projectId,
                title: input.title,
                modelSelection: input.modelSelection,
                runtimeMode: input.runtimeMode,
                interactionMode: input.interactionMode,
                branch: initialBranch,
                worktreePath: initialWorktreePath,
                ...(input.importedNativeThread === undefined
                  ? {}
                  : { importedNativeThread: input.importedNativeThread }),
                createdBy: input.createdBy,
                creationSource: input.creationSource,
              });
        const claimed = yield* claimDispatch.pipe(
          Effect.mapError(
            mapError(
              input,
              input.reuseExistingThread === true ? "update-thread" : "create-thread",
              candidateThreadId,
            ),
          ),
        );
        const threadId =
          claimed.storedEvents.find((stored) => stored.event.type.startsWith("thread."))?.event
            .threadId ?? candidateThreadId;

        let runId: RunId | null = null;
        let messageWasAlreadyAccepted = false;
        if (input.initialMessage !== undefined) {
          const messageCommandId = initialMessageCommandId(input.commandId);
          const messageReceipt = Option.isSome(initialReceipt)
            ? initialReceipt
            : yield* readReceipt(input, messageCommandId);
          messageWasAlreadyAccepted = Option.isSome(messageReceipt);
          const messageId =
            input.initialMessage.messageId ??
            (yield* ids.allocate
              .message({ threadId, ordinal: 1 })
              .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId))));
          const dispatched = yield* threads
            .dispatch({
              type: "message.dispatch",
              commandId: messageCommandId,
              threadId,
              messageId,
              text: input.initialMessage.text,
              ...(input.initialMessage.scheduledTaskId === undefined
                ? {}
                : { scheduledTaskId: input.initialMessage.scheduledTaskId }),
              ...(input.initialMessage.senderThreadId === undefined
                ? {}
                : { senderThreadId: input.initialMessage.senderThreadId }),
              attachments: input.initialMessage.attachments,
              ...(input.initialMessage.context ? { context: input.initialMessage.context } : {}),
              ...(input.generateTitle === true ? { titleSeed: input.title } : {}),
              modelSelection: input.modelSelection,
              ...(input.initialMessage.deliveryIntent === undefined
                ? {}
                : { deliveryIntent: input.initialMessage.deliveryIntent }),
              dispatchMode: { type: "defer_start", workspaceStrategy },
              createdBy: input.createdBy,
              creationSource: input.creationSource,
            })
            .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId)));
          const runCreated = dispatched.storedEvents.find(
            (stored) => stored.event.type === "run.created",
          );
          runId = runCreated?.event.type === "run.created" ? runCreated.event.payload.id : null;
          if (runId === null && input.initialMessage.deliveryIntent === "auto") {
            const accepted = yield* threads
              .getThreadRecords(threadId, ["messages"], { messageIds: [messageId] })
              .pipe(Effect.mapError(mapError(input, "dispatch-message", threadId)));
            runId = accepted.messages.find((message) => message.id === messageId)?.runId ?? null;
          }
          if (runId === null) {
            return yield* mapError(
              input,
              "dispatch-message",
              threadId,
            )("Initial message was accepted without a durable run.");
          }
        }

        const projection = yield* threads
          .getThreadProjection(threadId)
          .pipe(Effect.mapError(mapError(input, "create-thread", threadId)));
        const runIsPreparing =
          runId !== null &&
          projection.runs.some((run) => run.id === runId && run.status === "preparing");
        const shouldSchedule = runId === null ? Option.isNone(launchReceipt) : runIsPreparing;
        // A retried root launch prepares the folder its first attempt bound, so
        // a Scratch thread keeps its own. Other root launches bind no folder.
        const boundWorktreePath = projection.thread.worktreePath;
        const preparationStrategy: ThreadLaunchWorkspaceStrategy =
          Option.isSome(launchReceipt) &&
          workspaceStrategy.type === "root" &&
          boundWorktreePath !== null
            ? {
                type: "existing_worktree",
                worktreePath: boundWorktreePath,
                branch: workspaceStrategy.branch,
              }
            : workspaceStrategy;
        if (shouldSchedule) {
          const ownsPreparation = yield* reservePreparation(input.commandId);
          if (ownsPreparation) {
            yield* Effect.gen(function* () {
              const preparationStillRequired =
                runId === null
                  ? true
                  : yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] }).pipe(
                      Effect.map((current) =>
                        current.runs.some((run) => run.id === runId && run.status === "preparing"),
                      ),
                      Effect.mapError(mapError(input, "update-thread", threadId)),
                    );
              if (preparationStillRequired) {
                yield* schedulePreparation(
                  { ...input, workspaceStrategy: preparationStrategy },
                  threadId,
                  runId,
                );
              } else {
                yield* releasePreparation(input.commandId);
              }
            }).pipe(Effect.onError(() => releasePreparation(input.commandId)));
          }
        }

        return {
          threadId,
          projection,
          resumed: Option.isSome(launchReceipt) || messageWasAlreadyAccepted,
        };
      });
    },
  );

  const prepareRun: ThreadLaunchService["Service"]["prepareRun"] = Effect.fn(
    "ThreadLaunchService.prepareRun",
  )(function* (input) {
    const scheduled = yield* Effect.gen(function* () {
      const { thread, runs } = yield* threads.getThreadRecords(input.threadId, ["runs"], {
        runIds: [input.runId],
      });
      const run = runs.find((candidate) => candidate.id === input.runId);
      const workspacePreparation = run?.workspacePreparation;
      if (run?.status !== "preparing" || workspacePreparation === undefined) return;
      if (!(yield* reservePreparation(input.commandId))) return;
      yield* scheduleRunPreparation(input, thread, run, workspacePreparation).pipe(
        Effect.onError(() => releasePreparation(input.commandId)),
      );
    }).pipe(Effect.exit);
    if (Exit.isFailure(scheduled)) {
      yield* failPreparedRun(input, input.threadId, input.runId, Cause.squash(scheduled.cause));
    }
  });

  const retryPreparation: ThreadLaunchService["Service"]["retryPreparation"] = Effect.fn(
    "ThreadLaunchService.retryPreparation",
  )(function* (input) {
    const dispatched = yield* threads.dispatch({
      type: "prepared-run.retry",
      commandId: input.commandId,
      threadId: input.threadId,
      runId: input.runId,
    });
    yield* prepareRun(input);
    return dispatched;
  });

  const scheduleRunPreparation = Effect.fn("ThreadLaunchService.scheduleRunPreparation")(function* (
    input: ThreadLaunchPreparationInput,
    thread: OrchestrationV2ThreadProjection["thread"],
    run: OrchestrationV2ThreadProjection["runs"][number],
    workspacePreparation: OrchestrationV2WorkspacePreparation,
  ) {
    const { messages } = yield* threads.getThreadRecords(input.threadId, ["messages"], {
      messageIds: [run.userMessageId],
    });
    const message = messages.find((candidate) => candidate.id === run.userMessageId);
    // A worktree the failed attempt already created is reused, not created again.
    const reuse =
      workspacePreparation.type === "worktree" &&
      thread.worktreePath !== null &&
      thread.branch !== null
        ? {
            strategy: {
              type: "existing_worktree" as const,
              worktreePath: thread.worktreePath,
              branch: thread.branch,
            },
            reusedWorktree: {
              baseRef: workspacePreparation.baseRef,
              ...(workspacePreparation.sourcePath === undefined
                ? {}
                : { sourcePath: workspacePreparation.sourcePath }),
            },
          }
        : null;
    return yield* schedulePreparation(
      {
        commandId: input.commandId,
        projectId: thread.projectId,
        workspaceStrategy: reuse?.strategy ?? workspacePreparation,
        ...(reuse === null ? {} : { reusedWorktree: reuse.reusedWorktree }),
        ...(thread.lineage.relationshipToParent === "subagent" ? { holdForSetup: true } : {}),
        ...(message === undefined
          ? {}
          : {
              initialMessage: {
                text: message.text,
                attachments: message.attachments,
                ...(message.context ? { context: message.context } : {}),
              },
            }),
      },
      input.threadId,
      run.id,
    );
  });

  const startUserSubagent: ThreadLaunchService["Service"]["startUserSubagent"] = Effect.fn(
    "ThreadLaunchService.startUserSubagent",
  )(function* (input) {
    const refuse = (message: string, cause?: unknown) =>
      new OrchestrationV2StartSubagentError({
        threadId: input.threadId,
        message,
        ...(cause === undefined ? {} : { cause }),
      });
    const unreadable = (cause: unknown) => refuse("This chat could not be read.", cause);
    const shell = yield* threads.getThreadShell(input.threadId).pipe(Effect.mapError(unreadable));
    if (shell === null || shell.deletedAt !== null || shell.archivedAt !== null) {
      return yield* refuse("This chat is no longer open.");
    }
    const lead = yield* threads
      .getThreadRecords(input.threadId, ["runs", "subagents"])
      .pipe(Effect.mapError(unreadable));
    // The card needs a turn to sit in: the one running now, else the last one that ran.
    const owner =
      lead.runs
        .filter(ThreadManagement.isActiveRun)
        .sort((left, right) => right.ordinal - left.ordinal)[0] ?? latestExecutedRun(lead.runs);
    if (owner === undefined || owner === null || owner.rootNodeId === null) {
      return yield* refuse("Send this chat a message first. A subagent reports to a turn of it.");
    }

    // Where the lead's own subagents last worked, else the lead's folder. A repository with a
    // commit gives the subagent a copy of its own; anything else is shared with the lead.
    const project = Option.getOrUndefined(
      yield* projects.getById(shell.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
    );
    let siblingRepository: string | undefined;
    for (const sibling of latestAppOwnedSubagents(lead.subagents, SIBLING_REPOSITORY_LOOKBACK)) {
      const runs = yield* threads.getThreadRecords(sibling.childThreadId!, ["runs"]).pipe(
        Effect.map((records) => records.runs),
        Effect.orElseSucceed(() => []),
      );
      const preparation = runs.find(
        (run) =>
          run.workspacePreparation?.type === "worktree" &&
          "sourcePath" in run.workspacePreparation &&
          run.workspacePreparation.sourcePath !== undefined,
      )?.workspacePreparation;
      if (preparation?.type === "worktree" && "sourcePath" in preparation) {
        siblingRepository = preparation.sourcePath;
        break;
      }
    }
    const leadFolder = lead.thread.worktreePath ?? project?.workspaceRoot;
    let repository: string | undefined;
    for (const candidate of [siblingRepository, leadFolder]) {
      if (candidate === undefined || candidate === repository) continue;
      const committed = yield* git
        .hasCommit({ cwd: candidate, refName: "HEAD" })
        .pipe(Effect.orElseSucceed(() => false));
      if (committed) {
        repository = candidate;
        break;
      }
    }
    const workspaceStrategy: OrchestrationV2WorkspacePreparation | undefined =
      repository === undefined
        ? undefined
        : {
            type: "worktree",
            baseRef: "HEAD",
            startFromOrigin: false,
            ...(repository === project?.workspaceRoot ? {} : { sourcePath: repository }),
          };

    const command = {
      type: "delegated_task.request",
      createdBy: "user",
      creationSource: input.creationSource ?? "web",
      commandId: input.commandId,
      parentThreadId: input.threadId,
      parentRunId: owner.id,
      parentNodeId: owner.rootNodeId,
      task: input.task,
      modelSelection: input.modelSelection,
      runtimeMode: lead.thread.runtimeMode,
      interactionMode: "default",
      ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
      // The lead may be idle: the result must still reach it.
      completionWake: "always",
    } satisfies Extract<OrchestrationV2ServerCommand, { type: "delegated_task.request" }>;
    const result = yield* threads
      .dispatch(command)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "ThreadManagementProviderInstanceDisabledError"
            ? refuse("That model's provider is turned off in Settings.", error)
            : refuse(
                userFacingDispatchErrorMessage(error) ?? "The subagent could not be started.",
                error,
              ),
        ),
      );
    const task = result.storedEvents.flatMap((stored) =>
      stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned"
        ? [stored.event.payload]
        : [],
    )[0];
    if (task === undefined || task.childThreadId === null) {
      return yield* refuse("The subagent could not be started.");
    }
    const childThreadId = task.childThreadId;
    const childRun = result.storedEvents.flatMap((stored) =>
      stored.event.type === "run.created" && stored.event.threadId === childThreadId
        ? [stored.event.payload]
        : [],
    )[0];
    if (childRun?.workspacePreparation !== undefined) {
      yield* prepareRun({
        commandId: input.commandId,
        threadId: childThreadId,
        runId: childRun.id,
      });
    }
    return {
      taskId: task.id,
      childThreadId,
      workspace: workspaceStrategy === undefined ? "shared" : "own_copy",
    };
  });

  const isNonGitProject: ThreadLaunchService["Service"]["isNonGitProject"] = Effect.fn(
    "ThreadLaunchService.isNonGitProject",
  )(function* (projectId) {
    const project = yield* projects
      .getById(projectId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(project)) return false;
    // A failed check is not "no repository": the worktree launch reports the real error.
    return yield* git.isRepository(project.value.workspaceRoot).pipe(
      Effect.map((isRepository) => !isRepository),
      Effect.orElseSucceed(() => false),
    );
  });

  return ThreadLaunchService.of({
    launch,
    checkWorktreeBase,
    isNonGitProject,
    retryPreparation,
    prepareRun,
    startUserSubagent,
  });
});

export const layer = Layer.effect(ThreadLaunchService, make);
