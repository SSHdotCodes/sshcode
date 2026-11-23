import {
  ANTIGRAVITY_DEFAULT_MODEL,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ProviderCapabilities,
  type ProviderSetupError,
} from "@t3tools/contracts";
import type { SelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Exit from "effect/Exit";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as EffectAcpErrors from "effect-acp/errors";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { AntigravityAuth } from "../../provider/AntigravityAuth.ts";
import type * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import {
  antigravityPermissionMode,
  antigravitySteersWithPrompt,
  applyAntigravityAcpModelSelection,
  buildAntigravityPrompt,
  type AntigravityAcpRuntimeInput,
} from "../../provider/acp/AntigravityAcpSupport.ts";
import { readAntigravityClientTextFile } from "../../provider/acp/AntigravityClientFiles.ts";
import {
  antigravityApprovalOptions,
  antigravityCommandOutlivesPrompt,
  antigravitySubagentOutput,
  antigravityPromptStopFailure,
  classifyAntigravitySubagentToolCall,
  extractAntigravityUserInputQuestion,
  isAntigravityScheduleTool,
  makeAntigravityReadRepair,
  makeAntigravityStoppedTools,
  makeAntigravityUserInputResponse,
  normalizeAntigravityToolCall,
} from "../../provider/acp/AntigravityProtocol.ts";
import { isAntigravitySignInRequiredError } from "../../provider/antigravityAuthSupport.ts";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@t3tools/provider-acp/server/adapter";

const ANTIGRAVITY_PROVIDER = ProviderDriverKind.make("antigravity");

const AntigravityProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface AntigravityAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly selfInvocation: SelfInvocation;
  /** Spawns the official agent with the instance's Google profile. */
  readonly makeRuntime: (
    input: Omit<AntigravityAcpRuntimeInput, "spawn" | "childProcessSpawner">,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError | ProviderSetupError,
    Scope.Scope
  >;
  /** Serialises process ownership against sign-in and sign-out. */
  readonly withProcess: AntigravityAuth["withProcess"];
  /** Model to select for the provider default alias, from the manifest. */
  readonly defaultModel: Effect.Effect<string | undefined>;
  /**
   * The ids of the usage windows that count a model, such as `3p-5h` and `3p-weekly` for
   * Claude and GPT. Google's quota notice names no window; a refusal names these so the
   * limit leaves the models other windows count usable.
   */
  readonly quotaWindowIds?: (model: string) => Effect.Effect<ReadonlyArray<string>>;
  readonly onSessionStarted?: (
    started: AcpSessionRuntime.AcpSessionRuntimeStartResult,
    cwd: string,
  ) => Effect.Effect<void>;
  readonly onSessionEvent?: AcpAdapterV2Flavor["onSessionEvent"];
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
}

/**
 * ACP 1.1.1 exposes subagent invocations as ordinary `start_subagent` tools
 * without child session ids. Project them as subagent items keyed by the tool
 * call so the timeline shows them as delegated work.
 */
const extractAntigravitySubagentUpdate: NonNullable<AcpAdapterV2Flavor["extractSubagentUpdate"]> = (
  toolCall,
) => {
  if (classifyAntigravitySubagentToolCall(toolCall) !== "subagent") {
    return undefined;
  }
  const status =
    toolCall.status === "failed" ? "failed" : toolCall.status === "pending" ? "pending" : "running";
  return {
    nativeTaskId: toolCall.toolCallId,
    prompt:
      antigravitySubagentOutput(toolCall) ??
      toolCall.detail ??
      toolCall.title ??
      "Antigravity subagent batch",
    title: "Antigravity subagent batch",
    model: null,
    status,
    childSessionId: null,
    result: status === "failed" ? (antigravitySubagentOutput(toolCall) ?? null) : null,
  };
};

/** The services the Antigravity flavor runs its runtime and session files with. */
interface AntigravityFlavorServices {
  readonly crypto: Crypto.Crypto;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly host: ProviderHost.ProviderHost["Service"];
}

export function makeAntigravityAcpAdapterFlavor(
  options: AntigravityAdapterV2Options & AntigravityFlavorServices,
): AcpAdapterV2Flavor {
  // The attachments dir grant lets the agent read pasted files at the paths
  // the turn text references. It is a leaf directory of uploads. A session
  // without a workspace gets no workspace root rather than the server's cwd.
  const antigravityClientFileRoots = (cwd: string | null) =>
    cwd === null ? [options.host.paths.attachmentsDir] : [cwd, options.host.paths.attachmentsDir];
  const makeRuntime = (input: AcpAdapterV2RuntimeInput) =>
    Effect.gen(function* () {
      // AcpAdapterV2 owns the runtime scope; sign-in and sign-out stop the
      // process by closing a child of it, and the adapter respawns on the next turn.
      const scope = yield* Scope.fork(yield* Effect.scope);
      const runtime = yield* options
        .withProcess(
          Scope.close(scope, Exit.void),
          options.makeRuntime({
            ...input,
            clientFileReads: true,
            additionalDirectories: [options.host.paths.attachmentsDir],
          }),
        )
        .pipe(Effect.provideService(Scope.Scope, scope));
      // Repair keeps state across updates, so each runtime must have one session-update handler.
      const reads = makeAntigravityReadRepair();
      // Served reads are reported from the read handler, so they take turns with agent updates.
      const updates = yield* Semaphore.make(1);
      let projectUpdate: Parameters<typeof runtime.handleSessionUpdate>[0] | undefined;
      return {
        ...runtime,
        handleReadTextFile: (handler) =>
          runtime.handleReadTextFile((request, context) =>
            handler(request, context).pipe(
              Effect.onExit((exit) => {
                const served = reads.attempted(request.path, Exit.isSuccess(exit));
                if (served === undefined || projectUpdate === undefined) return Effect.void;
                return updates
                  .withPermit(
                    projectUpdate({
                      sessionId: served.sessionId,
                      update: {
                        sessionUpdate: "tool_call_update",
                        toolCallId: served.toolCallId,
                        status: "completed",
                      },
                    }),
                  )
                  .pipe(Effect.ignore);
              }),
            ),
          ),
        prompt: (payload, promptOptions) =>
          Effect.sync(reads.reset).pipe(Effect.andThen(runtime.prompt(payload, promptOptions))),
        handleSessionUpdate: (handler) => {
          projectUpdate = handler;
          return runtime.handleSessionUpdate((notification) =>
            updates.withPermit(handler(reads.repair(notification))),
          );
        },
        start: () =>
          runtime
            .start()
            .pipe(
              Effect.tap(
                (started) => options.onSessionStarted?.(started, input.cwd) ?? Effect.void,
              ),
            ),
      } satisfies typeof runtime;
    }).pipe(
      Effect.provideService(Crypto.Crypto, options.crypto),
      Effect.mapError((cause): EffectAcpErrors.AcpError =>
        cause._tag === "ProviderSetupError"
          ? new EffectAcpErrors.AcpTransportError({ detail: cause.detail, cause })
          : cause,
      ),
    );

  return {
    driver: ANTIGRAVITY_PROVIDER,
    runtimeHarness: "Antigravity",
    capabilities: AntigravityProviderCapabilitiesV2,
    buildPrompt: ({ text, attachments, promptCapabilities }) =>
      buildAntigravityPrompt({
        input: text,
        attachments,
        attachmentsDir: options.host.paths.attachmentsDir,
        promptCapabilities,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, options.fileSystem),
        Effect.provideService(Path.Path, options.path),
      ),

    makeRuntime,
    // The runtime waits for the cancelled prompt's response before reusing this
    // session. A failed or timed-out cancellation must fail the resend.
    interruptPromptOnCancel: false,
    restartRuntimeAfterInterrupt: false,
    // Loading history replays every tool call; resume restores the session
    // without the replay and is what the official client does.
    preferResumeSession: true,
    subagentsIdleOnTurnCompletion: true,
    // A finished background command or timer wakes the agent with no prompt open: it streams a
    // reply and asks for permissions, and no prompt response ever ends that reply.
    enablePostSettleContinuation: true,
    deferFinalizeForBackgroundWork: true,
    wakeOnDetachedRequest: true,
    replyEndsWithUsageUpdate: true,
    toolOutlivesPrompt: antigravityCommandOutlivesPrompt,
    // A pending `schedule` timer keeps the agent process without holding the run open.
    extractBackgroundTaskId: (toolCall) =>
      isAntigravityScheduleTool(toolCall) ? toolCall.toolCallId : undefined,
    isPersistentBackgroundTool: isAntigravityScheduleTool,
    // session/cancel ends the agent's running commands, so only Stop sends it once the prompt
    // has ended. A message sent while a command runs leaves the command alone.
    preserveRuntimeOnSettledInterrupt: true,
    // `agy acp` reads a prompt sent mid-turn as a steer; cancel-and-restart killed its subagents.
    steersWithPrompt: antigravitySteersWithPrompt,
    ...(options.onSessionEvent === undefined ? {} : { onSessionEvent: options.onSessionEvent }),
    applyModelSelection: ({ runtime, modelSelection }) =>
      Effect.gen(function* () {
        const defaultModel = yield* options.defaultModel;
        return yield* applyAntigravityAcpModelSelection({
          runtime,
          model:
            modelSelection.model === ANTIGRAVITY_DEFAULT_MODEL ? undefined : modelSelection.model,
          defaultModel,
          mapError: (cause) => cause,
        });
      }),
    sessionModeForPolicy: (policy) => antigravityPermissionMode(policy.runtimeMode),
    clientFileSystem: {
      readTextFile: (request, cwd) =>
        readAntigravityClientTextFile({
          fileSystem: options.fileSystem,
          path: options.path,
          allowedRoots: antigravityClientFileRoots(cwd),
          request,
        }),
    },
    approvalOptions: antigravityApprovalOptions,
    // A spent quota arrives as the reply. It names no usage window, so the failure names the
    // windows that count the turn's model and leaves the other model family usable.
    promptStopFailure: (input) =>
      Effect.gen(function* () {
        const failure = antigravityPromptStopFailure(input);
        if (failure?.class !== "usage_limit") return failure;
        const model =
          input.model === ANTIGRAVITY_DEFAULT_MODEL ? yield* options.defaultModel : input.model;
        const windowIds =
          model === undefined || options.quotaWindowIds === undefined
            ? []
            : yield* options.quotaWindowIds(model);
        yield* Effect.logWarning("Antigravity ended a turn on a spent quota", {
          instanceId: options.instanceId,
          model: model ?? input.model,
          resetAt: failure.resetAt,
          windowIds,
        });
        return windowIds.length === 0 ? failure : { ...failure, usageLimitWindowIds: windowIds };
      }),
    extractPermissionQuestion: (request) => {
      const question = extractAntigravityUserInputQuestion(request);
      if (question === undefined) return undefined;
      return {
        question,
        respond: (answers) => makeAntigravityUserInputResponse(request, answers),
      };
    },
    normalizeToolCall: normalizeAntigravityToolCall,
    trackAgentStoppedTools: makeAntigravityStoppedTools,
    extractSubagentUpdate: extractAntigravitySubagentUpdate,
    supportsImagePrompts: true,
    compactViaAdvertisedCommand: true,
    requiresSignIn: isAntigravitySignInRequiredError,
    // Antigravity can leave a prompt open without updates; long tools and approvals pause this.
    promptInactivityTimeout: "15 minutes",
  };
}

export const makeAntigravityAdapterV2 = Effect.fn("makeAntigravityAdapterV2")(function* (
  options: AntigravityAdapterV2Options,
) {
  const services: AntigravityFlavorServices = {
    crypto: yield* Crypto.Crypto,
    fileSystem: yield* FileSystem.FileSystem,
    path: yield* Path.Path,
    host: yield* ProviderHost.ProviderHost,
  };
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeAntigravityAcpAdapterFlavor({ ...options, ...services }),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
  });
});
