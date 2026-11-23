/**
 * The app's error screen retries on its own when the error only means the
 * server didn't answer, as while it restarts or updates: quickly at first,
 * then every 15 seconds for as long as it stays away.
 */

let unreachableSince: number | null = null;

/** Errors a later try can fix: the request reached no server, or not one that answered. */
export function isServerUnreachableError(error: unknown): boolean {
  if (error instanceof TypeError) return true;
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "PrimaryEnvironmentRequestError"
  );
}

export function serverRetryDelayMs(unreachableForMs: number): number {
  if (unreachableForMs < 10_000) return 1_000;
  if (unreachableForMs < 60_000) return 3_000;
  return 15_000;
}

/** The wait before the next try, counted from the first failure since the server last answered. */
export function nextServerRetryDelayMs(now: number): number {
  unreachableSince ??= now;
  return serverRetryDelayMs(now - unreachableSince);
}

export function markServerReached(): void {
  unreachableSince = null;
}
