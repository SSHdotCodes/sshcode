type PickerMode = "date" | "time";

/** Expo UI 58.0.11's Android date picker reads and returns UTC calendar days.
 * Keep this conversion paired with mergeScheduledMessagePickerValue when upgrading Expo.
 * https://github.com/expo/expo/issues/50938
 */
export function scheduledMessagePickerValue(value: Date, mode: PickerMode, platform: string): Date {
  if (platform !== "android") return value;
  if (mode === "date") {
    return new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()));
  }
  // Expo's lenient Calendar normalizes a picked hour on its input day before
  // JS sees it. Use a stable local day so a spring-gap choice stays 02:30 until
  // mergeScheduledMessagePickerValue validates it against the actual send day.
  return new Date(2000, 0, 1, value.getHours(), value.getMinutes(), 0, 0);
}

/** A date pick changes only the calendar day; a time pick changes only local hours/minutes. */
export function mergeScheduledMessagePickerValue(
  previous: Date,
  picked: Date,
  mode: PickerMode,
  platform: string,
): Date | null {
  if (!Number.isFinite(previous.getTime()) || !Number.isFinite(picked.getTime())) return null;
  const utcDay = platform === "android" && mode === "date";
  const year =
    mode === "date"
      ? utcDay
        ? picked.getUTCFullYear()
        : picked.getFullYear()
      : previous.getFullYear();
  const month =
    mode === "date" ? (utcDay ? picked.getUTCMonth() : picked.getMonth()) : previous.getMonth();
  const day =
    mode === "date" ? (utcDay ? picked.getUTCDate() : picked.getDate()) : previous.getDate();
  const hour = mode === "time" ? picked.getHours() : previous.getHours();
  const minute = mode === "time" ? picked.getMinutes() : previous.getMinutes();
  const merged = new Date(year, month, day, hour, minute, 0, 0);
  // A daylight-saving gap must not silently move the selected local time.
  return merged.getFullYear() === year &&
    merged.getMonth() === month &&
    merged.getDate() === day &&
    merged.getHours() === hour &&
    merged.getMinutes() === minute
    ? merged
    : null;
}
