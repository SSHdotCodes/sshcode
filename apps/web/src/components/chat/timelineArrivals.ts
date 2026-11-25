import { useEffect, useLayoutEffect, useState } from "react";

/**
 * Which timeline rows just arrived in an open chat, so only those animate in. Rows also
 * appear when a chat opens, when older history is paged in and when the reader switches
 * chats; none of those are arrivals.
 */
export const TIMELINE_ARRIVAL_MS = 300;
// More than this many new rows at once is a load, not something that just happened.
const MAX_ARRIVALS_AT_ONCE = 3;

const ARRIVAL_ROW_KINDS = new Set([
  "message",
  "work",
  "work-live",
  "work-toggle",
  "event",
  "proposed-plan",
  "html-render",
  "mcp-app",
  "context-compaction",
  "worktree-setup",
]);

interface TimelineArrivalRow {
  readonly id: string;
  readonly kind: string;
}

interface TimelineArrivalSnapshot {
  readonly scopeKey: string;
  readonly expiresAtById: ReadonlyMap<string, number>;
}

const NO_ARRIVALS: ReadonlyMap<string, number> = new Map();

/** True for content rows that should fade up on live arrival (never chrome or expanded folds). */
export function shouldAnimateTimelineRowArrival(
  kind: string,
  options?: { readonly isExpandedToolGroup?: boolean },
): boolean {
  if (kind === "work" && options?.isExpandedToolGroup) return false;
  return ARRIVAL_ROW_KINDS.has(kind);
}

// Activity indicators can stay below newly appended content.
function isTimelineContentAnchor(row: TimelineArrivalRow): boolean {
  return row.kind !== "working" && row.kind !== "thinking";
}

function appendTimelineRows(
  known: Set<string>,
  rows: ReadonlyArray<TimelineArrivalRow>,
): ReadonlyArray<string> {
  const hasBaseline = known.size > 0;
  const appended: string[] = [];
  let foundAnchor = false;
  let added = 0;
  for (const row of rows) {
    if (!isTimelineContentAnchor(row)) continue;
    if (known.has(row.id)) {
      foundAnchor = true;
      appended.length = 0;
      continue;
    }
    known.add(row.id);
    added++;
    if (added <= MAX_ARRIVALS_AT_ONCE) appended.push(row.id);
  }
  return added > MAX_ARRIVALS_AT_ONCE || (hasBaseline && !foundAnchor) ? [] : appended;
}

/** Observes committed rows. A null scope means the timeline is still loading. */
export function createTimelineArrivalTracker() {
  let scopeKey: string | null = null;
  const known = new Set<string>();

  return (nextScopeKey: string | null, rows: ReadonlyArray<TimelineArrivalRow>) => {
    if (nextScopeKey === null || nextScopeKey !== scopeKey) {
      scopeKey = nextScopeKey;
      known.clear();
      if (scopeKey !== null) {
        for (const row of rows) {
          if (isTimelineContentAnchor(row)) known.add(row.id);
        }
      }
      return null;
    }
    return appendTimelineRows(known, rows);
  };
}

export function useTimelineArrivalIds(
  scopeKey: string | null,
  rows: ReadonlyArray<TimelineArrivalRow>,
) {
  const [observe] = useState(createTimelineArrivalTracker);
  const [arrivals, setArrivals] = useState<TimelineArrivalSnapshot | null>(null);

  // Activity disconnects layout effects when a kept chat leaves the screen.
  useLayoutEffect(
    () => () => {
      observe(null, []);
      setArrivals(null);
    },
    [observe],
  );

  // Observe only committed rows, then flush the markers before the browser paints them.
  useLayoutEffect(() => {
    const appended = observe(scopeKey, rows);
    if (scopeKey === null || appended === null) {
      // oxlint-disable-next-line react/set-state-in-effect -- Clear the previous visit's markers before paint.
      setArrivals(null);
      return;
    }
    if (appended.length === 0) return;

    const expiresAt = performance.now() + TIMELINE_ARRIVAL_MS;
    setArrivals((current) => {
      const expiresAtById = new Map(current?.scopeKey === scopeKey ? current.expiresAtById : []);
      for (const id of appended) expiresAtById.set(id, expiresAt);
      return { scopeKey, expiresAtById };
    });
  }, [observe, rows, scopeKey]);

  useEffect(() => {
    if (arrivals === null) return;
    const nextExpiry = Math.min(...arrivals.expiresAtById.values());
    const timer = window.setTimeout(
      () => {
        const now = Math.max(nextExpiry, performance.now());
        const remaining = new Map(
          [...arrivals.expiresAtById].filter(([, expiresAt]) => expiresAt > now),
        );
        setArrivals((current) =>
          current !== arrivals
            ? current
            : remaining.size > 0
              ? { scopeKey: arrivals.scopeKey, expiresAtById: remaining }
              : null,
        );
      },
      Math.max(0, nextExpiry - performance.now()),
    );
    return () => window.clearTimeout(timer);
  }, [arrivals]);

  return arrivals?.scopeKey === scopeKey ? arrivals.expiresAtById : NO_ARRIVALS;
}
