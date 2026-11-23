// @effect-diagnostics globalDate:off -- Usage windows are calendar days in the viewer's zone, derived from wall-clock "now" via Intl.
/**
 * Display formatting for the usage page.
 *
 * @module usageFormat
 */
import {
  UsageDay,
  type UsageResolution,
  type UsageSummaryInput,
  type ThreadUsage,
  type ThreadId,
  type UsageTokenTotals,
} from "@t3tools/contracts";

import type { UsageContractMismatch } from "./usageMerge.ts";

const CURRENCY = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const INTEGER = new Intl.NumberFormat("en-US");

export function formatUsd(value: number): string {
  return CURRENCY.format(value);
}

export function formatCount(value: number): string {
  return INTEGER.format(Math.round(value));
}

/**
 * Compacts a token count to three significant figures with a unit suffix, so
 * columns of numbers line up at a glance (`19.9B`, `76.7M`, `804K`).
 */
export function formatTokens(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e12) return `${trim(value / 1e12)}T`;
  if (abs >= 1e9) return `${trim(value / 1e9)}B`;
  if (abs >= 1e6) return `${trim(value / 1e6)}M`;
  if (abs >= 1e3) return `${trim(value / 1e3)}K`;
  return INTEGER.format(Math.round(value));
}

function trim(value: number): string {
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return value.toFixed(digits).replace(/\.0+$/, "");
}

export function formatPercent(share: number, digits = 1): string {
  const percent = share * 100;
  const smallest = 10 ** -digits;
  if (percent > 0 && percent < smallest) return `<${smallest.toFixed(digits)}%`;
  return `${percent.toFixed(digits)}%`;
}

export function formatUsageContractMismatch(
  environmentLabel: string,
  mismatch: Pick<UsageContractMismatch, "direction">,
): string {
  return mismatch.direction === "serverBehind"
    ? `${environmentLabel} runs an older server version and is excluded from totals.`
    : `This client is older than the server on ${environmentLabel}; its usage is excluded from totals.`;
}

/** `2026-08-07` to `Aug 7`. */
export function formatDayShort(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map((part) => Number(part));
  if (year === undefined || month === undefined || dayOfMonth === undefined) return day;
  const MONTHS = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ];
  return `${MONTHS[month - 1] ?? ""} ${dayOfMonth}`;
}

/** Inclusive day list between two `YYYY-MM-DD` bounds. */
export function enumerateDays(sinceDay: string, untilDay: string): readonly string[] {
  const days: string[] = [];
  const start = Date.parse(`${sinceDay}T00:00:00Z`);
  const end = Date.parse(`${untilDay}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return days;

  for (let cursor = start; cursor <= end; cursor += 86_400_000) {
    days.push(new Date(cursor).toISOString().slice(0, 10));
  }
  return days;
}

const HOUR_MS = 60 * 60 * 1000;

const dateTimeFormatters = new Map<string, Intl.DateTimeFormat>();

function dateTimeFormatter(
  locale: string,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat {
  if (options.timeZone === undefined) return new Intl.DateTimeFormat(locale, options);
  const key = JSON.stringify([locale, options]);
  let formatter = dateTimeFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, options);
    if (dateTimeFormatters.size >= 16) dateTimeFormatters.clear();
    dateTimeFormatters.set(key, formatter);
  }
  return formatter;
}

/** Every fixed-duration bucket start in an hourly rolling window. */
export function enumerateHourStarts(sinceTime: string, untilTime: string): readonly string[] {
  const starts: string[] = [];
  const start = Date.parse(sinceTime);
  const end = Date.parse(untilTime);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return starts;

  for (let cursor = start; cursor < end; cursor += HOUR_MS) {
    starts.push(new Date(cursor).toISOString());
  }
  return starts;
}

/**
 * A rolling bucket start rendered in the viewer's requested time zone.
 *
 * Repeated wall-clock hours during a fall-back transition include their short
 * zone name so the two distinct buckets remain distinguishable.
 */
export function formatHourShort(hourStart: string, timeZone?: string): string {
  const instant = new Date(hourStart);
  if (Number.isNaN(instant.getTime())) return hourStart;
  const options = timeZone === undefined ? {} : { timeZone };
  const hourFormat = dateTimeFormatter("en-US", {
    ...options,
    hour: "numeric",
  });
  const wallHourFormat = dateTimeFormatter("en-CA", {
    ...options,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  });
  const wallHour = wallHourFormat.format(instant);
  const isRepeatedHour = [-HOUR_MS, HOUR_MS].some(
    (offset) => wallHourFormat.format(new Date(instant.getTime() + offset)) === wallHour,
  );

  if (!isRepeatedHour) return hourFormat.format(instant);
  return dateTimeFormatter("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    hour: "numeric",
    timeZoneName: "short",
  }).format(instant);
}

/** `2026-08-11T14:37:00Z` to `Aug 11, 2 PM` in the requested zone. */
export function formatDateTimeShort(instant: string, timeZone?: string): string {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return instant;
  return dateTimeFormatter("en-US", {
    ...(timeZone === undefined ? {} : { timeZone }),
    month: "short",
    day: "numeric",
    hour: "numeric",
  }).format(date);
}

/** An hourly tooltip label relative to the rolling window's end date. */
export function formatRelativeHourShort(
  hourStart: string,
  relativeTo: string,
  timeZone?: string,
): string {
  const instant = new Date(hourStart);
  const reference = new Date(relativeTo);
  if (Number.isNaN(instant.getTime()) || Number.isNaN(reference.getTime())) {
    return formatDateTimeShort(hourStart, timeZone);
  }

  const dayFormat = dateTimeFormatter("en-CA", {
    ...(timeZone === undefined ? {} : { timeZone }),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const instantDay = Date.parse(`${dayFormat.format(instant)}T00:00:00Z`);
  const referenceDay = Date.parse(`${dayFormat.format(reference)}T00:00:00Z`);
  const calendarDaysAgo = Math.round((referenceDay - instantDay) / (24 * HOUR_MS));
  const hour = formatHourShort(hourStart, timeZone);

  if (calendarDaysAgo === 0) return `${hour} today`;
  if (calendarDaysAgo === 1) return `${hour} yesterday`;
  return formatDateTimeShort(hourStart, timeZone);
}

/**
 * The window the page requests, expressed in the viewer's own time zone so days
 * line up with what they actually experienced.
 */
export function makeWindow(
  days: number,
  now = new Date(),
  resolution: UsageResolution = "day",
): UsageSummaryInput {
  let timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  } catch {
    // An unknown zone should degrade to UTC rather than crash the page.
    timeZone = "UTC";
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
  }
  const untilDay = format.format(now);
  if (resolution === "hour") {
    // Buckets start on the viewer's clock hours, so the bar labelled "2 PM"
    // holds 2:00 to 3:00. The window opens at the first hour boundary within
    // the last 24 hours (the server caps hourly windows at 24 hours) and ends
    // at the current minute. Reading the local minute handles zones offset by
    // 30 or 45 minutes; fixed-duration buckets stay correct across
    // daylight-saving transitions.
    const untilTimeMs = Math.floor(now.getTime() / 60_000) * 60_000;
    const earliestTimeMs = untilTimeMs - 24 * HOUR_MS;
    const localMinute = Number.parseInt(
      dateTimeFormatter("en-US", { timeZone, minute: "numeric" }).format(earliestTimeMs),
      10,
    );
    const sinceTimeMs = earliestTimeMs + ((60 - localMinute) % 60) * 60_000;
    const sinceTime = new Date(sinceTimeMs);
    const untilTime = new Date(untilTimeMs);
    return {
      sinceDay: UsageDay.make(format.format(sinceTime)),
      untilDay: UsageDay.make(format.format(untilTime)),
      timeZone,
      resolution,
      sinceTime: sinceTime.toISOString(),
      untilTime: untilTime.toISOString(),
    };
  }
  // Subtracting fixed milliseconds from `now` lands on the wrong calendar day
  // around a DST transition. The window start is pure calendar arithmetic on
  // the local end day, done in UTC where days are uniform.
  const [year = 0, month = 1, dayOfMonth = 1] = untilDay
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  const start = new Date(Date.UTC(year, month - 1, dayOfMonth - (days - 1)));
  return {
    sinceDay: UsageDay.make(start.toISOString().slice(0, 10)),
    untilDay: UsageDay.make(untilDay),
    timeZone,
    resolution,
  };
}

/** Quiet row content shared by the chat panel and the phone's tappable rows. */
export function threadUsageRows(
  usage: ThreadUsage,
  threadId: ThreadId,
  clock: (ms: number) => string,
): readonly {
  readonly label: string;
  readonly value: string;
  readonly fill: number | null;
  readonly details: readonly string[];
}[] {
  const sum = (tokens: UsageTokenTotals) =>
    tokens.uncachedInputTokens +
    tokens.cachedInputTokens +
    tokens.cacheCreationTokens +
    tokens.outputTokens;
  const rows: { label: string; value: string; fill: number | null; details: readonly string[] }[] =
    [];
  const total = sum(usage.allTime.tokens);
  if (total > 0) {
    const tokens = usage.allTime.tokens;
    rows.push({
      label: "Tokens",
      value: formatTokens(total),
      fill: null,
      details: [
        `${formatCount(total)} tokens`,
        `Uncached input ${formatTokens(tokens.uncachedInputTokens + tokens.cacheCreationTokens)} · cached input ${formatTokens(tokens.cachedInputTokens)} · output ${formatTokens(tokens.outputTokens)}`,
        `Today ${formatTokens(sum(usage.today.tokens))}`,
        ...usage.notes,
      ],
    });
    rows.push({
      label: "Cost",
      value:
        usage.allTime.unpricedTokens === total
          ? "Unpriced"
          : `${formatUsd(usage.allTime.costUsd)}${usage.allTime.unpricedTokens > 0 ? " +" : ""}`,
      fill: null,
      details: [
        "At API prices; a subscription covers this",
        `Today ${formatUsd(usage.today.costUsd)}${usage.today.unpricedTokens > 0 ? " + unpriced usage" : ""}`,
        ...(usage.allTime.unpricedTokens > 0
          ? [
              `${formatTokens(usage.allTime.unpricedTokens)} tokens have no known price and are excluded from cost.`,
            ]
          : []),
      ],
    });
  }
  const share = usage.weeklyShare;
  if (share)
    rows.push({
      label: "Share",
      value: formatPercent(share.percent / 100, 0),
      fill: share.percent,
      details: [
        "Share of observed cost in this account’s weekly window, not the provider’s quota percentage.",
        "Unpriced usage is excluded from shares.",
        ...share.chats.map(
          (chat) =>
            `${chat.title}${chat.threadId === threadId ? " (this chat)" : ""} · ${formatPercent(chat.percent / 100, 0)}`,
        ),
        `Others · ${formatPercent(share.othersPercent / 100, 0)}`,
        ...usage.notes,
      ],
    });
  const compact = usage.compactions;
  if (compact.count > 0)
    rows.push({
      label: "Compactions",
      value: formatCount(compact.count),
      fill: null,
      details: [
        `${formatCount(compact.count)} compactions · ${compact.unknownSizes === compact.count ? "input sizes unavailable" : `${compact.unknownSizes > 0 ? "at least " : ""}${formatTokens(compact.summarizedTokens)} tokens summarized`}`,
        ...(compact.last
          ? [
              `Last: ${compact.last.beforeTokens === null ? "unknown" : formatTokens(compact.last.beforeTokens)} → ${compact.last.afterTokens === null ? "unknown" : formatTokens(compact.last.afterTokens)}, ${clock(Date.parse(compact.last.at))}`,
            ]
          : []),
        ...(compact.unknownSizes > 0
          ? [`${formatCount(compact.unknownSizes)} compactions have no reported input size.`]
          : []),
        ...usage.notes,
      ],
    });
  if (usage.subagents.length > 0)
    rows.push({
      label: "Subagents",
      value: `${formatCount(usage.subagentRuns)} · ${formatTokens(usage.subagents.reduce((sum, model) => sum + model.tokens, 0))}`,
      fill: null,
      details: [
        ...usage.subagents.map(
          (model) =>
            `${model.model} ${formatCount(model.runs)} runs · ${formatTokens(model.tokens)}`,
        ),
        ...usage.notes,
      ],
    });
  return rows;
}

/** Day plus clock, with the surface supplying its existing timestamp formatter. */
export function formatUsageRunOut(at: number, clock: (ms: number) => string): string {
  return `${new Date(at).toLocaleDateString(undefined, { weekday: "short" })} ${clock(at)}`;
}
