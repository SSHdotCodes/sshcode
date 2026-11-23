/** A link to one X post found in a message. */
export interface XPostLink {
  readonly id: string;
  /** The post's plain address, without tracking or media suffixes. */
  readonly url: string;
}

const POST_LINK =
  /https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(?:([A-Za-z0-9_]{1,15})\/status(?:es)?|i\/web\/status)\/([1-9]\d{0,24})(?!\w)/g;

/**
 * The X posts a message links to, in order and without repeats, for the small
 * cards shown under it. Links inside code are left alone: they are examples,
 * not something the reader was sent.
 */
export function xPostLinks(text: string, limit = 3): ReadonlyArray<XPostLink> {
  if (limit <= 0 || !text.includes("/status")) return [];
  const prose = text.replace(/```[\s\S]*?(?:```|$)/g, " ").replace(/`[^`\n]*`/g, " ");
  const links: Array<XPostLink> = [];
  const seen = new Set<string>();
  // A fresh expression per call: a shared global one keeps its position.
  const pattern = new RegExp(POST_LINK.source, "g");
  for (let match = pattern.exec(prose); match !== null; match = pattern.exec(prose)) {
    const id = match[2]!;
    if (seen.has(id)) continue;
    seen.add(id);
    links.push({ id, url: `https://x.com/${match[1] ?? "i"}/status/${id}` });
    if (links.length >= limit) break;
  }
  return links;
}
