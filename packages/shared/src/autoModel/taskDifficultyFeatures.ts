import { fnv1a } from "../sessionBoxes/text.ts";

/**
 * Feature strings for the task-difficulty model. This mirrors the Python featurizer the
 * model was trained with (scripts/auto-model/feat.py): any change here must be made
 * there too and the model retrained, or the weights stop meaning anything.
 */
const MAX_CHARS = 2000;
const MAX_TOKENS = 240;
const SPACE = /[\x00-\x20\x7f\u00a0\u2028\u2029]+/g;
// What Python's str.strip() still removes after SPACE has run.
const EDGE_SPACE =
  /^[ \x85\u1680\u2000-\u200a\u202f\u205f\u3000]+|[ \x85\u1680\u2000-\u200a\u202f\u205f\u3000]+$/g;
const URL = /https?:\/\/[^ ]+/g;
const PATH = /(?:~|\.{0,2})\/[a-z0-9_./-]+/g;
const NUMBER = /[0-9]+/g;
const TOKEN = /[a-z0-9_]+|[^ a-z0-9_]/gu;

/** `floor(log2(n))`, capped: the bin a length falls in. */
function log2Bin(value: number, cap: number): number {
  let bin = 0;
  for (let rest = value; rest > 1 && bin < cap; rest = Math.floor(rest / 2)) bin += 1;
  return bin;
}

/** Counts code points, as Python's `len` does. */
function codePointLength(text: string): number {
  let length = 0;
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) index += 1;
    }
    length += 1;
  }
  return length;
}

/** The first `MAX_CHARS` code points. */
function head(text: string): string {
  if (text.length <= MAX_CHARS) return text;
  let end = 0;
  for (let count = 0; count < MAX_CHARS && end < text.length; count++) {
    const unit = text.charCodeAt(end);
    const next = end + 1 < text.length ? text.charCodeAt(end + 1) : 0;
    end += unit >= 0xd800 && unit <= 0xdbff && next >= 0xdc00 && next <= 0xdfff ? 2 : 1;
  }
  return text.slice(0, end);
}

/** Deduplicated feature strings in first-seen order. */
export function taskDifficultyFeatures(text: string, attachmentCount: number): string[] {
  const start = head(text);
  const raw = start.replace(SPACE, " ").replace(EDGE_SPACE, "");
  const lower = raw.toLowerCase();
  URL.lastIndex = 0;
  const hasUrl = URL.test(lower);
  const withoutUrls = lower.replace(URL, " <url> ");
  PATH.lastIndex = 0;
  const hasPath = PATH.test(withoutUrls);
  const normalized = withoutUrls.replace(PATH, " <path> ").replace(NUMBER, "0");
  const tokens = (normalized.match(TOKEN) ?? []).slice(0, MAX_TOKENS);
  const seen = new Set<string>();
  const features: string[] = [];
  const add = (feature: string) => {
    if (!seen.has(feature)) {
      seen.add(feature);
      features.push(feature);
    }
  };
  for (let index = 0; index < tokens.length; index++) {
    const word = tokens[index]!;
    add(`w:${word}`);
    if (index + 1 < tokens.length) add(`b:${word} ${tokens[index + 1]!}`);
    if (word.length >= 3 && /^[a-z0-9_]/.test(word)) {
      const padded = ` ${word} `;
      for (const size of [3, 4, 5]) {
        for (let at = 0; at + size <= padded.length; at++) add(`c:${padded.slice(at, at + size)}`);
      }
    }
  }
  if (tokens.length > 0) {
    add(`f:${tokens[0]!}`);
    if (tokens.length > 1) add(`f2:${tokens[0]!} ${tokens[1]!}`);
    add(`l:${tokens[tokens.length - 1]!}`);
  }
  add(`m:len${log2Bin(codePointLength(text), 13)}`);
  add(`m:tok${log2Bin(tokens.length, 8)}`);
  add(`m:lines${log2Bin(start.split("\n").length, 6)}`);
  if (attachmentCount > 0) add("m:att");
  if (start.includes("```")) add("m:code");
  if (raw.includes("?")) add("m:q");
  if (hasUrl) add("m:url");
  if (hasPath) add("m:path");
  return features;
}

/** The hash of each feature, for tests that pin this port to the trained one. */
export function taskDifficultyFeatureHashes(features: ReadonlyArray<string>): number[] {
  return features.map(fnv1a);
}
