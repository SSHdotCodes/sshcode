/**
 * How much each provider instance ran lately (`ServerProvider.recentUse`), so
 * clients can order plans by use: hours its chats and subagents spent running
 * over the past week, each run counting half as much a day after it ended.
 */
import type { ProviderInstanceId } from "@t3tools/contracts";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** Runs requested before this are left out. */
export const RECENT_USE_HORIZON_MS = 7 * DAY;
/** A run counts at most this long, so one left open by a crash cannot outweigh a week. */
const RUN_CAP_MS = 6 * HOUR;
/** Below this an instance has no figure at all. */
const MIN_HOURS = 0.01;

export interface RecentUseRun {
  readonly instanceId: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
}

/** Decayed hours per instance; a run still going counts up to `now`. */
export function recentUseByInstance(
  runs: ReadonlyArray<RecentUseRun>,
  now: number,
): Map<ProviderInstanceId, number> {
  const hours = new Map<ProviderInstanceId, number>();
  for (const run of runs) {
    const start = Date.parse(run.requestedAt);
    const end = run.completedAt === null ? now : Date.parse(run.completedAt);
    if (!Number.isFinite(start) || !Number.isFinite(end) || now - start > RECENT_USE_HORIZON_MS) {
      continue;
    }
    const ran = Math.min(Math.max(0, end - start), RUN_CAP_MS);
    const weight = 0.5 ** (Math.max(0, now - end) / DAY);
    const id = run.instanceId as ProviderInstanceId;
    hours.set(id, (hours.get(id) ?? 0) + (ran / HOUR) * weight);
  }
  for (const [id, value] of hours) {
    if (value < MIN_HOURS) hours.delete(id);
    else hours.set(id, Math.round(value * 100) / 100);
  }
  return hours;
}

/**
 * Whether a new figure is worth republishing the instance for. Decay moves
 * every figure a little all the time; ordering only needs the bigger moves.
 */
export function recentUseMoved(published: number, measured: number): boolean {
  return Math.abs(measured - published) >= Math.max(0.25, published * 0.1);
}
