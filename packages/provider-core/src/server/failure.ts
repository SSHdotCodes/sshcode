import type {
  NodeId,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderFailureClass,
  OrchestrationV2ProviderRetry,
  OrchestrationV2TurnItem,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Cause from "effect/Cause";

import * as IdAllocator from "./IdAllocator.ts";
import * as Schema from "effect/Schema";

/** Raised when portable history does not fit the target provider's context window. */
export class ContextHandoffBudgetError extends Schema.TaggedError<ContextHandoffBudgetError>()(
  "ContextHandoffBudgetError",
  {},
) {
  override get message() {
    return "Insufficient context allowance for the provider handoff. Compact the target conversation or use a larger-context model; the current request has not been truncated.";
  }
}

export const MAX_PROVIDER_FAILURE_MESSAGE_LENGTH = 4_096;
export const MAX_PROVIDER_FAILURE_CODE_LENGTH = 128;

const DEFAULT_PROVIDER_FAILURE_MESSAGE = "Provider turn failed.";

const MAX_DETAIL_LENGTH = 600;

function detailText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replaceAll(/\s+/gu, " ").trim();
  return text.length === 0 ? undefined : text.slice(0, MAX_DETAIL_LENGTH);
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/**
 * What the agent said went wrong. ACP agents that let an API error escape get
 * it wrapped as "Internal error" with the real text in `data.details`, or with
 * the API's own JSON error body as `data`.
 */
function requestErrorDetail(data: unknown): string | undefined {
  return (
    detailText(data) ??
    detailText(field(data, "details")) ??
    detailText(field(data, "message")) ??
    detailText(field(data, "error")) ??
    detailText(field(field(data, "error"), "message"))
  );
}

/** The text of a protocol error, with the agent's explanation when it sent one. */
export function acpRequestErrorMessage(cause: {
  readonly errorMessage: string;
  readonly data?: unknown;
}): string {
  const detail = requestErrorDetail(cause.data);
  if (detail === undefined || cause.errorMessage.includes(detail)) return cause.errorMessage;
  // The JSON-RPC title for an uncaught error says nothing next to the detail.
  return /^internal error$/iu.test(cause.errorMessage.trim())
    ? detail
    : `${cause.errorMessage}: ${detail}`;
}

/** Upstream HTTP errors may be nested inside a JSON-RPC Internal error. */
function rpcReports429(cause: Record<string, unknown>): boolean {
  const data = cause.data;
  const nested = field(data, "error");
  return [
    cause.code,
    field(data, "status"),
    field(data, "statusCode"),
    field(data, "code"),
    field(nested, "code"),
    field(nested, "statusCode"),
  ].some((status) => status === 429 || status === "429");
}

/** Translate known categories without exposing arbitrary provider defect text. */
function causeDetails(
  cause: unknown,
  knownOnly = false,
): {
  readonly message: string | undefined;
  readonly usageLimit?: boolean;
} {
  const seen = new Set<unknown>();
  let message: string | undefined;
  let summary: string | undefined;
  for (let depth = 0; depth < 16 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (typeof cause !== "object") break;
      const record = cause as Record<string, unknown>;
      switch (record._tag) {
        case "ContextHandoffBudgetError":
          return { message: new ContextHandoffBudgetError().message };
        case "ProviderCompactionUnsupportedError":
        case "AcpModelSelectionError":
        case "ClaudeBackgroundWorkBlocksQueryReplacementError":
        case "ClaudeMcpRegistrationTimeoutError":
          return { message: stringField(cause, "message") };
        case "CodexAppServerRequestError":
          if (record.operation === "receive-response") {
            return { message: stringField(cause, "message"), usageLimit: rpcReports429(record) };
          }
          break;
        case "AcpRequestError": {
          if (typeof record.errorMessage === "string") {
            const detail = acpRequestErrorMessage({
              errorMessage: record.errorMessage,
              data: record.data,
            });
            if (rpcReports429(record) || classifyProviderFailure(detail, null) === "usage_limit")
              return { message: detail, usageLimit: true };
          }
          if (record.code === -32000)
            return {
              message:
                "The provider needs you to sign in. Sign in from its provider settings or with its own CLI or app, then retry the turn.",
            };
          break;
        }
        case "CommandExecutionError": {
          const rejection = stringField(cause, "message");
          if (
            record.command === "goal" &&
            rejection !== undefined &&
            /^A goal objective is limited to \d{1,6} characters \(got \d{1,9}\)\.$/u.test(rejection)
          ) {
            return {
              message: `OpenCode rejected the goal: ${rejection} Shorten it and send /goal again.`,
            };
          }
          break;
        }
        case "AcpProcessExitedError": {
          const stage = summary === undefined ? "The provider" : `${summary}: the provider`;
          return {
            message: `${stage} process exited${processExitStatus(cause)}. Check the server logs for the provider's output, then retry the turn.`,
          };
        }
        case "ContextHandoffDeliveryUncertainError":
          return {
            message:
              "SSHCode could not confirm whether conversation history reached the provider. Retry the turn to recover the session.",
          };
        case "ProviderAdapterTurnStartError":
          summary = "The provider could not start this turn";
          message =
            "The provider could not start this turn. Retry the turn; if it keeps failing, check the provider setup and server logs.";
          break;
        case "ProviderAdapterEventStreamError":
          summary = "The provider event stream closed unexpectedly";
          message =
            "The provider event stream closed unexpectedly. Retry the turn; if it keeps failing, check the provider and server logs.";
          break;
        case "ProviderAdapterOpenSessionError":
          summary = "The provider session could not be opened";
          message =
            "The provider session could not be opened. Check that the provider is installed and signed in, then retry the turn.";
          break;
        case "ProviderAdapterResumeThreadError":
          summary = "The provider conversation could not be resumed";
          message =
            "The provider conversation could not be resumed. Retry the turn; if it keeps failing, check the provider and server logs.";
          break;
      }
      cause = (cause as Record<string, unknown>).cause;
    } catch {
      break;
    }
  }
  return { message: knownOnly ? undefined : message };
}

/** Domain-authored text that must survive a provider startup wrapper. */
export function knownProviderFailureMessage(cause: unknown): string | undefined {
  return causeDetails(cause, true).message;
}

/**
 * The innermost error behind startup wrappers: its tag (or error name) as a short
 * kind and its own message. Pass both to `makeProviderFailure`, which bounds and
 * redacts them, so a run that fails before its provider turn keeps the real cause.
 */
export function providerFailureRootCause(cause: unknown): {
  readonly kind: string | null;
  readonly message: string | undefined;
} {
  const seen = new Set<unknown>();
  let kind: string | null = null;
  let message: string | undefined;
  for (let depth = 0; depth < 16 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    try {
      if (Cause.isCause(cause)) {
        cause = Cause.squash(cause);
        continue;
      }
      if (typeof cause === "string") {
        if (cause.trim().length > 0) message = cause;
        break;
      }
      if (typeof cause !== "object") break;
      const record = cause as Record<string, unknown>;
      const tag = record._tag;
      if (typeof tag === "string" && tag.length > 0) kind = tag;
      // A bare `Error` says less than the tagged error that wrapped it.
      else if (cause instanceof Error && cause.name.length > 0 && cause.name !== "Error")
        kind = cause.name;
      const own = stringField(cause, "message");
      if (own !== undefined && own.trim().length > 0) message = own;
      cause = record.cause;
    } catch {
      break;
    }
  }
  return { kind, message };
}

// Keep process output private while exposing the structured exit status.
function processExitStatus(exited: object): string {
  const { signal, code } = exited as Record<string, unknown>;
  if (typeof signal === "string" && /^SIG[A-Z0-9]{1,16}$/u.test(signal)) {
    return ` after signal ${signal}`;
  }
  return typeof code === "number" && Number.isSafeInteger(code) ? ` with code ${code}` : "";
}

function stringField(value: unknown, key: "message" | "code"): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try {
    const candidate = (value as Record<string, unknown>)[key];
    return typeof candidate === "string" ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function redactUrl(match: string): string {
  const trailing = /[),.;!?]+$/u.exec(match)?.[0] ?? "";
  const candidate = trailing.length === 0 ? match : match.slice(0, -trailing.length);
  try {
    const url = new URL(candidate);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.toString()}${trailing}`;
  } catch {
    return "[REDACTED_URL]";
  }
}

function replaceUnsafeControlCharacters(value: string): string {
  const sanitized: Array<string> = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized.push(
      codePoint <= 0x08 ||
        (codePoint >= 0x0b && codePoint <= 0x0c) ||
        (codePoint >= 0x0e && codePoint <= 0x1f) ||
        codePoint === 0x7f
        ? " "
        : character,
    );
  }
  return sanitized.join("");
}

/** Removes common credential forms before provider text crosses a transport boundary. */
function redactProviderFailureText(value: string): string {
  return replaceUnsafeControlCharacters(value)
    .replace(/\bhttps?:\/\/[^\s<>"']+/giu, redactUrl)
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/giu, "$1 [REDACTED]")
    .replace(
      /(["'][\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)["']\s*:\s*["'])[^"']*(["'])/giu,
      "$1[REDACTED]$2",
    )
    .replace(
      /((?<![\w-])[\w-]*(?:access[_-]?token|api[_-]?key|authorization|credential|password|secret|token)\b\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
      "$1[REDACTED]",
    )
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, "[REDACTED]")
    .trim();
}

function boundedText(value: string, maxLength: number): string {
  const redacted = redactProviderFailureText(value);
  if (redacted.length <= maxLength) return redacted;
  let end = Math.max(0, maxLength - 1);
  const finalCodeUnit = redacted.charCodeAt(end - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
    end -= 1;
  }
  return `${redacted.slice(0, end)}…`;
}

const PROVIDER_BUSY =
  /resource (?:has been )?exhausted|try again later|overloaded|(?:over|at) capacity|temporarily unavailable|server (?:is )?busy|high (?:traffic|demand)/iu;
const OWN_ALLOWANCE =
  /usage limit|usageLimitExceeded|rate limit|too many requests|quota|per (?:minute|hour|day)|\b(?:daily|weekly|monthly|session|5 hour)\b|resets? (?:at|in|on)\b|\bupgrade\b|\bplan\b|\bcredits?\b|billing/iu;

/**
 * Capacity wording alone can describe a transient outage. The HTTP status
 * and native limit codes take precedence when classifying a failure.
 */
export function isProviderBusyMessage(message: string): boolean {
  const text = message.replaceAll(/[_-]/gu, " ");
  return PROVIDER_BUSY.test(text) && !OWN_ALLOWANCE.test(text);
}

/** The title of a failed provider request. */
function providerFailureTitle(failure: OrchestrationV2ProviderFailure): string {
  return (
    providerAccountFailureReason(failure.class) ??
    (failure.class === "usage_limit"
      ? "Usage limit reached"
      : failure.class === "provider_error" && isProviderBusyMessage(failure.message)
        ? "Provider busy. Try again in a moment."
        : "Provider error")
  );
}

/** Classifies provider API text at the adapter boundary, before generic fallbacks hide it. */
export function classifyProviderFailure(message: string, code: string | null, statusCode?: number) {
  const text = `${code ?? ""} ${message}`.replaceAll(/[_-]/gu, " ");
  const status =
    statusCode ??
    Number(
      /^(?:api_error_)?(401|402|403|429)$/u.exec(code ?? "")?.[1] ??
        /\b(?:HTTP(?:\/[\d.]+)?|status(?: code)?|API Error|error (?:code|response))[: =]*(401|402|403|429)\b/iu.exec(
          message,
        )?.[1],
    );
  if (
    status === 429 ||
    /^429\b/u.test(message.trimStart()) ||
    /^(?:provider\.(?:rate-limit|go-limit|quota)|insufficient_quota|rate_limit_error|usageLimitExceeded|rateLimitExceeded|sessionBudgetExceeded)$/iu.test(
      code ?? "",
    ) ||
    /\brequires more credits,? or fewer max tokens\b/iu.test(text) ||
    (!/\b(?:disk|storage|filesystem) quota\b/iu.test(text) &&
      /\busage limit (?:has been |is )?(?:reached|exceeded|exhausted)\b|\bquota (?:has been |is )?(?:reached|exhausted|exceeded|depleted)\b|\b(?:exceeded|exhausted|depleted) (?:(?:your|its|the|current|daily|weekly|monthly|token|account) )*quota\b|\binsufficient (?:token )?quota\b|\bVibe budget exhausted\b/iu.test(
        text,
      ))
  )
    return "usage_limit" as const;
  // An entitlement may be reported as 401/403/402: prefer its explicit reason.
  if (
    /(?:model|access)[^\n]{0,120}(?:not (?:included|available|supported)|unavailable)[^\n]{0,80}(?:plan|subscription)|model[^\n]{0,120}not supported[^\n]{0,80}ChatGPT account|(?:plan|subscription)[^\n]{0,100}(?:does not|doesn't|doesn’t|not)[^\n]{0,60}(?:include|support|allow|access)|(?:subscription|upgrade|paid plan)[ _-]?(?:is )?required|not subscribed|model[ _-]not[ _-]in[ _-]plan/iu.test(
      text,
    )
  )
    return "subscription_error" as const;
  if (
    !/\b(?:token|context|reasoning|retry) budget\b/iu.test(text) &&
    /insufficient(?: user)?[ _-]?(?:quota|credits?|balance|funds)|exceeded your current quota|(?:credit(?:s| balance)?|balance|budget|spend(?:ing)? limit)[^\n]{0,80}(?:exhausted|exceeded|depleted|reached|insufficient|too low)|(?:exhausted|exceeded|depleted|reached)[^\n]{0,80}(?:credits?|budget|spend(?:ing)? limit)|(?:out of|no(?: remaining)?|not enough)[ _-](?:credits?|budget|funds)|billing[ _-](?:hard[ _-]limit|limit|error)|payment[ _-]required/iu.test(
      text,
    )
  )
    return "billing_error" as const;
  if (
    /unauthenticated|not authenticated|unauthorized|(?:auth|authentication)[ _-]?(?:required|failed|error)|(?:failed to|could not|couldn't|unable to) authenticate\b|oauth[^\n]{0,40}(?:expired|revoked|could not be refreshed)|providerautherror|(?:signed|logged) out|no api[ _-]?key|not (?:logged|signed) in|(?:sign|log)[ -]?in (?:again|required)|(?:invalid|expired|revoked|missing|incorrect)[^\n]{0,40}(?:api[ _-]?key|token|credential)|(?:api[ _-]?key|token|credential)[^\n]{0,40}(?:invalid|expired|revoked|missing|incorrect)/iu.test(
      text,
    )
  )
    return "authentication_error" as const;
  if (
    !/\b(?:tool|sandbox|file|directory|EACCES|EPERM)\b/iu.test(message) &&
    /permission[ _-]?(?:denied|error)|access[ _-]?denied|forbidden|not authorized|(?:do(?:es)? not|don't|doesn't) have access/iu.test(
      text,
    )
  )
    return "permission_error" as const;
  if (status === 401) return "authentication_error" as const;
  if (status === 402) return "billing_error" as const;
  if (status === 403) return "permission_error" as const;
  if (isProviderBusyMessage(message)) return "provider_error" as const;
  if (
    /rate[ _-]?limit(?:ed| exceeded| reached|_error)?|too many requests|usageLimitExceeded/iu.test(
      text,
    )
  )
    return "usage_limit" as const;
  return undefined;
}

// A model id: quoted, or containing a digit, dot, slash or hyphen ("gemini-3.1-pro"), so
// "model provider not found" is not read as a missing model.
const MODEL_ID = String.raw`(?:\s*[:=]?\s*(?:["'\x60][^"'\x60\s]{1,120}["'\x60]|[\w.:@/-]*[\d./-][\w.:@/-]*))?`;
const MODEL_GONE = new RegExp(
  [
    String.raw`\bmodel\b${MODEL_ID}\s+(?:has been|is now|is|was|has)\s+(?:been\s+)?(?:deprecated|retired|decommissioned|discontinued|removed|sunset)\b`,
    String.raw`\bmodel\b${MODEL_ID}\s+is\s+no\s+longer\s+(?:available|supported|served|offered)\b`,
    String.raw`\bmodel\b${MODEL_ID}\s+(?:does not|doesn't)\s+exist\b`,
    String.raw`\bmodel\b${MODEL_ID}\s+not\s+found\b`,
    String.raw`\bmodel[_ ]not[_ ]found\b`,
    String.raw`\b(?:unknown|nonexistent|non-existent|deprecated|retired|decommissioned)\s+model\b`,
  ].join("|"),
  "iu",
);

/**
 * A failed run whose provider says the model itself is gone (deprecated, retired,
 * decommissioned, no longer available, unknown or nonexistent). Limits, credit,
 * sign-in, plan and capacity failures never count, even when they name the model.
 */
export function isModelGoneFailure(
  failure: Pick<OrchestrationV2ProviderFailure, "class" | "message" | "code">,
): boolean {
  if (
    failure.class !== "provider_error" &&
    failure.class !== "validation_error" &&
    failure.class !== "unknown"
  )
    return false;
  if (
    classifyProviderFailure(failure.message, failure.code) !== undefined ||
    isProviderBusyMessage(failure.message)
  )
    return false;
  return MODEL_GONE.test(`${failure.code ?? ""} ${failure.message}`);
}

/** The action needed before an account can serve another run. */
export function providerAccountFailureReason(kind: OrchestrationV2ProviderFailureClass) {
  switch (kind) {
    case "billing_error":
      return "Budget exhausted. Add credits or raise the spending limit.";
    case "subscription_error":
      return "Model not in plan. Change model or subscription.";
    case "authentication_error":
      return "Signed out. Sign in again.";
    case "permission_error":
      return "Permission denied. Check account access.";
    default:
      return undefined;
  }
}

/** What a signed-out account needs, naming the command that signs it in again when one is known. */
export function signedOutReason(signInCommand: string | undefined): string {
  return signInCommand === undefined
    ? "Signed out. Sign in again."
    : `Signed out. Sign in again with \`${signInCommand}\`.`;
}

// Optional provider metadata must never prevent a caller from settling the turn.
const formatResetAt = Option.liftThrowable((resetAt: string) => {
  const zoned = resetAt.replace(/^(\d{4}-\d{2}-\d{2}) /u, "$1T").replace(/ UTC$/iu, "Z");
  const epoch = Date.parse(zoned);
  return DateTime.formatIso(DateTime.makeUnsafe(epoch));
});

export function makeProviderFailure(input: {
  readonly cause?: unknown;
  readonly message?: string | undefined;
  readonly code?: string | null | undefined;
  readonly class?: OrchestrationV2ProviderFailureClass;
  readonly retryable?: boolean | null;
  readonly resetAt?: string | null;
  readonly statusCode?: number | undefined;
}): OrchestrationV2ProviderFailure {
  const details = input.cause == null ? undefined : causeDetails(input.cause);
  const rawMessage = input.message ?? details?.message ?? DEFAULT_PROVIDER_FAILURE_MESSAGE;
  const message = boundedText(rawMessage, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
  const rawCode = input.code ?? stringField(input.cause, "code") ?? null;
  const code =
    rawCode === null ? null : boundedText(rawCode, MAX_PROVIDER_FAILURE_CODE_LENGTH) || null;
  // Only API failures are inferred. Validation, transport and local startup
  // failures retain their own categories; arbitrary cause text stays private.
  const failureClass =
    details?.usageLimit || input.statusCode === 429
      ? "usage_limit"
      : input.class !== undefined &&
          input.class !== "usage_limit" &&
          input.class !== "transport_error" &&
          input.class !== "validation_error" &&
          input.class !== "unknown"
        ? (classifyProviderFailure(message, code, input.statusCode) ?? input.class)
        : (input.class ?? "unknown");
  const accountFailure = providerAccountFailureReason(failureClass) !== undefined;
  const usageLimit = failureClass === "usage_limit";
  // Only absolute, zoned timestamps identify a reset across server time zones.
  const resetAt =
    input.resetAt ??
    (usageLimit
      ? /\bresets? at\s+(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}| UTC))\b/iu.exec(
          message,
        )?.[1]
      : undefined);

  const reset =
    (usageLimit || accountFailure) && resetAt != null ? formatResetAt(resetAt) : Option.none();

  return {
    class: failureClass,
    message: message || DEFAULT_PROVIDER_FAILURE_MESSAGE,
    code,
    retryable: usageLimit || accountFailure ? false : (input.retryable ?? null),
    ...(Option.isSome(reset) ? { resetAt: reset.value } : {}),
  };
}

export function makeProviderFailureTurnItem(input: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry?: OrchestrationV2ProviderRetry;
  readonly retryStartedAt?: DateTime.Utc;
  readonly occurredAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  return {
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: "failed",
    title: providerFailureTitle(input.failure),
    startedAt: input.retryStartedAt ?? input.occurredAt,
    completedAt: input.occurredAt,
    updatedAt: input.occurredAt,
    type: "error",
    failure: input.failure,
    ...(input.retry === undefined ? {} : { retry: input.retry }),
  };
}

/**
 * Longest a turn may stay in provider retries before the adapter stops it as
 * failed. A hung Claude request can take many minutes per attempt, so counting
 * attempts alone never ends it.
 */
export const PROVIDER_RETRY_BUDGET_MS = 10 * 60 * 1000;

export function makeProviderRetryTurnItem(input: {
  readonly driver: ProviderDriverKind;
  readonly threadId: ThreadId;
  readonly runId: RunId | null;
  readonly nodeId: NodeId | null;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly itemOrdinal: number;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly retry: OrchestrationV2ProviderRetry;
  readonly status: Extract<
    OrchestrationV2TurnItem["status"],
    "running" | "completed" | "failed" | "interrupted" | "cancelled"
  >;
  readonly startedAt: DateTime.Utc;
  readonly updatedAt: DateTime.Utc;
}): Extract<OrchestrationV2TurnItem, { readonly type: "error" }> {
  const completed = input.status !== "running";
  let title = "Provider retry";
  if (input.status === "completed") {
    title = "Provider recovered";
  } else if (input.status === "failed") {
    title = providerFailureTitle(input.failure);
  } else if (input.status === "interrupted" || input.status === "cancelled") {
    title = "Provider retry stopped";
  }
  return {
    id: IdAllocator.derive.turnItemFromProviderItem({
      driver: input.driver,
      nativeItemId: `terminal-failure:${input.providerTurnId}`,
    }),
    threadId: input.threadId,
    runId: input.runId,
    nodeId: input.nodeId,
    providerThreadId: input.providerThreadId,
    providerTurnId: input.providerTurnId,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: input.itemOrdinal,
    status: input.status,
    title,
    startedAt: input.startedAt,
    completedAt: completed ? input.updatedAt : null,
    updatedAt: input.updatedAt,
    type: "error",
    failure: input.failure,
    retry: input.retry,
  };
}
