const settingsTimeFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

/** Absolute status dates in settings use US Eastern time on a 12-hour clock. */
export function formatSettingsTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : settingsTimeFormatter.format(date);
}
