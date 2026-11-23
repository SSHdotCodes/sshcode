import type { ThreadRouteTarget } from "../../threadRoutes";

/**
 * How many recently shown chats stay mounted, hidden, besides the ones on
 * screen. Switching back to one only reveals it.
 */
export const KEPT_CHAT_VIEWS = 4;

interface HeapUsage {
  readonly usedJSHeapSize: number;
  readonly jsHeapSizeLimit: number;
}

/**
 * How many hidden chat views to keep now: one once the JS heap passes a quarter
 * of its limit, which only Chromium (so desktop) reports; elsewhere always the full count.
 */
export function keptChatViewCapacity(
  heap = (performance as { memory?: HeapUsage }).memory,
): number {
  return heap && heap.usedJSHeapSize > heap.jsHeapSizeLimit / 4 ? 1 : KEPT_CHAT_VIEWS;
}

export interface KeptChatView {
  /** React key: the thread key, or the draft id a promoted draft's view mounted under. */
  readonly key: string;
  readonly threadKey: string;
  /** The first target object it rendered with; a stable one lets its view skip renders. */
  readonly target: Extract<ThreadRouteTarget, { kind: "server" }>;
  /** Mount order. Views render in this order, so revealing one never moves DOM. */
  readonly order: number;
}

/**
 * The chat views to keep once `shown` (the server chats on screen now) is
 * displayed: those first, then the most recently shown others, at most
 * `capacity` of them. A chat that is already kept keeps its entry, so its view
 * is revealed rather than mounted again. Returns `kept` itself when nothing changes.
 */
export function keepChatViews(
  kept: ReadonlyArray<KeptChatView>,
  shown: ReadonlyArray<Omit<KeptChatView, "order">>,
  capacity: number,
): ReadonlyArray<KeptChatView> {
  const unchanged =
    shown.every((view) =>
      kept.slice(0, shown.length).some((k) => k.threadKey === view.threadKey),
    ) && kept.length <= shown.length + capacity;
  if (unchanged) return kept;
  let order = kept.reduce((latest, view) => Math.max(latest, view.order), 0);
  const front = shown.map(
    (view) => kept.find((k) => k.threadKey === view.threadKey) ?? { ...view, order: ++order },
  );
  const rest = kept.filter((k) => !front.includes(k)).slice(0, capacity);
  return [...front, ...rest];
}

/**
 * Whether an element is on screen. A hidden kept chat stays in the document
 * with its ids and open popups, so document-wide lookups skip what this rejects.
 */
export function isRenderedElement(element: Element): boolean {
  // jsdom has no checkVisibility; everything there counts as rendered.
  return typeof element.checkVisibility === "function" ? element.checkVisibility() : true;
}
