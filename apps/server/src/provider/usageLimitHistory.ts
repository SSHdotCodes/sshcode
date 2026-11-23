import type {
  ProviderInstanceId,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

interface UsageSample {
  readonly checkedAt: number;
  readonly usedPercent: number;
}

type DailyRise = NonNullable<ServerProviderUsageWindow["dailyRise"]>;

interface WindowHistory {
  readonly resetsAt: string | undefined;
  readonly samples: readonly UsageSample[];
  /** Points the reading rose per day, across resets, and the reading that count stands at. */
  readonly rise: DailyRise;
  readonly counted: UsageSample;
}

/** What a saved snapshot knows about a window this process has not read yet. */
export interface WindowSeed {
  readonly resetsAt: string | undefined;
  readonly usedPercent: number;
  readonly checkedAt: number;
  readonly rise: DailyRise | undefined;
}

const DAY = 24 * HOUR;
/** Kept just inside the month of usage the picks set it against. */
const RISE_DAYS = 28;
/** A fall this large is the counter starting over, not a sliding window easing off. */
const RESTART_DROP = 5;
/** After a gap this long the rise happened unseen, perhaps on another machine: do not count it. */
const MAX_COUNTED_GAP = 36 * HOUR;

const LOCAL_DAY = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
/** The server's calendar day of an instant: the day usage is bucketed by on the same machine. */
export const localDay = (instant: number): string => LOCAL_DAY.format(instant);

/**
 * Providers work the reset out again on every reading, so it wobbles by
 * seconds (Claude: 6:59:58 then 7:00:00). A real reset moves it by the
 * window's length; treating the wobble as one would empty the history on
 * every reading and no pace would ever be measured.
 */
function sameReset(previous: string | undefined, next: string | undefined): boolean {
  if (previous === next) return true;
  if (previous === undefined || next === undefined) return false;
  const moved = Math.abs(Date.parse(previous) - Date.parse(next));
  return Number.isFinite(moved) && moved <= 10 * MINUTE;
}

/**
 * How far the counter moved between two readings. A fixed window that has passed its reset,
 * or a reading that fell a long way, started again from zero; a rolling window's reset moves
 * with every reading and means nothing by itself.
 */
function countRise(
  from: { readonly resetsAt: string | undefined; readonly counted: UsageSample },
  window: ServerProviderUsageWindow,
  checkedAt: number,
): { readonly rise: number; readonly counted: number } {
  const usedPercent = window.usedPercent;
  if (checkedAt - from.counted.checkedAt > MAX_COUNTED_GAP)
    return { rise: 0, counted: usedPercent };
  const end = from.resetsAt === undefined ? Number.NaN : Date.parse(from.resetsAt);
  const rolledOver = !sameReset(from.resetsAt, window.resetsAt) && end <= checkedAt + 10 * MINUTE;
  const before = from.counted.usedPercent;
  if (rolledOver || usedPercent < before - RESTART_DROP) {
    return { rise: usedPercent, counted: usedPercent };
  }
  if (usedPercent >= before) return { rise: usedPercent - before, counted: usedPercent };
  // One point down is rounding; more is a sliding window easing off. Neither is a rise.
  return { rise: 0, counted: before - usedPercent <= 1 ? before : usedPercent };
}

function addRise(
  rise: DailyRise,
  points: number,
  checkedAt: number,
  dayOf: (instant: number) => string,
): DailyRise {
  const oldest = dayOf(checkedAt - RISE_DAYS * DAY);
  const kept = rise.filter((entry) => entry.day >= oldest);
  if (points <= 0) return kept.length === rise.length ? rise : kept;
  const day = dayOf(checkedAt);
  const today = kept.find((entry) => entry.day === day);
  return today
    ? kept.map((entry) => (entry === today ? { day, percent: entry.percent + points } : entry))
    : [...kept, { day, percent: points }];
}

/**
 * Keep only this reset's last three hours, with a hard bound for busy runtime streams.
 * `seed` stands in for readings this process never saw (a restart): it carries the daily
 * rise across, but is never a sample, so no pace is measured from disk.
 */
export function recordUsageSample(
  previous: WindowHistory | undefined,
  window: ServerProviderUsageWindow,
  checkedAt: number,
  seed?: WindowSeed,
  dayOf: (instant: number) => string = localDay,
): WindowHistory {
  const last = previous?.samples[previous.samples.length - 1];
  if (previous && last && checkedAt < last.checkedAt) return previous;
  if (
    previous &&
    last &&
    checkedAt === last.checkedAt &&
    window.usedPercent === last.usedPercent &&
    window.resetsAt === previous.resetsAt
  )
    return previous;
  const reset =
    !sameReset(previous?.resetsAt, window.resetsAt) ||
    (last && window.usedPercent < last.usedPercent);
  let samples = reset ? [] : (previous?.samples ?? []);
  // Keep minute anchors plus the newest reading, so a burst of runtime events
  // cannot fill all 64 slots before a measurable span has passed.
  const beforeLast = samples[samples.length - 2];
  if (last && beforeLast && last.checkedAt - beforeLast.checkedAt < MINUTE) {
    samples = samples.slice(0, -1);
  }
  const from =
    previous ??
    (seed && seed.checkedAt < checkedAt
      ? {
          resetsAt: seed.resetsAt,
          rise: seed.rise ?? [],
          counted: { checkedAt: seed.checkedAt, usedPercent: seed.usedPercent },
        }
      : undefined);
  // The first reading ever seen is only a starting point: when it accrued is unknown.
  const moved = from
    ? countRise(from, window, checkedAt)
    : { rise: 0, counted: window.usedPercent };
  return {
    resetsAt: window.resetsAt,
    samples: [
      ...samples.filter(
        (sample) => sample.checkedAt >= checkedAt - 3 * HOUR && sample.checkedAt < checkedAt,
      ),
      { checkedAt, usedPercent: window.usedPercent },
    ].slice(-64),
    rise: addRise(from?.rise ?? [], moved.rise, checkedAt, dayOf),
    counted: { checkedAt, usedPercent: moved.counted },
  };
}

/** Prefer a span near one hour, bounded to 30–90 minutes so old bursts do not set the pace. */
function recentPace(history: WindowHistory): number | undefined {
  const newest = history.samples[history.samples.length - 1];
  if (!newest) return undefined;
  let baseline: UsageSample | undefined;
  for (const sample of history.samples) {
    const age = newest.checkedAt - sample.checkedAt;
    if (age < 30 * MINUTE || age > 90 * MINUTE) continue;
    if (
      !baseline ||
      Math.abs(age - HOUR) < Math.abs(newest.checkedAt - baseline.checkedAt - HOUR)
    ) {
      baseline = sample;
    }
  }
  if (!baseline) return undefined;
  const elapsed = newest.checkedAt - baseline.checkedAt;
  const rise = newest.usedPercent - baseline.usedPercent;
  return elapsed >= 15 * MINUTE && rise >= 1 ? (rise * HOUR) / elapsed : undefined;
}

/**
 * Process-local quota history. Only live readings become samples; a saved snapshot only
 * carries the daily rise across a restart.
 */
export function makeUsageLimitHistory(dayOf: (instant: number) => string = localDay) {
  const instances = new Map<
    ProviderInstanceId,
    {
      fingerprint: string | undefined;
      windows: Map<string, WindowHistory>;
    }
  >();
  return {
    clear(instanceId: ProviderInstanceId) {
      instances.delete(instanceId);
    },
    record(
      instanceId: ProviderInstanceId,
      limits: ServerProviderUsageLimits,
      /** This instance's snapshot from before the reading, saved ones included. */
      carried?: ServerProviderUsageLimits,
    ): ServerProviderUsageLimits {
      const checkedAt = Date.parse(limits.checkedAt);
      if (!Number.isFinite(checkedAt) || limits.unavailable) return limits;
      let instance = instances.get(instanceId);
      if (!instance || instance.fingerprint !== limits.credentialFingerprint) {
        instance = { fingerprint: limits.credentialFingerprint, windows: new Map() };
        instances.set(instanceId, instance);
      }
      const activeIds = new Set(limits.windows.map((window) => window.id));
      for (const id of instance.windows.keys()) {
        if (!activeIds.has(id)) instance.windows.delete(id);
      }
      const carriedAt = carried?.unavailable ? Number.NaN : Date.parse(carried?.checkedAt ?? "");
      const seedFor = (id: string): WindowSeed | undefined => {
        // Another account's counter says nothing about this one.
        if (carried?.credentialFingerprint !== limits.credentialFingerprint) return undefined;
        const saved = carried?.windows.find((window) => window.id === id);
        return saved === undefined || !Number.isFinite(carriedAt)
          ? undefined
          : {
              resetsAt: saved.resetsAt,
              usedPercent: saved.usedPercent,
              checkedAt: carriedAt,
              rise: saved.dailyRise,
            };
      };
      const windows = limits.windows.map((window) => {
        const known = instance.windows.get(window.id);
        const history = recordUsageSample(
          known,
          window,
          checkedAt,
          known ? undefined : seedFor(window.id),
          dayOf,
        );
        instance.windows.set(window.id, history);
        const recentPercentPerHour = recentPace(history);
        const { recentPercentPerHour: _previousPace, dailyRise: _savedRise, ...reading } = window;
        return {
          ...reading,
          ...(recentPercentPerHour === undefined ? {} : { recentPercentPerHour }),
          // Always present, so a client can tell this server counts.
          dailyRise: history.rise,
        };
      });
      return { ...limits, windows };
    },
  };
}
