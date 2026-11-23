import { formatOutOfCredit } from "@t3tools/client-runtime/providerHealth";
import { activeProviderFailure, type ServerProvider } from "@t3tools/contracts";
import { providerAccountFailureReason } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";

/**
 * Without a model, only failures covering the whole account apply. Out of credit, or
 * signed out with a limits read that failed too (no retry time), it stands until fixed.
 */
export function accountUnavailable(provider: ServerProvider, now: number, model?: string) {
  const failure = activeProviderFailure(provider, now, model);
  if (
    !failure ||
    (failure.kind !== "usage_limit" && providerAccountFailureReason(failure.kind) === undefined)
  )
    return undefined;
  if (failure.outOfCredit) return { reason: formatOutOfCredit(failure) };
  if (failure.kind === "authentication_error" && failure.resetAt === undefined)
    return { reason: failure.message };
  const recheckAt =
    failure.resetAt ??
    DateTime.formatIso(
      DateTime.makeUnsafe(
        Date.parse(failure.occurredAt) + (failure.kind === "usage_limit" ? 5 : 60) * 60_000,
      ),
    );
  if (Date.parse(recheckAt) <= now) return undefined;
  return {
    reason: failure.kind === "usage_limit" ? "Usage limit reached." : failure.message,
    recheckAt,
  };
}
