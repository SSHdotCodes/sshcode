const STORAGE_KEY = "t3code:emoji-recents:v1";
const MAX_RECENTS = 16;

export function readEmojiRecents(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (name): name is string =>
                typeof name === "string" && /^[a-z0-9_+-]{1,80}$/.test(name),
            ),
          ),
        ].slice(0, MAX_RECENTS)
      : [];
  } catch {
    return [];
  }
}

export function rememberEmoji(name: string): string[] {
  const recents = [name, ...readEmojiRecents().filter((recent) => recent !== name)].slice(
    0,
    MAX_RECENTS,
  );
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recents));
  } catch {
    /* Storage can be unavailable. */
  }
  return recents;
}
