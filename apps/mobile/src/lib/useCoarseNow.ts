import { useEffect, useState } from "react";

/**
 * The time, refreshed every `everyMs`. For choices that drift slowly, such as
 * which of two accounts has the most left: reading the clock during render
 * would give every render its own answer.
 */
export function useCoarseNow(everyMs = 5 * 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(timer);
  }, [everyMs]);
  return now;
}
