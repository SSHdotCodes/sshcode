export const THREAD_HEADER_ITEMS = ["sideChat", "git", "files", "terminal"] as const;
export type ThreadHeaderItem = (typeof THREAD_HEADER_ITEMS)[number];

export const DEFAULT_THREAD_HEADER_ITEMS: readonly ThreadHeaderItem[] = ["sideChat", "git"];

export function sanitizeThreadHeaderItems(value: unknown): ThreadHeaderItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [
    ...new Set(
      value.filter((item): item is ThreadHeaderItem =>
        (THREAD_HEADER_ITEMS as readonly unknown[]).includes(item),
      ),
    ),
  ];
}

export function resolveThreadHeaderItems(
  stored: readonly ThreadHeaderItem[] | undefined,
): readonly ThreadHeaderItem[] {
  return stored ?? DEFAULT_THREAD_HEADER_ITEMS;
}

/** Preserve each platform's toolbar order without leaving slots for hidden or unavailable items. */
export function filterThreadHeaderItems<T>(
  items: ReadonlyArray<readonly [ThreadHeaderItem, T | null | undefined]>,
  visibleItems: readonly ThreadHeaderItem[],
): T[] {
  return items.flatMap(([kind, item]) =>
    visibleItems.includes(kind) && item != null ? [item] : [],
  );
}
