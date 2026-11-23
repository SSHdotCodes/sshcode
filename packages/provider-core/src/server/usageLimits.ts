import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  return { checkedAt: input.checkedAt, windows: sortWindows(input.windows) };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

const USAGE_CHECKED_AT_REFRESH_MS = 60_000;

/**
 * Fold a sparse runtime update into the limits a provider currently
 * publishes. Windows upsert by `id`; a window the update omits keeps its
 * previous values, and a window that arrives without `resetsAt` or
 * `windowDurationMins` keeps whatever the last probe resolved for it. An
 * update with no windows leaves `previous` untouched.
 *
 * An `unsupported` snapshot stays unsupported: an account that cannot have
 * subscription windows will not start reporting them mid-turn.
 */
export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (update.windows.length === 0 || previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const merged = new Map(previous?.windows.map((window) => [window.id, window] as const));
  // Codex sends this notification beside every token-usage tick, almost
  // always with unchanged numbers. Decide "nothing changed" per window on
  // the way through so the no-op case never allocates a new snapshot.
  let changed = false;
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const next: ServerProviderUsageWindow = {
      ...window,
      usedPercent: clampPercent(window.usedPercent),
      ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
        ? { resetsAt: existing.resetsAt }
        : {}),
      ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
        ? { windowDurationMins: existing.windowDurationMins }
        : {}),
      ...(window.limited === undefined &&
      existing?.limited !== undefined &&
      (window.resetsAt === undefined || window.resetsAt === existing.resetsAt)
        ? { limited: existing.limited }
        : {}),
    };
    if (existing === undefined || !usageWindowEquals(existing, next)) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed && previous !== undefined && previous.unavailable === undefined) {
    // Unchanged numbers still prove the reading is current. Move its time on
    // at most once a minute, so per-tick updates stay a no-op while readers
    // that judge freshness by `checkedAt` never see a live reading go stale.
    return Date.parse(input.checkedAt) - Date.parse(previous.checkedAt) <
      USAGE_CHECKED_AT_REFRESH_MS
      ? previous
      : { ...previous, checkedAt: input.checkedAt };
  }
  return {
    ...makeUsageLimits({ checkedAt: input.checkedAt, windows: merged.values() }),
    ...(previous?.resetCredits !== undefined ? { resetCredits: previous.resetCredits } : {}),
  };
}

function usageWindowEquals(a: ServerProviderUsageWindow, b: ServerProviderUsageWindow): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.usedPercent === b.usedPercent &&
    sameIds(a.modelIds, b.modelIds) &&
    sameIds(a.providerIds, b.providerIds) &&
    a.limited === b.limited &&
    a.resetsAt === b.resetsAt &&
    a.windowDurationMins === b.windowDurationMins
  );
}

function sameIds(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.length === b.length &&
      a.every((id, index) => id === b[index]))
  );
}

/**
 * Choose what to publish after a status probe finishes. A probe that failed
 * this time must not wipe bars a previous probe or a turn already
 * established, so the last good snapshot stays; `unsupported` is
 * authoritative and replaces them.
 *
 * A newer runtime update keeps its windows while the probe contributes its
 * other metadata.
 */
export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (probed?.unavailable?.reason === "probeFailed" && published && !published.unavailable) {
    return published;
  }
  if (
    published &&
    probed &&
    !published.unavailable &&
    !probed.unavailable &&
    Date.parse(published.checkedAt) > Date.parse(probed.checkedAt)
  ) {
    // A sparse runtime reading owns utilization; a full probe can fill its missing metadata.
    const windows = published.windows.map((window) => {
      const metadata = probed.windows.find((candidate) => candidate.id === window.id);
      return metadata === undefined || window.windowDurationMins !== undefined
        ? window
        : {
            ...metadata,
            ...window,
            kind: metadata.kind,
            label: metadata.label,
            ...(metadata.windowDurationMins === undefined
              ? {}
              : { windowDurationMins: metadata.windowDurationMins }),
          };
    });
    return { ...probed, checkedAt: published.checkedAt, windows };
  }
  if (!published || !probed || published.unavailable || probed.unavailable) return probed;
  const windows = probed.windows.map((window) => {
    const existing = published.windows.find((candidate) => candidate.id === window.id);
    if (
      existing?.limited === undefined ||
      existing.resetsAt === undefined ||
      existing.resetsAt !== window.resetsAt
    ) {
      return window;
    }
    // A rounded probe cannot retract the last provider verdict or improve a
    // fractional reading in the same rounding bucket. A new reset starts fresh.
    return {
      ...window,
      limited: window.limited ?? existing.limited,
      usedPercent:
        !Number.isInteger(existing.usedPercent) &&
        Math.round(existing.usedPercent) === window.usedPercent
          ? existing.usedPercent
          : window.usedPercent,
    };
  });
  return windows.every((window, index) => window === probed.windows[index])
    ? probed
    : { ...probed, windows };
}
