interface ThreadSearchTextPart {
  readonly text: string;
  readonly highlighted: boolean;
  readonly start: number;
}

function foldThreadSearchCase(text: string): string {
  const lowered = text.toLowerCase().replace(/ς/g, "σ");
  if (lowered.length === text.length) return lowered;

  let folded = "";
  for (const character of text) {
    const loweredCharacter = character.toLowerCase().replace(/ς/g, "σ");
    folded += loweredCharacter.length === character.length ? loweredCharacter : character;
  }
  return folded;
}

function scanThreadSearchOccurrences(text: string, query: string, offsets?: number[]): number {
  if (text.length === 0 || query.length === 0) return 0;

  const foldedText = foldThreadSearchCase(text);
  const foldedQuery = foldThreadSearchCase(query);
  let count = 0;
  let cursor = 0;

  while (cursor <= foldedText.length - foldedQuery.length) {
    const offset = foldedText.indexOf(foldedQuery, cursor);
    if (offset === -1) break;
    offsets?.push(offset);
    count += 1;
    cursor = offset + foldedQuery.length;
  }
  return count;
}

export function countThreadSearchOccurrences(text: string, query: string): number {
  return scanThreadSearchOccurrences(text, query);
}

export function findThreadSearchOccurrences(text: string, query: string): number[] {
  const offsets: number[] = [];
  scanThreadSearchOccurrences(text, query, offsets);
  return offsets;
}

export function splitThreadSearchText(text: string, query: string): ThreadSearchTextPart[] {
  const normalizedQuery = query.trim();
  if (normalizedQuery.length === 0) {
    return [{ text, highlighted: false, start: 0 }];
  }

  const parts: ThreadSearchTextPart[] = [];
  let cursor = 0;
  for (const offset of findThreadSearchOccurrences(text, normalizedQuery)) {
    if (offset > cursor) {
      parts.push({ text: text.slice(cursor, offset), highlighted: false, start: cursor });
    }
    parts.push({
      text: text.slice(offset, offset + normalizedQuery.length),
      highlighted: true,
      start: offset,
    });
    cursor = offset + normalizedQuery.length;
  }
  if (cursor < text.length) {
    parts.push({ text: text.slice(cursor), highlighted: false, start: cursor });
  }
  return parts;
}

/** How much text may come before the match in a one-line result row. */
const SNIPPET_LEAD_CHARS = 18;

/**
 * A snippet for a one-line row. When the match sits further in than a row shows, the text
 * before it is cut at a word boundary and marked with "…", so the matched words are visible
 * instead of truncated away. Falls back to the query's longest word when the whole phrase is
 * not in the snippet, and leaves a snippet with no match (a meaning match) as it is.
 */
export function focusThreadSearchSnippet(snippet: string, query: string): string {
  const phrase = query.trim();
  if (phrase.length === 0) return snippet;
  let offset = findThreadSearchOccurrences(snippet, phrase)[0];
  if (offset === undefined) {
    const words = phrase
      .split(/\s+/)
      .filter((word) => word.length >= 3)
      .sort((left, right) => right.length - left.length);
    for (const word of words) {
      offset = findThreadSearchOccurrences(snippet, word)[0];
      if (offset !== undefined) break;
    }
  }
  if (offset === undefined || offset <= SNIPPET_LEAD_CHARS) return snippet;
  let start = offset - SNIPPET_LEAD_CHARS;
  const space = snippet.indexOf(" ", start);
  if (space !== -1 && space < offset) start = space + 1;
  // Never begin on the second half of a surrogate pair.
  const code = snippet.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return `…${snippet.slice(start)}`;
}
