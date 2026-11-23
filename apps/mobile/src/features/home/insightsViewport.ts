/**
 * How far the home list has scrolled, shared with Insights so each card can arrive as it
 * comes into view. Plain listeners, no React state: the list scrolls at 60 frames a
 * second and a card only cares once.
 */
import {
  createContext,
  use,
  useCallback,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Dimensions, type ViewInstance } from "react-native";

type Listener = (remeasure: boolean) => void;

export interface InsightsViewport {
  /** The list's scroll offset, in the same terms every time. */
  offset(): number;
  setOffset(offset: number): void;
  /** Layout may have moved: listeners measure themselves again. */
  remeasure(): void;
  subscribe(listener: Listener): () => void;
}

export function createInsightsViewport(initialOffset = 0): InsightsViewport {
  let current = initialOffset;
  const listeners = new Set<Listener>();
  return {
    offset: () => current,
    setOffset(offset) {
      current = offset;
      for (const listener of listeners) listener(false);
    },
    remeasure() {
      for (const listener of listeners) listener(true);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const InsightsViewportContext = createContext<InsightsViewport | null>(null);

/** How far above the bottom edge a card must rise before it arrives. */
const ARRIVAL_INSET = 56;

/**
 * Turns true, once, when the view behind `ref` has risen into the window. Without a
 * viewport (a screen that is not the home list) it is in view from the start.
 */
export function useArrived(ref: RefObject<ViewInstance | null>, enabled = true): boolean {
  const viewport = use(InsightsViewportContext);
  const [arrived, setArrived] = useState(viewport === null);
  // Where the view sits when the list is at offset 0: window y plus the offset measured at.
  const anchor = useRef<number | null>(null);
  const done = useRef(arrived);
  const check = useCallback(() => {
    if (done.current || anchor.current === null || viewport === null) return;
    if (anchor.current - viewport.offset() < Dimensions.get("window").height - ARRIVAL_INSET) {
      done.current = true;
      setArrived(true);
    }
  }, [viewport]);
  const measure = useCallback(() => {
    if (done.current || viewport === null) return;
    ref.current?.measureInWindow((_x, y, _width, height) => {
      if (height <= 0) return;
      anchor.current = y + viewport.offset();
      check();
    });
  }, [check, ref, viewport]);
  useEffect(() => {
    if (!enabled || viewport === null || done.current) return;
    const frame = requestAnimationFrame(measure);
    const unsubscribe = viewport.subscribe((remeasure) => (remeasure ? measure() : check()));
    return () => {
      cancelAnimationFrame(frame);
      unsubscribe();
    };
  }, [check, enabled, measure, viewport]);
  return arrived;
}
