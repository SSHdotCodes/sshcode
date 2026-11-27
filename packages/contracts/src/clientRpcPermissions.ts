import { ServerSettingsPatch, requiredScopesForServerSettingsPatch } from "./settings.ts";
import { ProviderInstanceMutation } from "./providerInstance.ts";
import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthProvidersManageScope,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.serverRecordAutoModelFeedback]: AuthSettingsWriteScope,
  [WS_METHODS.serverDecideAutoModelTask]: AuthSettingsWriteScope,
  [WS_METHODS.serverRefreshProviders]: AuthOrchestrationReadScope,
  [WS_METHODS.serverUpdateSettings]: AuthSettingsWriteScope,
  // Shared-key and provider environment settings use the provider-management grant.
  [WS_METHODS.serverReplaceProviderCredential]: AuthProvidersManageScope,
  [WS_METHODS.computerStop]: AuthOrchestrationOperateScope,
  [WS_METHODS.computerResume]: AuthOrchestrationOperateScope,
  [WS_METHODS.computerSetup]: AuthSettingsWriteScope,
  [ORCHESTRATION_V2_WS_METHODS.rebuildSearchIndex]: AuthSettingsWriteScope,
  // Letting an outside agent in hands out access, like approving a device.
  [WS_METHODS.outsideAgentsSubscribe]: AuthAccessWriteScope,
  [WS_METHODS.outsideAgentsCommand]: AuthAccessWriteScope,
  [WS_METHODS.terminalHandoffOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.terminalHandoffReturn]: AuthOrchestrationOperateScope,
  [WS_METHODS.nativeSessionsOpen]: AuthOrchestrationOperateScope,
  [WS_METHODS.claudeRcCommand]: AuthOrchestrationOperateScope,
  [WS_METHODS.apiKeysManage]: AuthSettingsWriteScope,
  [WS_METHODS.secretsAnswerRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.harnessDefaultsUpdate]: AuthSettingsWriteScope,
  [WS_METHODS.notesMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.subagentRankingsToggleThumb]: AuthOrchestrationOperateScope,
  [WS_METHODS.teamBoardSubscribe]: AuthOrchestrationReadScope,
  [WS_METHODS.teamBoardPost]: AuthOrchestrationOperateScope,
  [WS_METHODS.sharedSkillsCommand]: AuthSettingsWriteScope,
  [WS_METHODS.workflowsMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsCompile]: AuthOrchestrationOperateScope,
  [WS_METHODS.workflowsStart]: AuthOrchestrationOperateScope,
  [WS_METHODS.botsMutate]: AuthOrchestrationOperateScope,
  [WS_METHODS.casualVoice]: AuthOrchestrationOperateScope,
  [WS_METHODS.modelManagerRequest]: AuthOrchestrationOperateScope,
  [WS_METHODS.chatTabsCommand]: AuthOrchestrationOperateScope,
  [WS_METHODS.chatControlsCommand]: AuthOrchestrationOperateScope,
  [WS_METHODS.chatControlsFirstSubagentVerdict]: AuthOrchestrationOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  // Endpoint checks exist to configure exports, so they need the same grant as saving them.
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.backgroundToolCall]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopMonitor]: AuthOrchestrationOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodeSettingsUpdate = Schema.decodeUnknownSync(
  Schema.Struct({
    patch: ServerSettingsPatch,
    providerInstanceMutation: Schema.optionalKey(ProviderInstanceMutation),
  }),
);

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (
    method === WS_METHODS.serverRefreshProviders &&
    typeof input === "object" &&
    input !== null &&
    "clearOutOfCredit" in input &&
    input.clearOutOfCredit === true
  )
    return [AuthOrchestrationReadScope, AuthProvidersManageScope];
  if (method === WS_METHODS.serverUpdateSettings && input !== undefined) {
    const decoded = decodeSettingsUpdate(input);
    const scopes = requiredScopesForServerSettingsPatch(decoded.patch);
    if (decoded.providerInstanceMutation === undefined) return scopes;
    return Object.values(decoded.patch).every((value) => value === undefined)
      ? [AuthProvidersManageScope]
      : [...new Set([...scopes, AuthProvidersManageScope])];
  }
  // State includes approval codes, so reading it requires the same grant as approving.
  // Approving can grant up to full access, so the approver must hold all of it.
  if (method === WS_METHODS.outsideAgentsSubscribe || method === WS_METHODS.outsideAgentsCommand)
    return [
      AuthAccessWriteScope,
      AuthOrchestrationReadScope,
      AuthOrchestrationOperateScope,
      AuthSettingsWriteScope,
      AuthSourceControlWriteScope,
    ];
  if (
    method === WS_METHODS.apiKeysManage &&
    typeof input === "object" &&
    input !== null &&
    "action" in input &&
    input.action === "list"
  )
    // List uses the server read grant; the command guard covers mutations.
    return [];
  // The Models chat edits harness configs on the host, like a settings change.
  if (method === WS_METHODS.modelManagerRequest)
    return [AuthOrchestrationOperateScope, AuthSettingsWriteScope];
  if (
    method === WS_METHODS.casualVoice &&
    typeof input === "object" &&
    input !== null &&
    "action" in input &&
    input.action === "configure" &&
    ("backend" in input || "cloudBackend" in input || "mode" in input || "saveTraining" in input)
  )
    return [AuthOrchestrationOperateScope, AuthSettingsWriteScope];
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
