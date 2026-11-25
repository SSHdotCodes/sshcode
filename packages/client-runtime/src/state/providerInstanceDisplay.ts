/**
 * How a configured provider instance presents itself in a client: its label,
 * its accent color, and whether its icon carries the account badge. Shared by
 * web and mobile so both clients name and badge the same instance identically.
 *
 * @module providerInstanceDisplay
 */
import {
  defaultInstanceIdForDriver,
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProvider,
} from "@t3tools/contracts";

/**
 * Title-case a slug: splits on `_` / `-` and camelCase boundaries, so
 * `codex_personal` becomes "Codex Personal" and `myCustomInstance` becomes
 * "My Custom Instance".
 */
function humanizeSlug(slug: string): string {
  return slug
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/**
 * Resolve an instance's label with a tiered priority:
 *
 *   1. A snapshot `displayName` that differs from the driver's brand label —
 *      the server has explicitly named this instance, trust it.
 *   2. For non-default instances, a humanized `instanceId` — the server fell
 *      back to the driver-level label (the same for every instance of that
 *      kind), so the slug is what keeps "Codex" and "Codex Personal" apart.
 *   3. The snapshot's `displayName`, or the brand label from contracts.
 */
export function resolveProviderInstanceDisplayName(
  snapshot: Pick<ServerProvider, "instanceId" | "driver" | "displayName">,
): string {
  const trimmedSnapshotName = snapshot.displayName?.trim();
  const kindLabel = PROVIDER_DISPLAY_NAMES[snapshot.driver] ?? humanizeSlug(snapshot.driver);
  if (trimmedSnapshotName && trimmedSnapshotName !== kindLabel) return trimmedSnapshotName;
  if (snapshot.instanceId !== defaultInstanceIdForDriver(snapshot.driver)) {
    const humanized = humanizeSlug(snapshot.instanceId);
    if (humanized.length > 0) return humanized;
  }
  return trimmedSnapshotName || kindLabel;
}

function providerLabelWords(label: string): string[] {
  return label
    .replace(/[^\P{P}'’]+/gu, " ")
    .split(/\s+/u)
    .map((word) => word.replace(/^['’]+|['’]+$/gu, ""))
    .filter(Boolean);
}

function camelCaseWords(word: string): string[] {
  return word.replace(/(\p{Ll})(\p{Lu})/gu, "$1 $2").split(" ");
}

function firstTwoInitials(words: string[]): string {
  return words
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? "")
    .join("")
    .toUpperCase();
}

/**
 * Take the initials of two words or CamelCase segments, or the first two
 * characters of a single word. Iterates by code point to keep emoji whole.
 */
export function providerInstanceInitials(label: string): string {
  const words = providerLabelWords(label);
  if (words.length !== 1) return firstTwoInitials(words);
  const word = words[0]!;
  const segments = camelCaseWords(word);
  return segments.length > 1
    ? firstTwoInitials(segments)
    : Array.from(word).slice(0, 2).join("").toUpperCase();
}

/**
 * Mark an added account with its number when the name ends in one ("Work-2"
 * is "2"). Otherwise use its initial, or the initials of a single CamelCase name.
 */
export function providerInstanceMark(label: string): string {
  const words = providerLabelWords(label);
  if (words.length === 0) return "";
  const last = words[words.length - 1]!;
  if (/^\d{1,2}$/u.test(last)) return last;
  const first = words[0]!;
  return firstTwoInitials(words.length === 1 ? camelCaseWords(first) : [first]);
}

/** Only `#rrggbb` accent colors render; anything else is treated as unset. */
export function normalizeProviderAccentColor(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return /^#[0-9a-fA-F]{6}$/u.test(trimmed) ? trimmed : undefined;
}

/**
 * Whether an instance's icon carries the account badge: accent color set, or
 * an extra instance sharing a provider so the brand glyph alone is ambiguous.
 * The default instance (the user's own login) keeps the plain glyph; only the
 * extra ones carry a badge, unless they continue the own account's chats or draw their own icon.
 * ACP agents have distinct glyphs even though they share the registry driver.
 * Shared by the composer trigger, the picker rail, and sidebar/thread rows.
 */
export function shouldShowInstanceBadge(
  entry: {
    readonly instanceId?: string | undefined;
    readonly driverKind: ProviderDriverKind;
    readonly continuationGroupKey?: string | undefined;
    readonly accentColor?: string | undefined;
    readonly acpRegistryAgentId?: string | undefined;
    readonly acpRegistryIconUrl?: string | undefined;
  },
  entries: Iterable<{
    readonly instanceId?: string | undefined;
    readonly driverKind: ProviderDriverKind;
    readonly continuationGroupKey?: string | undefined;
    readonly acpRegistryAgentId?: string | undefined;
    readonly enabled?: boolean | undefined;
    readonly installed?: boolean | undefined;
  }>,
): boolean {
  if (entry.accentColor) return true;
  if (entry.instanceId === defaultInstanceIdForDriver(entry.driverKind)) return false;
  // Antigravity's extra instances are the user's other Google plans running the same models:
  // which plan a chat uses lives in its model options, not on the logo (a "G" on Gemini said
  // nothing).
  if (entry.driverKind === "antigravity") return false;
  // A non-ACP instance with its own icon (Qwen on Claude Code) already reads apart.
  if (entry.driverKind !== "acpRegistry" && entry.acpRegistryIconUrl) return false;
  let sharedProviderCount = 0;
  let ownInstance:
    | {
        readonly instanceId?: string | undefined;
        readonly continuationGroupKey?: string | undefined;
      }
    | undefined;
  let hasDefaultInstance = false;
  for (const candidate of entries) {
    if (candidate.driverKind !== entry.driverKind) continue;
    if (
      ownInstance === undefined ||
      candidate.instanceId === defaultInstanceIdForDriver(entry.driverKind)
    ) {
      ownInstance = candidate;
    }
    hasDefaultInstance ||= candidate.instanceId === defaultInstanceIdForDriver(entry.driverKind);
    if (
      entry.driverKind === "acpRegistry" &&
      candidate.acpRegistryAgentId !== entry.acpRegistryAgentId
    ) {
      continue;
    }
    // An entry that is turned off or not installed cannot be picked, so
    // there is nothing to tell this one apart from ("GB" on the only Grok).
    if (
      candidate.instanceId !== entry.instanceId &&
      (candidate.enabled === false || candidate.installed === false)
    ) {
      continue;
    }
    sharedProviderCount++;
  }
  if (
    entry.continuationGroupKey !== undefined &&
    entry.continuationGroupKey === ownInstance?.continuationGroupKey
  )
    return false;
  if (
    !hasDefaultInstance &&
    entry.instanceId !== undefined &&
    entry.instanceId === ownInstance?.instanceId
  )
    return false;
  return sharedProviderCount > 1;
}
