/** Text helpers shared by the box models: cleaning titles and tokenizing for features. */

const MARKDOWN_LINK = /!?\[([^\]]*)\]\([^)]*\)/g;
const URL = /\bhttps?:\/\/\S+/g;

/** A title as the user reads it: link text kept, link targets, markup and emoji dropped. */
export function cleanSessionTitle(title: string): string {
  return title
    .replace(MARKDOWN_LINK, (_, text: string) => text)
    .replace(URL, " ")
    .replace(/[`*_#>~]/g, " ")
    .replace(/\p{Extended_Pictographic}/gu, " ")
    .replace(/\.(png|jpe?g|gif|webp|heic|mov|mp4|pdf)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface TitleToken {
  /** The word as written. */
  readonly text: string;
  /** Lowercase with edge punctuation removed; empty for pure punctuation. */
  readonly norm: string;
  readonly index: number;
}

/** Splits on whitespace and separators people use in titles (·, —, |, :). */
export function tokenizeTitle(title: string): TitleToken[] {
  const parts = cleanSessionTitle(title)
    .split(/\s+|(?<=[·—|:])|(?=[·—|:])/u)
    .filter((part) => part.length > 0);
  return parts.map((text, index) => ({
    text,
    norm: text.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#.]+$/gu, ""),
    index,
  }));
}

/** Words for bag-of-words features: lowercase letters/digits runs plus `word.word` pieces. */
export function featureWords(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+(?:[.'+-][\p{L}\p{N}]+)*/gu) ?? [];
}

/** 32-bit FNV-1a, the feature hash every model in this folder uses. */
export function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}
