import { useLayoutEffect, useState } from "react";

/** Sample wall time when a deadline changes or expires, including after a throttled timer. */
export function useDeadlineClock(deadlines: ReadonlyArray<number>): number {
  const [now, setNow] = useState(Date.now);
  useLayoutEffect(() => {
    if (deadlines.length === 0) return;
    let timer: number | undefined;
    const sample = () => {
      const current = Date.now();
      setNow(current);
      let next = Infinity;
      for (const deadline of deadlines) {
        if (deadline > current && deadline < next) next = deadline;
      }
      if (Number.isFinite(next)) {
        timer = window.setTimeout(sample, Math.min(next - current, 2_147_483_647));
      }
    };
    sample();
    return () => window.clearTimeout(timer);
  }, [deadlines]);
  return now;
}
