import {
  parseComposerRecentPaths,
  parseComposerRecentUses,
  recordComposerRecentPath,
  recordComposerRecentUse,
  type ComposerRecentPathsByWorkspace,
} from "@t3tools/client-runtime/composer-command-recency";

const RECENT_COMMANDS_STORAGE_KEY = "t3code:composer-recent-commands:v1";
const RECENT_PATHS_STORAGE_KEY = "t3code:composer-recent-paths:v2";

let cachedCommands: ReadonlyArray<string> | null = null;
let cachedPaths: ComposerRecentPathsByWorkspace | null = null;

function readStorageItem(key: string): string | null {
  try {
    return typeof window !== "undefined" ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeStorageItem(key: string, value: string): void {
  try {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(key, value);
    }
  } catch {
    // Keep the in-memory copy when storage is unavailable.
  }
}

export function readRecentComposerCommands(): ReadonlyArray<string> {
  if (cachedCommands === null) {
    cachedCommands = parseComposerRecentUses(readStorageItem(RECENT_COMMANDS_STORAGE_KEY));
  }
  return cachedCommands;
}

export function recordRecentComposerCommand(key: string): ReadonlyArray<string> {
  const current = readRecentComposerCommands();
  const next = recordComposerRecentUse(current, key);
  if (next === current) return current;
  cachedCommands = next;
  writeStorageItem(RECENT_COMMANDS_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function readRecentComposerPaths(): ComposerRecentPathsByWorkspace {
  if (cachedPaths === null) {
    cachedPaths = parseComposerRecentPaths(readStorageItem(RECENT_PATHS_STORAGE_KEY));
  }
  return cachedPaths;
}

export function recordRecentComposerPath(
  workspaceKey: string,
  path: string,
): ComposerRecentPathsByWorkspace {
  const current = readRecentComposerPaths();
  const next = recordComposerRecentPath(current, workspaceKey, path);
  if (next === current) return current;
  cachedPaths = next;
  writeStorageItem(RECENT_PATHS_STORAGE_KEY, JSON.stringify(next));
  return next;
}
