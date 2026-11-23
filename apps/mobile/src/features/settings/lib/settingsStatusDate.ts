const statusDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  dateStyle: "medium",
  timeStyle: "short",
  hour12: true,
});

/** Absolute settings status dates use Eastern time across devices. */
export function formatSettingsStatusDate(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Date unavailable"
    : `${statusDateFormatter.format(date)} ET`;
}
