// Made on first use, so settings times follow the viewer's time zone at that moment.
let settingsTimeFormat: Intl.DateTimeFormat | undefined;
const settingsTimeFormatter = () =>
  (settingsTimeFormat ??= new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  }));

/** Absolute status dates in settings, on the viewer's 12-hour clock with its zone. */
export function formatSettingsTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : settingsTimeFormatter().format(date);
}
