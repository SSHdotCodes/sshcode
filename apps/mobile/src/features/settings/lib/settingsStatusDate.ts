// Made on first use, so status dates follow the phone's time zone at that moment.
let statusDateFormat: Intl.DateTimeFormat | undefined;
const statusDateFormatter = () =>
  (statusDateFormat ??= new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    hour12: true,
  }));

/** Absolute settings status dates on the phone's own 12-hour clock. */
export function formatSettingsStatusDate(value: string | number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Date unavailable" : statusDateFormatter().format(date);
}
