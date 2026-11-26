import type { ProviderDriverKind, ServerProviderUsageLimits } from "@t3tools/contracts";

// Two default health checks leave room for an in-flight probe.
export const USAGE_LIMIT_STALE_AFTER_MS = 10 * 60_000;

export function isUsageLimitReadingStale(
  driver: ProviderDriverKind,
  limits: ServerProviderUsageLimits,
  now: number,
): boolean {
  if (driver === "antigravity" && limits.unavailable?.reason === "unsupported") return false;
  const checkedAt = Date.parse(limits.checkedAt);
  return (
    !Number.isFinite(checkedAt) ||
    now - checkedAt > USAGE_LIMIT_STALE_AFTER_MS ||
    limits.windows.some(
      (window) => window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now,
    )
  );
}

function usableWindows(limits: ServerProviderUsageLimits, readAt: number, now: number) {
  return limits.windows.filter((window) => {
    if (window.resetsAt !== undefined) return Date.parse(window.resetsAt) > now;
    const length = (window.windowDurationMins ?? 0) * 60_000;
    return length === 0 || readAt + length > now;
  });
}

/** A saved reading can paint the rings during startup, using its original timestamps. */
export function usageReadingWhileRefreshing(
  last: ServerProviderUsageLimits | undefined,
  now: number,
): ServerProviderUsageLimits | undefined {
  if (!last || last.unavailable?.reason === "unsupported") return undefined;
  const readAt = Date.parse(last.checkedAt);
  if (!Number.isFinite(readAt) || readAt > now) return undefined;
  const windows = usableWindows(last, readAt, now).map(
    ({ recentPercentPerHour: _pace, ...window }) => window,
  );
  if (windows.length === 0) return undefined;
  const { unavailable: _unavailable, resetCredits: _resetCredits, ...reading } = last;
  return { ...reading, windows, refreshing: true };
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
 *
 * A live reading younger than the stale limit still stands as it was: the probe runs every few
 * minutes, and one slow answer is no reason to grey out numbers read moments ago.
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
  if (last.unavailable === undefined && now - readAt <= USAGE_LIMIT_STALE_AFTER_MS) {
    const current = last.windows.filter(
      (window) => window.resetsAt === undefined || Date.parse(window.resetsAt) > now,
    );
    if (current.length > 0)
      return current.length === last.windows.length ? last : { ...last, windows: current };
  }
  // The measured pace belonged to that moment; pace warnings must not fire from it.
  const windows = usableWindows(last, readAt, now).map(
    ({ recentPercentPerHour: _pace, ...window }) => window,
  );
  if (windows.length === 0) return failed;
  return {
    ...failed,
    checkedAt: last.checkedAt,
    windows,
    ...(last.credentialFingerprint ? { credentialFingerprint: last.credentialFingerprint } : {}),
  };
}
