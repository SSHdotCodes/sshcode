/**
 * Bounded client-side recency memory for composer `/` commands, `$` skills, and
 * `@` file mentions. Shared by web (localStorage) and mobile (kv-store) so both
 * rank empty queries and equal-score ties identically.
 */

export const COMPOSER_RECENT_COMMANDS_MAX = 48;
export const COMPOSER_RECENT_PATHS_MAX_WORKSPACES = 12;
export const COMPOSER_RECENT_PATHS_MAX_PER_WORKSPACE = 32;

export function composerBuiltInSlashRecencyKey(command: string): string {
  return `slash:${command.trim().toLowerCase()}`;
}

export function composerProviderSlashRecencyKey(commandName: string): string {
  return `provider-slash:${commandName.trim().toLowerCase()}`;
}

/** Shared between `/` and `$` menus so picking a skill in either boosts both. */
export function composerSkillRecencyKey(skillName: string): string {
  return `skill:${skillName.trim().toLowerCase()}`;
}

/** Parse a stored MRU list, dropping malformed entries and bounding its length. */
export function parseComposerRecentUses(
  raw: string | null | undefined,
  maxEntries = COMPOSER_RECENT_COMMANDS_MAX,
): ReadonlyArray<string> {
  if (!raw || maxEntries <= 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== "string" || entry.length === 0 || seen.has(entry)) continue;
      seen.add(entry);
      out.push(entry);
      if (out.length >= maxEntries) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** Move `key` to the front of the MRU list, deduping and clamping to `maxEntries`. */
export function recordComposerRecentUse(
  recent: ReadonlyArray<string>,
  key: string,
  maxEntries = COMPOSER_RECENT_COMMANDS_MAX,
): ReadonlyArray<string> {
  if (!key || maxEntries <= 0) return recent;
  if (recent[0] === key && recent.length <= maxEntries) return recent;
  const next = [key];
  for (const existing of recent) {
    if (existing === key) continue;
    next.push(existing);
    if (next.length >= maxEntries) break;
  }
  return next;
}

export function composerRecentRankMap(recent: ReadonlyArray<string>): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  recent.forEach((key, index) => {
    if (!map.has(key)) map.set(key, index);
  });
  return map;
}

/**
 * Lexicographic tiebreaker prefix for `insertRankedSearchResult`: recently used
 * entries sort before unused ones (and more recent before older) within equal
 * match scores.
 */
export function composerRecentTieBreakerPrefix(rank: number | undefined): string {
  return rank === undefined ? "1" : `0${String(Math.min(rank, 9999)).padStart(4, "0")}`;
}

/**
 * Order items for an empty query: recently used items lead in MRU order,
 * followed by remaining items in their existing order.
 */
export function orderByComposerRecentUse<T>(
  items: ReadonlyArray<T>,
  recent: ReadonlyArray<string>,
  keyOf: (item: T) => string,
): T[] {
  if (recent.length === 0 || items.length < 2) return [...items];
  const ranks = composerRecentRankMap(recent);
  let hasAny = false;
  for (const item of items) {
    if (ranks.has(keyOf(item))) {
      hasAny = true;
      break;
    }
  }
  if (!hasAny) return [...items];
  return items
    .map((item, index) => ({
      item,
      index,
      rank: ranks.get(keyOf(item)) ?? Number.POSITIVE_INFINITY,
    }))
    .sort((left, right) => left.rank - right.rank || left.index - right.index)
    .map(({ item }) => item);
}

export type ComposerRecentPathsByWorkspace = Readonly<Record<string, ReadonlyArray<string>>>;

/**
 * Scope recent `@` file mentions by both environment and cwd so identical
 * directory paths on different machines never share recency.
 */
export function composerPathWorkspaceKey(
  environmentId: string | null | undefined,
  cwd: string | null | undefined,
): string | null {
  if (!environmentId || !cwd) return null;
  return `${environmentId}\u0000${cwd}`;
}

export function parseComposerRecentPaths(
  raw: string | null | undefined,
  maxWorkspaces = COMPOSER_RECENT_PATHS_MAX_WORKSPACES,
  maxPerWorkspace = COMPOSER_RECENT_PATHS_MAX_PER_WORKSPACE,
): ComposerRecentPathsByWorkspace {
  if (!raw || maxWorkspaces <= 0 || maxPerWorkspace <= 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const entries = Object.entries(parsed).slice(-maxWorkspaces);
    const out: Record<string, ReadonlyArray<string>> = {};
    for (const [workspaceKey, paths] of entries) {
      if (!workspaceKey || !Array.isArray(paths)) continue;
      const cleaned = parseComposerRecentUses(JSON.stringify(paths), maxPerWorkspace);
      if (cleaned.length > 0) out[workspaceKey] = cleaned;
    }
    return out;
  } catch {
    return {};
  }
}

export function recordComposerRecentPath(
  byWorkspace: ComposerRecentPathsByWorkspace,
  workspaceKey: string,
  path: string,
  maxWorkspaces = COMPOSER_RECENT_PATHS_MAX_WORKSPACES,
  maxPerWorkspace = COMPOSER_RECENT_PATHS_MAX_PER_WORKSPACE,
): ComposerRecentPathsByWorkspace {
  if (!workspaceKey || !path || maxWorkspaces <= 0 || maxPerWorkspace <= 0) return byWorkspace;
  const current = byWorkspace[workspaceKey] ?? [];
  const nextPaths = recordComposerRecentUse(current, path, maxPerWorkspace);
  const existingKeys = Object.keys(byWorkspace);
  if (nextPaths === current && existingKeys[existingKeys.length - 1] === workspaceKey) {
    return byWorkspace;
  }
  const { [workspaceKey]: _previous, ...rest } = byWorkspace;
  const kept = Object.entries(rest).slice(-(maxWorkspaces - 1));
  return Object.fromEntries([...kept, [workspaceKey, nextPaths]]);
}
