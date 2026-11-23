export function relativeTime(input: string): string {
  const timestamp = Date.parse(input);
  if (Number.isNaN(timestamp)) {
    return "<1m";
  }

  // Anything under a minute renders as "<1m" rather than a live seconds count.
  // The seconds ticker changed width every second and reflowed the surrounding row.
  const deltaSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSeconds < 60) return "<1m";

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) return `${deltaMinutes}m`;

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) return `${deltaHours}h`;

  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d`;
}

const TRANSCRIPT_TIME = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});
const TRANSCRIPT_DAY = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const TRANSCRIPT_YEAR = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

/** All transcript rows use local calendar days, including errors and messages. */
export function formatTranscriptTimestamp(input: string, now = new Date()): string {
  const date = new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  const time = TRANSCRIPT_TIME.format(date);
  const sameYear = date.getFullYear() === now.getFullYear();
  if (sameYear && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()) {
    return time;
  }
  return `${(sameYear ? TRANSCRIPT_DAY : TRANSCRIPT_YEAR).format(date)}, ${time}`;
}
