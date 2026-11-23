import type { XPostPreview } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { parsePostUrl } from "./normalize.ts";
import type { Post } from "./schema.ts";
import * as XPostReader from "./XPostReader.ts";

const HOUR = 60 * 60 * 1000;
const FOUND_TTL_MS = 6 * HOUR;
const MISSING_TTL_MS = 10 * 60 * 1000;
const MAX_CACHED = 300;
const MAX_TEXT = 280;

/** In memory only, small and bounded: a chat re-renders its links often. */
const cache = new Map<string, { readonly at: number; readonly value: XPostPreview | null }>();

/** Only a small picture from X's own image host; anything else is left out. */
export function xPreviewImageUrl(raw: string | undefined): string | null {
  if (raw === undefined || !URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "pbs.twimg.com" ||
    url.username ||
    url.password ||
    url.port
  )
    return null;
  url.hash = "";
  if (url.pathname.startsWith("/media/")) url.searchParams.set("name", "small");
  return url.href;
}

export function xPostPreviewFrom(post: Post): XPostPreview {
  const text = (post.text?.trim() || post.article?.title.trim() || "").replace(/\n{3,}/g, "\n\n");
  const media = post.media?.[0];
  const imageUrl = xPreviewImageUrl(
    media === undefined ? undefined : media.type === "photo" ? media.url : media.thumbnailUrl,
  );
  return {
    url: post.url,
    authorName: post.author.name,
    authorHandle: post.author.handle,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1).trimEnd()}…` : text,
    createdAt: post.createdAt ?? null,
    image:
      imageUrl === null || media === undefined
        ? null
        : { url: imageUrl, video: media.type !== "photo" },
  };
}

/**
 * A linked post's card. Free: it reads X's public embed data, the same the
 * `read_x_post` tool uses, never the paid API. Null when the link is not a
 * post or X will not show it.
 */
export const getXPostPreview = (url: string) =>
  Effect.gen(function* () {
    const parsed = parsePostUrl(url);
    if (!parsed) return null;
    const now = yield* Clock.currentTimeMillis;
    const hit = cache.get(parsed.id);
    if (hit && now - hit.at < (hit.value ? FOUND_TTL_MS : MISSING_TTL_MS)) return hit.value;
    const reader = yield* XPostReader.XPostReader;
    const value = yield* reader
      .read({ url, thread: false, includeImages: false })
      .pipe(
        Effect.map(xPostPreviewFrom),
        Effect.catchTags({ XPostReadError: () => Effect.succeed(null) }),
      );
    cache.delete(parsed.id);
    cache.set(parsed.id, { at: now, value });
    if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
    return value;
  }).pipe(Effect.provide(XPostReader.layer));
