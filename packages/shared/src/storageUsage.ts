/**
 * The Storage card on Usage › Limits, shared by web and mobile: which reading
 * to show and how its numbers read.
 *
 * @module storageUsage
 */
import type { EnvironmentId, StorageUsageSnapshot } from "@t3tools/contracts";

import { formatDuration } from "./usageLimits.ts";

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const TRASH_WORTH_SHOWING_BYTES = 1024 * 1024;

/** Binary units (`20 TB` is 20 TiB), two or three significant digits. */
export function formatStorageBytes(bytes: number): string {
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  let text = value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2);
  // 1023.7 GB rounds to "1024": say "1 TB" instead.
  if (Number(text) >= 1024 && unit < UNITS.length - 1) {
    unit += 1;
    text = (value / 1024).toFixed(2);
  }
  // Number() drops trailing zeros: "1.20" reads "1.2", "20.0" reads "20".
  return `${Number(text)} ${UNITS[unit]}`;
}

/**
 * One reading per storage label across the selected environments. Machines
 * that report the same storage collapse into one card showing the freshest
 * numbers.
 */
export function collectStorage(
  presentations: ReadonlyMap<
    EnvironmentId,
    { readonly serverConfig: { readonly storage?: StorageUsageSnapshot | undefined } | null }
  >,
): readonly StorageUsageSnapshot[] {
  const byLabel = new Map<string, StorageUsageSnapshot>();
  for (const presentation of presentations.values()) {
    const storage = presentation.serverConfig?.storage;
    if (!storage) continue;
    const held = byLabel.get(storage.label);
    const newer = held ? Date.parse(storage.checkedAt) - Date.parse(held.checkedAt) : 1;
    if (newer > 0 || (newer === 0 && held?.error !== undefined && storage.error === undefined)) {
      byLabel.set(storage.label, storage);
    }
  }
  return [...byLabel.values()];
}

export interface StorageCardText {
  /** Share of the total in use, 0 to 1, for the bar. */
  readonly usedShare: number;
  /** `1.2 TB of 20 TB used` */
  readonly used: string;
  /** `3 GB in trash`, or null when the trash holds under 1 MB. */
  readonly trash: string | null;
  /** `checked 5m ago`, like the limit cards' `resets in`. */
  readonly checked: string;
}

export function describeStorage(storage: StorageUsageSnapshot, now: number): StorageCardText {
  const age = now - Date.parse(storage.checkedAt);
  return {
    usedShare:
      storage.totalBytes > 0 ? Math.min(1, Math.max(0, storage.usedBytes / storage.totalBytes)) : 0,
    used: `${formatStorageBytes(storage.usedBytes)} of ${formatStorageBytes(storage.totalBytes)} used`,
    // A few bytes left by a deleted test file are noise, not something to empty.
    trash:
      storage.trashedBytes >= TRASH_WORTH_SHOWING_BYTES
        ? `${formatStorageBytes(storage.trashedBytes)} in trash`
        : null,
    checked:
      !Number.isFinite(age) || age < 60_000
        ? "checked just now"
        : `checked ${formatDuration(age)} ago`,
  };
}
