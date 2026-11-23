import { useState } from "react";
import {
  observeTimelineMessageArrivals,
  type TimelineMessageArrivals,
} from "./MessagesTimeline.logic";

export function useTimelineMessageArrivals(
  input: Parameters<typeof observeTimelineMessageArrivals>[1],
): number {
  const [previous, setPrevious] = useState<TimelineMessageArrivals | null>(null);
  const next = observeTimelineMessageArrivals(previous, input);
  if (next !== previous) setPrevious(next);
  return next.count;
}
