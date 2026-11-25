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

function foldExcerpt(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ς/g, "σ");
}

function excerptOffsets(text: string) {
  const folded = foldExcerpt(text);
  if (/^[\u0000-\u007F]*$/.test(text)) return { folded, starts: null, ends: null };
  const starts: number[] = [];
  const ends: number[] = [];
  for (const cluster of text.matchAll(/\P{M}\p{M}*|\p{M}+/gu)) {
    const start = cluster.index;
    const original = cluster[0];
    const length = foldExcerpt(original).length;
    for (let index = 0; index < length; index++) {
      starts.push(start);
      ends.push(start + original.length);
    }
  }
  return { folded, starts, ends };
}

/** Highlights the phrase and individual terms in a global search result. */
export function splitThreadSearchExcerpt(
  text: string,
  query: string,
  correction?: string,
): ThreadSearchTextPart[] {
  const phrase = foldExcerpt(query.trim().replace(/\s+/g, " "));
  const terms = new Set([
    phrase,
    ...(phrase.match(/[\p{L}\p{N}]+/gu) ?? []),
    correction ? foldExcerpt(correction) : "",
  ]);
  const { folded, starts, ends } = excerptOffsets(text);
  const ranges: Array<{ start: number; end: number }> = [];
  for (const term of terms) {
    if (!term || (term.length < 2 && !/\d/.test(term))) continue;
    let cursor = 0;
    while (cursor < folded.length) {
      const start = folded.indexOf(term, cursor);
      if (start < 0) break;
      const end = start + term.length;
      ranges.push({ start: starts?.[start] ?? start, end: ends?.[end - 1] ?? end });
      cursor = end;
    }
  }
  ranges.sort((left, right) => left.start - right.start || right.end - left.end);
  const parts: ThreadSearchTextPart[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start < cursor) {
      const previous = parts[parts.length - 1]!;
      parts[parts.length - 1] = { ...previous, text: text.slice(previous.start, range.end) };
    } else {
      if (cursor < range.start)
        parts.push({ text: text.slice(cursor, range.start), highlighted: false, start: cursor });
      parts.push({
        text: text.slice(range.start, range.end),
        highlighted: true,
        start: range.start,
      });
    }
    cursor = range.end;
  }
  if (cursor < text.length)
    parts.push({ text: text.slice(cursor), highlighted: false, start: cursor });
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
  const phrase = foldExcerpt(query.trim());
  if (phrase.length === 0) return snippet;
  const { folded, starts } = excerptOffsets(snippet);
  let match = folded.indexOf(phrase);
  if (match < 0) {
    const words = phrase
      .split(/\s+/)
      .filter((word) => word.length >= 3)
      .sort((left, right) => right.length - left.length);
    for (const word of words) {
      match = folded.indexOf(word);
      if (match >= 0) break;
    }
  }
  const offset = starts?.[match] ?? match;
  if (offset <= SNIPPET_LEAD_CHARS) return snippet;
  let start = offset - SNIPPET_LEAD_CHARS;
  const space = snippet.indexOf(" ", start);
  if (space !== -1 && space < offset) start = space + 1;
  // Never begin on the second half of a surrogate pair.
  const code = snippet.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return `…${snippet.slice(start)}`;
}
