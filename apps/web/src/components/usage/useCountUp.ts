import { useEffect, useRef, useState } from "react";

const DURATION_MS = 700;

/**
 * Eases a displayed number toward its target, from zero on first sight and
 * from wherever it stands on later changes. Jumps straight there for people
 * who ask for less motion, and whenever `animate` is false.
 */
export function useCountUp(target: number, animate = true): number {
  const [value, setValue] = useState(() => (animate ? 0 : target));
  const valueRef = useRef(value);
  // Runs before the effect below, so a new target starts from the figure on screen.
  useEffect(() => {
    valueRef.current = value;
  });

  useEffect(() => {
    const still =
      !animate ||
      !Number.isFinite(target) ||
      typeof window === "undefined" ||
      typeof window.matchMedia !== "function" ||
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const from = valueRef.current;
    if (still || from === target) {
      setValue(target);
      return;
    }
    const start = performance.now();
    let frame = requestAnimationFrame(function step(now) {
      const progress = Math.min(1, (now - start) / DURATION_MS);
      setValue(from + (target - from) * (1 - (1 - progress) ** 4));
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [animate, target]);

  return value;
}
