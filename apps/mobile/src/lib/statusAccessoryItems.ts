/**
 * What the capsule between the tab bar and the compose button can show, in
 * the order offered in Settings.
 */
export const STATUS_ACCESSORY_ITEMS = [
  "limits",
  "connection",
  "working",
  "needsYou",
  "nextReset",
] as const;
export type StatusAccessoryItem = (typeof STATUS_ACCESSORY_ITEMS)[number];

export const DEFAULT_STATUS_ACCESSORY_ITEMS: readonly StatusAccessoryItem[] = [
  "limits",
  "connection",
];

function isStatusAccessoryItem(value: unknown): value is StatusAccessoryItem {
  return (STATUS_ACCESSORY_ITEMS as readonly unknown[]).includes(value);
}

/** Stored items, deduplicated and in order, or undefined when nothing valid was stored. */
export function sanitizeStatusAccessoryItems(value: unknown): StatusAccessoryItem[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter(isStatusAccessoryItem))];
}

/** The shown items, in order; the default until the user has chosen. */
export function resolveStatusAccessoryItems(
  stored: ReadonlyArray<StatusAccessoryItem> | undefined,
): readonly StatusAccessoryItem[] {
  return stored ?? DEFAULT_STATUS_ACCESSORY_ITEMS;
}

/**
 * True when a shown item depends on the current time: the limit rings pool
 * usage windows by the minute, and the reset countdown ages. The capsule then
 * re-reads the clock while it is on screen.
 */
export function statusAccessoryItemsNeedClock(items: ReadonlyArray<StatusAccessoryItem>): boolean {
  return items.includes("limits") || items.includes("nextReset");
}

/** Moves a shown item by whole positions, clamped to the list. */
export function moveStatusAccessoryItem(
  items: readonly StatusAccessoryItem[],
  item: StatusAccessoryItem,
  steps: number,
): StatusAccessoryItem[] {
  const next = [...items];
  const from = next.indexOf(item);
  if (from === -1) return next;
  const to = Math.min(next.length - 1, Math.max(0, from + steps));
  next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/**
 * This device's choice for each limit ring, by the ring's key: true shows it,
 * false hides it. A ring with no entry follows its account's own setting.
 */
export type LimitRingChoices = Readonly<Record<string, boolean>>;

/** Stored provider names whose rings combine; anything that is not text is dropped. */
export function sanitizeCombinedLimitRings(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return [...new Set(value.filter((entry): entry is string => typeof entry === "string"))];
}

/** Stored ring choices with anything that is not a yes or no dropped. */
export function sanitizeLimitRingChoices(value: unknown): Record<string, boolean> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const choices: Record<string, boolean> = {};
  for (const [key, shown] of Object.entries(value)) {
    if (typeof shown === "boolean") choices[key] = shown;
  }
  return choices;
}
