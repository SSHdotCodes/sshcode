import {
  MAX_AUTOMATIC_PROVIDER_RETRIES,
  type OrchestrationV2AutomaticProviderRetry,
  type OrchestrationV2ProviderFailure,
} from "@t3tools/contracts";
import { isProviderBusyMessage } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000, 120_000] as const;
const ACCOUNT_CODE =
  /auth|unauthoriz|forbidden|quota|credit|usage.?limit|billing|payment|api_error_(?:401|402|403)/iu;
const RATE_LIMIT_CODE = /rate.?limit|api_error_429|^429$/iu;
// A 429 is the provider's limit whatever its words ("Resource exhausted. Please try again
// later."). The harness has retried it already, so another turn only meets it again:
// on 2026-11-16 five retries of Vertex's 429 held a subagent for 15 minutes.
const LIMIT_MESSAGE =
  /\bHTTP 429\b|"code":\s*429\b|\bRESOURCE_EXHAUSTED\b|resource (?:has been )?exhausted/iu;

/** Only terminal provider failures opt in; tool failures never reach this policy. */
export function nextAutomaticProviderRetry(
  failure: OrchestrationV2ProviderFailure,
  previous: OrchestrationV2AutomaticProviderRetry | undefined,
  now: DateTime.Utc,
): OrchestrationV2AutomaticProviderRetry | undefined {
  const code = failure.code ?? "";
  const limited = RATE_LIMIT_CODE.test(code) || LIMIT_MESSAGE.test(failure.message);
  // An overloaded or briefly unavailable model passes in moments, and most harnesses
  // leave the retry flag unset for it. It is retried unless the provider ruled that out.
  const busy = failure.class === "provider_error" && isProviderBusyMessage(failure.message);
  if (
    (failure.class !== "provider_error" && failure.class !== "transport_error") ||
    // A provider's retry flag must never override an explicit account failure or a limit.
    ACCOUNT_CODE.test(code) ||
    /^api_error_(?:404|501)$/u.test(code) ||
    limited ||
    (busy ? failure.retryable === false : failure.retryable !== true)
  )
    return undefined;
  const completedRetries = previous?.attempt ?? 0;
  if (completedRetries >= MAX_AUTOMATIC_PROVIDER_RETRIES) {
    return { attempt: MAX_AUTOMATIC_PROVIDER_RETRIES, status: "exhausted", scheduledAt: null };
  }
  return {
    attempt: completedRetries + 1,
    status: "scheduled",
    scheduledAt: DateTime.formatIso(
      DateTime.makeUnsafe(DateTime.toEpochMillis(now) + RETRY_DELAYS_MS[completedRetries]!),
    ),
  };
}
