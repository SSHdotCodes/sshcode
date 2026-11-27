import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

import type { Post } from "./schema.ts";

const HOSTS = new Set([
  "x.com",
  "twitter.com",
  "fxtwitter.com",
  "vxtwitter.com",
  "fixupx.com",
  "fixvx.com",
]);
export const INVALID_URL =
  "Use an X/Twitter post URL (x.com, twitter.com, fxtwitter.com, vxtwitter.com, fixupx.com or fixvx.com), or a numeric post ID.";

/** Only the extracted numeric id and handle ever enter a fixed endpoint path. */
export function parsePostUrl(input: string): { id: string; handle: string } | undefined {
  const value = input.trim();
  if (/^[1-9]\d{0,24}$/.test(value)) return { id: value, handle: "i" };
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.port ||
      !HOSTS.has(url.hostname.replace(/^(?:www\.|mobile\.)/, ""))
    )
      return;
    const match =
      /^\/(?:([A-Za-z0-9_]{1,15})\/status(?:es)?|i\/web\/status)\/([1-9]\d{0,24})(?:\/(?:photo|video)\/\d+)?\/?$/.exec(
        url.pathname,
      );
    if (match) return { handle: match[1] ?? "i", id: match[2]! };
  } catch {
    /* Invalid input has the same short error as unsupported hosts. */
  }
  return;
}

const record = (value: unknown): Record<string, unknown> =>
  Predicate.isObject(value) ? value : {};
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);
const num = (value: unknown): number | undefined => {
  if (value === null || value === undefined || value === "") return;
  const n = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const iso = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
};
const httpUrl = (value: unknown): string => {
  try {
    const url = new URL(str(value));
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : "";
  } catch {
    return "";
  }
};
const textOf = (value: unknown): string =>
  typeof value === "string" ? value : str(record(value).text);

function expandText(
  text: string,
  entities: Record<string, unknown>,
  media: ReadonlyArray<unknown>,
  id: string,
): string {
  const replacements = [...list(entities.urls), ...list(entities.media), ...media].map(record);
  let expanded = text;
  for (const entity of replacements) {
    const short = str(entity.url);
    const full = httpUrl(entity.expanded_url ?? entity.expanded);
    if (!short || !full || !/^https?:\/\/t\.co\//.test(short)) continue;
    const ownMedia = new RegExp(
      `^https?://(?:www\\.)?(?:x|twitter)\\.com/[^/]+/status/${id}/(?:photo|video)/`,
    ).test(full);
    if (ownMedia && expanded.trimEnd().endsWith(short))
      expanded = expanded.trimEnd().slice(0, -short.length).trimEnd();
    else expanded = expanded.replaceAll(short, full);
  }
  return expanded.trim();
}

export interface NormalizedPost {
  readonly post: Post;
  readonly id: string;
  readonly parentId?: string;
  readonly incomplete: boolean;
}

/** Normalizes only one quote level; reply traversal is owned by the service. */
export function normalizePost(
  value: unknown,
  source: Post["source"],
  expectedId: string,
  quote = false,
): NormalizedPost | undefined {
  const root = record(value);
  const p = source === "fxtwitter" ? record(root.tweet) : root;
  const id = str(p.id_str ?? p.id ?? p.tweetID);
  const user = record(p.user ?? p.author);
  const handle = str(user.screen_name ?? p.user_screen_name);
  if (id !== expectedId || !/^[A-Za-z0-9_]{1,15}$/.test(handle)) return;
  const raw = record(p.raw_text);
  const note = record(p.note_tweet);
  const noteResult = record(note.note_tweet_results);
  const noteData = record(noteResult.result ?? note.result ?? note);
  const entities = record(noteData.entity_set ?? p.entities);
  let text = str(noteData.text ?? p.text ?? raw.text);
  const mediaData = list(p.mediaDetails ?? record(p.media).all ?? p.media_extended ?? p.photos);
  const media: NonNullable<Post["media"]>[number][] = [];
  for (const item of mediaData) {
    const m = record(item);
    const type = str(m.type) || "photo";
    const video = record(m.video_info ?? p.video);
    const variants = list(video.variants ?? m.formats)
      .map(record)
      .filter(
        (v) =>
          str(v.content_type ?? v.type ?? v.format) === "video/mp4" ||
          /\.mp4(?:\?|$)/.test(str(v.url ?? v.src)),
      )
      .sort(
        (a, b) => (num(b.bitrate) ?? num(b.width) ?? 0) - (num(a.bitrate) ?? num(a.width) ?? 0),
      );
    const url = httpUrl(
      type === "photo" || type === "image"
        ? (m.media_url_https ?? m.url)
        : (variants[0]?.url ?? variants[0]?.src ?? m.url),
    );
    if (!url) continue;
    media.push({
      type:
        type === "animated_gif" || type === "gif" ? "gif" : type === "video" ? "video" : "photo",
      url,
      ...(str(m.ext_alt_text ?? m.altText ?? m.alt_text)
        ? { altText: str(m.ext_alt_text ?? m.altText ?? m.alt_text) }
        : {}),
      ...(type !== "photo" && httpUrl(m.thumbnail_url ?? m.thumbnailUrl ?? m.media_url_https)
        ? { thumbnailUrl: httpUrl(m.thumbnail_url ?? m.thumbnailUrl ?? m.media_url_https) }
        : {}),
      ...(num(video.duration_millis ?? m.duration_millis) !== undefined
        ? { durationSeconds: num(video.duration_millis ?? m.duration_millis)! / 1000 }
        : num(m.duration) !== undefined
          ? { durationSeconds: num(m.duration)! }
          : {}),
    });
  }
  // Fx facets include the original URL, avoiding code-point vs UTF-16 offset differences.
  text = expandText(
    text,
    entities,
    [
      ...mediaData,
      ...list(raw.facets).map((f) => {
        const facet = record(f);
        return { url: facet.original, expanded_url: facet.replacement };
      }),
    ],
    id,
  );
  // X's embed endpoint escapes &, < and > as HTML entities, as its API does; fx sends plain text.
  if (source === "syndication") {
    text = text.replace(/&(amp|lt|gt);/gu, (_entity, name: string) =>
      name === "amp" ? "&" : name === "lt" ? "<" : ">",
    );
  }
  const a = record(p.article);
  const content = record(a.content);
  const entitiesInArticle = Array.isArray(content.entityMap)
    ? content.entityMap.map((entry) => record(record(entry).value ?? entry))
    : Object.values(record(content.entityMap)).map(record);
  const markdown = entitiesInArticle
    .filter((entity) => entity.type === "MARKDOWN")
    .map((entity) => str(record(entity.data).markdown))
    .filter(Boolean)
    .join("\n\n");
  const articleText = (
    str(a.text ?? a.content).trim() ||
    markdown ||
    list(content.blocks ?? a.blocks)
      .map((b) => str(record(b).text))
      .filter((text) => text.trim())
      .join("\n\n")
  ).trim();
  const articleBody = articleText || str(a.preview_text).trim();
  const article = str(a.title)
    ? { title: str(a.title), ...(articleBody ? { text: articleBody } : {}) }
    : undefined;
  const q = record(p.quoted_tweet ?? p.quote ?? p.qrt);
  const qid = str(q.id_str ?? q.id ?? q.tweetID);
  const quoted =
    !quote && qid
      ? normalizePost(source === "fxtwitter" ? { tweet: q } : q, source, qid, true)
      : undefined;
  const poll = record(p.poll ?? p.pollData ?? record(p.media).poll);
  const choices = list(poll.choices ?? poll.options)
    .map((c) => {
      const choice = record(c);
      return {
        text: str(choice.label ?? choice.text ?? choice.option ?? choice.name),
        ...(num(choice.count ?? choice.votes) !== undefined
          ? { votes: num(choice.count ?? choice.votes)! }
          : {}),
      };
    })
    .filter((c) => c.text);
  const communityNote = textOf(p.community_note ?? p.communityNote);
  const counts = {
    ...(num(p.favorite_count ?? p.likes) !== undefined
      ? { likes: num(p.favorite_count ?? p.likes)! }
      : {}),
    ...(num(p.retweet_count ?? p.retweets) !== undefined
      ? { reposts: num(p.retweet_count ?? p.retweets)! }
      : {}),
    ...(num(p.conversation_count ?? p.replies) !== undefined
      ? { replies: num(p.conversation_count ?? p.replies)! }
      : {}),
    ...(num(record(p.views).count ?? p.views) !== undefined
      ? { views: num(record(p.views).count ?? p.views)! }
      : {}),
  };
  const createdAt =
    iso(p.created_at ?? p.date) ?? iso((num(p.created_timestamp ?? p.date_epoch) ?? NaN) * 1000);
  const parentId = str(
    p.in_reply_to_status_id_str ??
      p.replying_to_status ??
      p.replyingToID ??
      record(p.parent).id_str,
  );
  const incomplete =
    (source === "syndication" && Boolean(p.note_tweet) && !str(noteData.text)) ||
    (article !== undefined && !articleText) ||
    /(?:…|\.\.\.)\s*(?:https?:\/\/\S+)?$/.test(text);
  return {
    id,
    ...(parentId && /^[1-9]\d{0,24}$/.test(parentId) ? { parentId } : {}),
    incomplete: incomplete || (quoted?.incomplete ?? false),
    post: {
      author: { name: str(user.name ?? p.user_name) || handle, handle },
      ...(createdAt ? { createdAt } : {}),
      ...(text ? { text } : {}),
      ...(media.length ? { media } : {}),
      ...(article ? { article } : {}),
      ...(quoted ? { quoted: quoted.post } : {}),
      ...(choices.length
        ? {
            poll: {
              choices,
              ...(iso(poll.ends_at ?? poll.end_datetime ?? poll.endsAt)
                ? { endsAt: iso(poll.ends_at ?? poll.end_datetime ?? poll.endsAt)! }
                : {}),
              ...(num(poll.total_votes ?? poll.totalVotes) !== undefined
                ? { totalVotes: num(poll.total_votes ?? poll.totalVotes)! }
                : {}),
            },
          }
        : {}),
      ...(communityNote ? { communityNote } : {}),
      ...(Object.keys(counts).length ? { counts } : {}),
      url: `https://x.com/${handle}/status/${id}`,
      source,
    },
  };
}

export function renderPost(post: Post): string {
  const lines = [
    `${post.author.name} (@${post.author.handle})${post.createdAt ? ` · ${post.createdAt}` : ""}`,
    post.text,
  ];
  if (post.article)
    lines.push(
      `Article: ${post.article.title}${post.article.text ? `\n${post.article.text}` : ""}`,
    );
  if (post.quoted) lines.push(`Quoted:\n${renderPost(post.quoted)}`);
  for (const m of post.media ?? [])
    lines.push(`${m.type}: ${m.url}${m.altText ? ` (${m.altText})` : ""}`);
  if (post.poll)
    lines.push(
      `Poll: ${post.poll.choices.map((c) => `${c.text}${c.votes === undefined ? "" : ` (${c.votes})`}`).join("; ")}`,
    );
  if (post.communityNote) lines.push(`Community note: ${post.communityNote}`);
  if (post.counts)
    lines.push(
      Object.entries(post.counts)
        .map(([key, value]) => `${key}: ${value}`)
        .join(" · "),
    );
  return lines.filter(Boolean).join("\n");
}
