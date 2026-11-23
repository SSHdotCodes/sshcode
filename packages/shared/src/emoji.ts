/** Compact offline data: glyph, space-separated shortcode aliases, and search keywords. */
export type EmojiEntry = readonly [emoji: string, names: string, keywords: string];
export type EmojiData = ReadonlyArray<EmojiEntry>;

let dataPromise: Promise<EmojiData> | undefined;
export function loadEmojiData(): Promise<EmojiData> {
  return (dataPromise ??= import("./emojiData.ts")
    .then(({ emojiData }) => emojiData)
    .catch((error) => {
      dataPromise = undefined;
      throw error;
    }));
}

export const EMOJI_SHORTCODE = /:([a-z0-9_+-]+):/gi;
export function hasEmojiShortcode(text: string): boolean {
  return /:[a-z0-9_+-]+:/i.test(text);
}

const POPULAR_NAMES = [
  "tada",
  "sparkles",
  "+1",
  "heart",
  "rocket",
  "eyes",
  "joy",
  "fire",
  "wave",
  "smile",
  "thinking",
  "white_check_mark",
  "pray",
  "muscle",
  "raised_hands",
  "100",
  "clap",
  "heart_eyes",
  "sunglasses",
  "seedling",
  "coffee",
  "brain",
  "robot",
  "zap",
];

/** Exact names lead, followed by name prefixes, words, and then keyword matches. */
export function searchEmoji(data: EmojiData, query: string, limit = 48): EmojiEntry[] {
  const normalized = query
    .trim()
    .toLowerCase()
    .replace(/^:|:$/g, "")
    .replaceAll(/\s+|(?<=\w)-/g, "_");
  if (!normalized) {
    const byName = new Map(
      data.flatMap((entry) => entry[1].split(" ").map((name) => [name, entry] as const)),
    );
    return POPULAR_NAMES.flatMap((name) => (byName.get(name) ? [byName.get(name)!] : [])).slice(
      0,
      limit,
    );
  }
  const words = normalized.split("_").filter(Boolean);
  const ranked: Array<{ entry: EmojiEntry; score: number; index: number }> = [];
  data.forEach((entry, index) => {
    const names = entry[1].split(" ");
    const nameWords = entry[1].replaceAll("_", " ").split(" ");
    const keywords = entry[2].split(" ");
    const score = names.includes(normalized)
      ? 0
      : names.some((name) => name.startsWith(normalized))
        ? 1
        : words.every((word) => nameWords.some((name) => name.startsWith(word)))
          ? 2
          : words.every((word) => [...nameWords, ...keywords].some((name) => name.startsWith(word)))
            ? 3
            : names.some((name) => name.includes(normalized))
              ? 4
              : -1;
    if (score >= 0) ranked.push({ entry, score, index });
  });
  const popularity = new Map(POPULAR_NAMES.map((name, index) => [name, index]));
  return ranked
    .sort(
      (a, b) =>
        a.score - b.score ||
        (popularity.get(emojiName(a.entry)) ?? 100) - (popularity.get(emojiName(b.entry)) ?? 100) ||
        a.index - b.index,
    )
    .slice(0, limit)
    .map(({ entry }) => entry);
}

export function emojiName(entry: EmojiEntry): string {
  return entry[1].split(" ")[0]!;
}

/** One to three complete emoji graphemes, including flags, skin tones and ZWJ families. */
export function isEmojiOnlyMessage(text: string): boolean {
  const value = text.trim();
  if (!value || value.length > 100) return false;
  const compact = value.replaceAll(/\s/g, "");
  const segments =
    compact.match(
      /(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?(?:\u200D\p{Extended_Pictographic}(?:\uFE0F|\p{Emoji_Modifier})?)*)/gu,
    ) ?? [];
  return (
    segments.length >= 1 &&
    segments.length <= 3 &&
    segments.join("") === compact &&
    segments.every((segment) => !/^[©®™]$/.test(segment))
  );
}
