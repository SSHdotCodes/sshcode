import {
  ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Subagent,
  type ServerProvider,
} from "@t3tools/contracts";
import { modelRankingFamily } from "@t3tools/shared/modelRankings";
import * as DateTime from "effect/DateTime";
import { inferTaskKind, type RunRecord } from "./records.ts";

/**
 * Failures from the provider account or the network (sign-in, subscription,
 * quota, rate limits, an unreachable host) say nothing about how the model
 * works, so those runs stay out of the rankings.
 */
export function isAccountFailure(failure: OrchestrationV2ProviderFailure): boolean {
  if (
    failure.class === "usage_limit" ||
    failure.class === "permission_error" ||
    failure.class === "billing_error" ||
    failure.class === "subscription_error" ||
    failure.class === "authentication_error" ||
    failure.class === "transport_error"
  )
    return true;
  // Status codes count only where they read as one: a short code field, or
  // "status 429" / "API Error: 403" / "HTTP/1.1 401", not "position 403".
  if (/^\D{0,12}(?:401|402|403|429)(?![0-9])/u.test(failure.code ?? "")) return true;
  return /sign[ _-]?in|log[ _-]?in|logged[ _-]?in|authenticat|unauthori[sz]ed|forbidden|api[ _-]?key|credential|subscription|upgrade your plan|quota|rate[ _-]?limit|too many requests|credit|balance|billing|payment|insufficient[ _-]?fund|usage[ _-]?limit|\b(?:status(?:[ _]?code)?|http(?:\/\d(?:\.\d)?)?|code)"?\s*[:=]?\s*(?:401|402|403|429)(?![0-9])|\berror"?\s*[:=]\s*(?:401|402|403|429)(?![0-9])|^\s*(?:401|402|403|429)\b|econn(?:reset|refused|aborted)|enotfound|etimedout|ehost(?:down|unreach)|enetunreach|eai_again|socket hang up|connection (?:reset|refused|closed|error|lost)|network (?:error|is unreachable)|fetch failed|getaddrinfo/iu.test(
    `${failure.code ?? ""} ${failure.message}`,
  );
}

/**
 * Failures outside the model and its account: the provider's own filter refusing the prompt,
 * a workspace SSHCode could not prepare, or a harness that crashed before the model said
 * anything.
 */
export function isInfrastructureFailure(
  failure: OrchestrationV2ProviderFailure,
  hasAssistantOutput: boolean | undefined,
): boolean {
  if (failure.code === ORCHESTRATION_V2_WORKSPACE_PREPARATION_FAILURE_CODE) return true;
  const text = `${failure.code ?? ""} ${failure.message}`;
  if (/flagged as potentially violating|violat\w* (?:our |the )?usage polic/iu.test(text))
    return true;
  // A JSON-RPC internal error is the harness failing, unless the model had already answered.
  return hasAssistantOutput === false && failure.code === "-32603";
}

/** A provider outage before any assistant output is not a model result. */
function isProviderOutage(failure: OrchestrationV2ProviderFailure): boolean {
  if (/^\D{0,12}5\d{2}(?![0-9])/u.test(failure.code ?? "")) return true;
  return /api[ _-]?error|(?:retry[ _-]?exhausted|retries exhausted|exhausted retries|retry limit|maximum retries|max retries)|overloaded|\b(?:status(?:[ _]?code)?|http(?:\/\d(?:\.\d)?)?|code)"?\s*[:=]?\s*5\d{2}(?![0-9])|\berror"?\s*[:=]\s*5\d{2}(?![0-9])|^\s*5\d{2}\b/iu.test(
    `${failure.code ?? ""} ${failure.message}`,
  );
}

/** Titles, workspace isolation and workflow labels are metadata; prompts never enter rankings. */
export function terminalRunRecord(
  task: OrchestrationV2Subagent,
  metadata: {
    readonly title?: string;
    readonly isolated: boolean;
    readonly fixRounds: number;
    readonly hasAssistantOutput?: boolean;
    readonly provider?: ServerProvider;
    /** Provider failure from this task's result run. */
    readonly providerFailure?: OrchestrationV2ProviderFailure;
  },
): RunRecord | undefined {
  if (
    task.origin !== "app_owned" ||
    task.title?.startsWith("Council: ") ||
    metadata.title?.startsWith("Council: ") ||
    (task.status === "failed" &&
      metadata.providerFailure !== undefined &&
      (isAccountFailure(metadata.providerFailure) ||
        isInfrastructureFailure(metadata.providerFailure, metadata.hasAssistantOutput) ||
        (metadata.hasAssistantOutput === false && isProviderOutage(metadata.providerFailure)))) ||
    (task.status !== "completed" &&
      task.status !== "failed" &&
      task.status !== "cancelled" &&
      task.status !== "interrupted")
  )
    return;
  const model = task.modelSelection?.model ?? task.model;
  if (!model) return;
  const finishedAt = DateTime.toEpochMillis(task.completedAt ?? task.updatedAt);
  // The role is data on the task. Tasks from before 2026-11-10 carry it as an app-written first
  // line of the brief instead; only that exact wrapper counts, never other prompt text.
  const role =
    task.role ??
    /^Act as the (implementation|research|review|design|test) sub-agent for this task\.\n\n/.exec(
      task.prompt.slice(0, 100),
    )?.[1];
  const roleKind =
    role === "design"
      ? "ui"
      : role === "implementation" || role === "test"
        ? "code"
        : role === "review" || role === "research"
          ? role
          : undefined;
  const catalogModel = metadata.provider?.models.find((candidate) => candidate.slug === model);
  return {
    taskId: task.id,
    instanceId: task.modelSelection?.instanceId ?? task.providerInstanceId,
    model,
    family: modelRankingFamily(
      catalogModel ?? { slug: model },
      metadata.provider ?? { driver: task.driver },
    ),
    kind:
      roleKind ??
      inferTaskKind(
        `${task.title ?? ""} ${metadata.title ?? ""} ${task.workflow?.name ?? ""}`,
        metadata.isolated,
      ),
    outcome: task.status,
    elapsedMs:
      task.startedAt === null
        ? 0
        : Math.max(0, finishedAt - DateTime.toEpochMillis(task.startedAt)),
    fixRounds: metadata.fixRounds,
    finishedAt,
  };
}
