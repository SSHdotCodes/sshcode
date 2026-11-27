import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderFailure,
} from "@t3tools/contracts";
import {
  classifyProviderFailure,
  isModelGoneFailure,
  makeProviderFailure,
} from "@t3tools/provider-core/server/failure";
import { modelRankingSelectionKey } from "@t3tools/shared/modelRankings";
import * as DateTime from "effect/DateTime";

const MAX_MODELS = 300;
const MAX_RUNS = 500;
// Routes without usage readings (OpenCode, Qwen, Kimi) fail for hours: leads came back
// to the same one within 2 h, so a failure stays until the route completes a run.
const TTL_MS = 6 * 60 * 60_000;

/** A route-level reason: a usage limit, an account failure or a usage-policy flag. */
type ModelFailureKind =
  | "usage_limit"
  | "billing_error"
  | "subscription_error"
  | "authentication_error"
  | "permission_error"
  | "policy";

export interface ModelFailure {
  readonly count: number;
  readonly at: number;
  readonly message: string;
  /** Absent for a provider error. */
  readonly kind?: ModelFailureKind;
}

const KIND_LABEL: Record<ModelFailureKind, string> = {
  usage_limit: "usage limit",
  billing_error: "out of credit",
  subscription_error: "not in plan",
  authentication_error: "signed out",
  permission_error: "permission denied",
  policy: "usage policy flag",
};

// OpenAI's "flagged as potentially violating our usage policy", Claude's safeguards and
// Codex's safety stop; adapters report these under several classes.
const POLICY_FLAG =
  /\b(?:usage|safety|content) polic(?:y|ies)\b|\bsafeguards flagged\b|\bflagged as potentially violating\b/iu;

/** Why a failed run counts against its route: null for a provider error, undefined when it does not. */
function failureKind(
  failure: Pick<OrchestrationV2ProviderFailure, "class" | "message" | "code">,
): ModelFailureKind | null | undefined {
  if (POLICY_FLAG.test(failure.message)) return "policy";
  switch (failure.class) {
    case "provider_error":
    case "usage_limit":
    case "billing_error":
    case "subscription_error":
    case "authentication_error":
    case "permission_error": {
      // A missing model is recorded as unavailable instead.
      if (isModelGoneFailure(failure)) return undefined;
      const kind = classifyProviderFailure(failure.message, failure.code) ?? failure.class;
      return kind === "provider_error" ? null : kind;
    }
    // Transport and request errors belong to the run, not the route.
    default:
      return undefined;
  }
}

/** Keeps the provider's message, leaving diagnostic payloads and credentials behind. */
function failureMessage(message: string): string {
  const http = /\bHTTP(?:\/[\d.]+)?\s+([45]\d{2})\b/iu.exec(message)?.[1];
  const quoted = /"message"\s*:\s*("(?:[^"\\]|\\.)*")/u.exec(message)?.[1];
  let words = message;
  if (quoted) {
    try {
      words = JSON.parse(quoted) as string;
    } catch {
      words = "Provider request failed.";
    }
  } else {
    // A truncated JSON response must not expose its remaining fields.
    words = words.split(/[[{]/u, 1)[0]!;
  }
  words = makeProviderFailure({ message: words })
    .message.replace(/\bPlease refer to\s+https?:\/\/\S+\s+for more details\.?/giu, "")
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, "")
    .replace(
      /\b(?:request|trace|correlation)[ _-]?id["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "",
    )
    .replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/giu, "")
    .replace(/\breq[_-][\w-]+\b/giu, "")
    .replace(/\bAIza[\w-]{20,}\b/gu, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim();
  words = words.replace(/^Provider request failed with /iu, "");
  if (http && !/^HTTP(?:\/[\d.]+)?\s+\d{3}\b/iu.test(words)) words = `HTTP ${http} ${words}`.trim();
  words ||= "Provider request failed.";
  return words.length <= 120 ? words : `${words.slice(0, 119)}…`;
}

/** Volatile run deduplication and streaks, keyed by the exact instance and model. */
export function makeModelFailureTracker() {
  const runs = new Map<string, { key: string; counted: boolean; completed: boolean }>();
  const failures = new Map<string, ModelFailure>();
  const expire = (now: number) => {
    for (const [key, failure] of failures) {
      if (now - failure.at >= TTL_MS) failures.delete(key);
    }
  };
  return {
    record(event: OrchestrationV2DomainEvent): void {
      if (event.type === "run.created" || event.type === "run.updated") {
        const run = event.payload;
        const key = modelRankingSelectionKey({
          instanceId: run.providerInstanceId,
          model: run.modelSelection.model,
        });
        const previous = runs.get(run.id);
        runs.delete(run.id);
        runs.set(run.id, {
          key,
          counted: previous?.counted ?? false,
          completed: run.status === "completed",
        });
        if (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value!);
        // A run can end completed after its own failure (OpenCode's Go limit).
        if (run.status === "completed" && !previous?.counted) failures.delete(key);
        return;
      }
      if (
        event.type !== "turn-item.updated" ||
        event.payload.type !== "error" ||
        event.payload.status !== "failed"
      )
        return;
      const now = DateTime.toEpochMillis(event.occurredAt);
      expire(now);
      const runId = event.payload.runId ?? event.runId;
      const run = runId ? runs.get(runId) : undefined;
      if (!run || run.counted || run.completed) return;
      const failure = event.payload.failure;
      const kind = failureKind(failure);
      if (kind === undefined) return;
      run.counted = true;
      const count = (failures.get(run.key)?.count ?? 0) + 1;
      failures.delete(run.key);
      failures.set(run.key, {
        count,
        at: now,
        message: failureMessage(failure.message),
        ...(kind === null ? {} : { kind }),
      });
      if (failures.size > MAX_MODELS) failures.delete(failures.keys().next().value!);
    },
    snapshot(now: number): ReadonlyMap<string, ModelFailure> {
      expire(now);
      return new Map(failures);
    },
  };
}

export function modelFailureNote(failure: ModelFailure, now: number): string {
  const minutes = Math.max(0, Math.floor((now - failure.at) / 60_000));
  const ago =
    minutes === 0
      ? "just now"
      : minutes < 60
        ? `${minutes}m ago`
        : `${Math.floor(minutes / 60)}h${minutes % 60 === 0 ? "" : ` ${minutes % 60}m`} ago`;
  const streak = `${failure.count} failed in a row, last ${ago}`;
  if (failure.kind === undefined) return `${streak}: ${failure.message}`;
  const label = KIND_LABEL[failure.kind];
  return `${failure.count === 1 ? `${label} ${ago}` : `${label}, ${streak}`}: ${failure.message}`;
}

export function modelFailureNotice(model: string, failure: ModelFailure): string {
  return `${model} failed its last ${failure.count} ${failure.count === 1 ? "run" : "runs"}: ${failure.message}`;
}
