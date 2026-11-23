import type { ServerProviderUsageLimits } from "@t3tools/contracts";

// Two default health checks leave room for an in-flight probe.
export const USAGE_LIMIT_STALE_AFTER_MS = 10 * 60_000;

export function isUsageLimitReadingStale(limits: ServerProviderUsageLimits, now: number): boolean {
  const checkedAt = Date.parse(limits.checkedAt);
  return (
    !Number.isFinite(checkedAt) ||
    now - checkedAt > USAGE_LIMIT_STALE_AFTER_MS ||
    limits.windows.some(
      (window) => window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now,
    )
  );
}

/**
 * What an instance publishes when its probe could not read any limits: the windows of its last
 * reading, still dated `checkedAt` when they were read, beside the failure's notice. Clients tell
 * this older reading from a live one by `unavailable.reason === "probeFailed"` with windows.
 *
 * A window whose reset has passed no longer means anything and is dropped, as is an undated one
 * a whole window length older than now. With nothing left, the failure is published as it is.
 * Live readings and `unsupported` never come through here, and `last` may itself be such an
 * older reading, which then only loses windows.
 */
export function withLastUsageReading(
  failed: ServerProviderUsageLimits,
  last: ServerProviderUsageLimits | undefined,
  now: number,
): ServerProviderUsageLimits {
  if (failed.unavailable?.reason !== "probeFailed" || failed.windows.length > 0) return failed;
  if (last === undefined || last.unavailable?.reason === "unsupported") return failed;
  const readAt = Date.parse(last.checkedAt);
  if (!Number.isFinite(readAt) || readAt > now) return failed;
  // The measured pace belonged to that moment; pace warnings must not fire from it.
  const windows = last.windows.flatMap(({ recentPercentPerHour: _pace, ...window }) => {
    if (window.resetsAt !== undefined) return Date.parse(window.resetsAt) > now ? [window] : [];
    const length = (window.windowDurationMins ?? 0) * 60_000;
    return length > 0 && readAt + length <= now ? [] : [window];
  });
  if (windows.length === 0) return failed;
  return {
    ...failed,
    checkedAt: last.checkedAt,
    windows,
    ...(last.credentialFingerprint ? { credentialFingerprint: last.credentialFingerprint } : {}),
  };
}
