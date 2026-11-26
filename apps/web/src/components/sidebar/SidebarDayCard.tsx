import { useAtomValue } from "@effect/atom-react";
import { buildDayActivity, dayActivitySummary } from "@t3tools/client-runtime/day-activity";
import { harnessIdentityTint } from "@t3tools/shared/harnessMascots";
import { memo, useCallback, useMemo, useState } from "react";

import { useNowMinuteMs } from "../../hooks/useNowMinute";
import { observeResize } from "../../lib/observeResize";
import { useThreadShells } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";

/** The sidebar's free height, below its last chat, that the card needs before it shows. */
export const DAY_CARD_MIN_ROOM = 180;
/** Narrower than this, an hour's bar is too thin to read. */
export const DAY_CARD_MIN_WIDTH = 220;

const HOURS = 24;
/** Mosaic tiles per hour: two lit, one dark between hours. */
const HOUR_TILES = 3;
/** The dark tile after the last hour is left off, so the bars end on the chart's edge. */
const CHART_COLUMNS = HOURS * HOUR_TILES - 1;
const CHART_ROWS = 8;
/** A tile's height with the hairline under it, in CSS pixels. */
const ROW_PITCH = 4;
const TILE_GAP = 1;
const HOUR = 3_600_000;
const CLOCK_MARKS = new Map([
  [0, "12a"],
  [6, "6a"],
  [12, "12p"],
  [18, "6p"],
]);

/** The identity colour of the provider behind an `environment:instance`. */
function leadTint(
  presentations: ReadonlyMap<
    string,
    {
      readonly serverConfig: {
        readonly providers: ReadonlyArray<{ readonly instanceId: string; readonly driver: string }>;
      } | null;
    }
  >,
  source: string | null,
): string | null {
  for (const [environmentId, presentation] of presentations) {
    for (const provider of presentation.serverConfig?.providers ?? []) {
      if (`${environmentId}:${provider.instanceId}` === source) {
        return harnessIdentityTint(provider.driver);
      }
    }
  }
  return null;
}

/**
 * The day up to now at a glance, drawn in the free space under a short chat list: a
 * dithered bar per hour, as tall as the hour was busy, and a line saying how much ran.
 * The 24 hours end on the current one, so the card is never empty just after midnight.
 */
export const SidebarDayCard = memo(function SidebarDayCard() {
  // Subagents count too, though the list above hides them.
  const threads = useThreadShells(true, true);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const now = useNowMinuteMs();
  // The current hour is the last of the 24.
  const start = new Date(now).setMinutes(0, 0, 0) - (HOURS - 1) * HOUR;
  const activity = useMemo(() => buildDayActivity(threads, now, start), [now, start, threads]);
  const startClockHour = new Date(start).getHours();
  // The colour of whichever provider did the most of the day's work.
  const tint = leadTint(presentations, activity.leadSource);
  // Tile edges land on device pixels, so every hairline between tiles is the same width.
  const [box, setBox] = useState({ width: 0, ratio: 1 });
  const observeWidth = useCallback(
    (chart: HTMLDivElement) =>
      observeResize(chart, ([entry]) => {
        if (!entry) return;
        const next = { width: entry.contentRect.width, ratio: window.devicePixelRatio || 1 };
        setBox((current) =>
          current.width === next.width && current.ratio === next.ratio ? current : next,
        );
      }),
    [],
  );
  const { levels, currentHour } = activity;
  const tiles = useMemo(() => {
    if (box.width === 0) return [];
    const edge = (column: number) =>
      Math.round(((column * (box.width + TILE_GAP)) / CHART_COLUMNS) * box.ratio) / box.ratio;
    const drawn: Array<{ x: number; y: number; width: number; opacity: number }> = [];
    for (let hour = 0; hour <= currentHour; hour++) {
      const height = (levels[hour] ?? 0) * (CHART_ROWS / 4);
      for (let tile = 0; tile < HOUR_TILES - 1; tile++) {
        const column = hour * HOUR_TILES + tile;
        const x = edge(column);
        const width = edge(column + 1) - x - TILE_GAP;
        // A quiet hour keeps a faint tile on the floor, so the day reads as a whole row.
        for (let row = 0; row < Math.max(1, height); row++) {
          drawn.push({
            x,
            y: (CHART_ROWS - 1 - row) * ROW_PITCH,
            width,
            // Brightest at the top of a bar, like light falling on it.
            opacity: height === 0 ? 0.18 : 0.4 + 0.6 * ((row + 1) / height),
          });
        }
      }
    }
    return drawn;
  }, [box, currentHour, levels]);
  const summary = dayActivitySummary(activity);
  const hourWidth = (box.width + TILE_GAP) / HOURS;

  return (
    <section
      aria-label={`Last 24 hours: ${summary}`}
      className="rounded-lg border border-sidebar-border/60 bg-sidebar-foreground/[0.025] px-2.5 pt-2 pb-1.5"
    >
      <div className="flex h-4 items-center justify-between gap-2 text-xs">
        <h3 className="shrink-0 font-medium text-sidebar-muted-foreground">Last 24h</h3>
        <span className="truncate text-sidebar-muted-foreground/80 tabular-nums">{summary}</span>
      </div>
      <div
        ref={observeWidth}
        className="mt-2.5 text-sidebar-foreground"
        style={{ height: CHART_ROWS * ROW_PITCH - TILE_GAP, color: tint ?? undefined }}
      >
        <svg aria-hidden width={box.width} height={CHART_ROWS * ROW_PITCH - TILE_GAP}>
          {tiles.map((tile) => (
            <rect
              key={`${tile.x}:${tile.y}`}
              x={tile.x}
              y={tile.y}
              width={tile.width}
              height={ROW_PITCH - TILE_GAP}
              fill="currentColor"
              fillOpacity={tile.opacity}
            />
          ))}
        </svg>
      </div>
      <div
        aria-hidden
        className="relative mt-1 h-3 text-3xs leading-3 text-sidebar-muted-foreground/60 tabular-nums"
      >
        {levels.map((_, hour) => {
          const label = CLOCK_MARKS.get((startClockHour + hour) % HOURS);
          // The last hours are "now"'s; a mark there would run into it.
          return label === undefined || hour > HOURS - 5 ? null : (
            <span key={label} className="absolute top-0" style={{ left: hour * hourWidth }}>
              {label}
            </span>
          );
        })}
        <span className="absolute top-0 right-0">now</span>
      </div>
    </section>
  );
});
