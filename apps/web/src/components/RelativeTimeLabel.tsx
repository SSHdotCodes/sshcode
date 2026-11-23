import { useNowMinuteMs } from "../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../timestampFormat";

/** Only the label needs to render again when the minute changes. */
export function RelativeTimeLabel({ at }: { at: string }) {
  return formatRelativeTimeLabel(at, useNowMinuteMs());
}
