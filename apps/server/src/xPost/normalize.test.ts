import { describe, expect, it } from "vite-plus/test";

import fxQuote from "./fixtures/fxtwitter-quote.json" with { type: "json" };
import xQuote from "./fixtures/syndication-quote.json" with { type: "json" };
import fxPlain from "./fixtures/fxtwitter-plain.json" with { type: "json" };
import vxPlain from "./fixtures/vxtwitter-plain.json" with { type: "json" };
import xPlain from "./fixtures/syndication-plain.json" with { type: "json" };
import xMedia from "./fixtures/syndication-media.json" with { type: "json" };
import fxMedia from "./fixtures/fxtwitter-media.json" with { type: "json" };
import xNote from "./fixtures/syndication-note.json" with { type: "json" };
import fxNote from "./fixtures/fxtwitter-note.json" with { type: "json" };
import xArticle from "./fixtures/syndication-article.json" with { type: "json" };
import fxArticle from "./fixtures/fxtwitter-article.json" with { type: "json" };
import unavailable from "./fixtures/fxtwitter-unavailable.json" with { type: "json" };
import { normalizePost, parsePostUrl, renderPost } from "./normalize.ts";

const accepted = [
  "20",
  "x.com/jack/status/20",
  "https://x.com/jack/status/20",
  "https://twitter.com/jack/statuses/20",
  "https://mobile.twitter.com/jack/status/20?s=20#text",
  "https://www.x.com/jack/status/20/photo/1",
  "https://mobile.x.com/i/web/status/20/video/1",
  "https://x.com/i/status/20",
  "https://x.com/i/web/status/20",
  "https://fxtwitter.com/jack/status/20",
  "https://vxtwitter.com/jack/status/20",
  "https://fixupx.com/jack/status/20",
  "https://fixvx.com/jack/status/20",
  "http://www.twitter.com/jack/status/20/",
  " https://X.COM/jack/status/20 ",
];
const rejected = [
  "",
  "0",
  "-20",
  "1.5",
  "hello",
  "https://x.com/jack",
  "https://example.com/jack/status/20",
  "https://x.com.evil.example/a/status/1",
  "https://evil.x.com/a/status/1",
  "https://x.com@evil.example/a/status/1",
  "https://user:secret@x.com/a/status/1",
  "https://user@x.com/a/status/1",
  "https://x.com:444/a/status/1",
  "ftp://x.com/a/status/1",
  "https://x.com/a/status/1/other",
  "https://x.com/a/status/nope",
  "https://x.com/a/status/0",
  "https://x.com/a%2fb/status/20",
  "https://x.com/a/status/20/../../b/status/1",
  "https://x.com/a/status/20\\@evil.example",
  "https://x.com/i/web/status/20/likes",
  "https://x.com/a/status/99999999999999999999999999999999999",
];

describe("post URL parsing", () => {
  it.each(accepted)("accepts %s", (url) => expect(parsePostUrl(url)?.id).toBe("20"));
  it.each(rejected)("rejects %s", (url) => expect(parsePostUrl(url)).toBeUndefined());
});

describe("recorded response normalization (2026-11-10, trimmed)", () => {
  it.each([
    ["syndication", xPlain],
    ["fxtwitter", fxPlain],
    ["vxtwitter", vxPlain],
  ] as const)("reads a plain post from %s", (source, fixture) => {
    expect(normalizePost(fixture, source, "20")?.post).toEqual({
      author: { name: "jack", handle: "jack" },
      createdAt: "2006-03-21T20:50:14.000Z",
      text: "just setting up my twttr",
      url: "https://x.com/jack/status/20",
      source,
      counts:
        source === "syndication"
          ? { likes: 324915, replies: 19256 }
          : source === "fxtwitter"
            ? { likes: 324915, reposts: 126452, replies: 19256 }
            : { likes: 314191, reposts: 125068, replies: 18433 },
    });
  });
  it.each([
    ["syndication", xMedia],
    ["fxtwitter", fxMedia],
  ] as const)("reads photos, alt text and the best mp4 from %s", (source, fixture) => {
    const p = normalizePost(fixture, source, "1950583566947213444")!.post;
    expect(p.media?.map((m) => m.type)).toEqual(["photo", "video", "photo"]);
    expect(p.media?.[0]?.altText).toContain("NISAR team members");
    expect(p.media?.[1]).toMatchObject({ type: "video", durationSeconds: 66.594 });
    expect(p.media?.[1]?.url).toContain("1280x720");
    expect(p.text).toContain("http://go.nasa.gov/3U5mf9i");
    expect(p.text).not.toContain("t.co");
    expect(p.text).not.toContain("/video/1");
  });
  it("detects a note-only id in the embed; the mirror returns the full note", () => {
    expect(normalizePost(xNote, "syndication", "1886192184808149383")?.incomplete).toBe(true);
    const note = normalizePost(fxNote, "fxtwitter", "1886192184808149383")!;
    expect(note.incomplete).toBe(false);
    expect(note.post.text?.length).toBe(997);
    expect(note.post.text).toContain("It's not too bad for throwaway weekend projects");
  });
  it("detects Article previews and reads content blocks from the mirror", () => {
    expect(normalizePost(xArticle, "syndication", "2036334114169823731")?.incomplete).toBe(true);
    const p = normalizePost(fxArticle, "fxtwitter", "2036334114169823731")!;
    expect(p.incomplete).toBe(false);
    expect(p.post.article?.text).toContain("The Gap Between");
    expect(p.post.article?.text).toContain("survives.");
    expect(renderPost(p.post)).toContain("Article:");
  });
  it("rejects unavailable, malformed, and wrong-id payloads", () => {
    expect(normalizePost(unavailable, "fxtwitter", "20")).toBeUndefined();
    expect(normalizePost({}, "syndication", "20")).toBeUndefined();
    expect(normalizePost(xPlain, "syndication", "21")).toBeUndefined();
  });
  it("handles one quote level, polls, notes, gifs and entity expansion without following links", () => {
    const inner = { ...xPlain, id_str: "21", text: "inner" };
    const post = normalizePost(
      {
        ...xPlain,
        text: "read https://t.co/a https://t.co/b",
        entities: {
          urls: [{ url: "https://t.co/a", expanded_url: "https://example.com/story" }],
          media: [{ url: "https://t.co/b", expanded_url: "https://x.com/jack/status/20/photo/1" }],
        },
        quoted_tweet: { ...inner, quoted_tweet: inner },
        mediaDetails: [
          {
            type: "animated_gif",
            video_info: {
              variants: [{ content_type: "video/mp4", url: "https://video.twimg.com/anim.mp4" }],
            },
          },
        ],
        poll: {
          choices: [
            { label: "yes", count: 4 },
            { label: "no", count: 2 },
          ],
          total_votes: 6,
        },
        community_note: { text: "Context" },
      },
      "syndication",
      "20",
    )!.post;
    expect(post.text).toBe("read https://example.com/story");
    expect(post.quoted?.text).toBe("inner");
    expect(post.quoted).not.toHaveProperty("quoted");
    expect(post.media?.[0]?.type).toBe("gif");
    expect(post.poll).toEqual({
      choices: [
        { text: "yes", votes: 4 },
        { text: "no", votes: 2 },
      ],
      totalVotes: 6,
    });
    expect(post.communityNote).toBe("Context");
    expect(renderPost(post)).toContain("Quoted:\njack (@jack)");
  });
});

it("reads a recorded quoted post and detects the embed's note preview", () => {
  expect(normalizePost(xQuote, "syndication", "1769826435576037702")?.incomplete).toBe(true);
  const p = normalizePost(fxQuote, "fxtwitter", "1769826435576037702")!;
  expect(p.incomplete).toBe(false);
  expect(p.post.quoted?.author.handle).toBe("XNews");
  expect(p.post.quoted?.text).toContain("X is indispensable");
  expect(p.post.quoted?.text).not.toContain("t.co");
});

it("reads mirror poll options and markdown-backed Articles", () => {
  const vx = normalizePost(
    {
      ...vxPlain,
      pollData: {
        options: [
          { name: "yes", votes: 4 },
          { name: "no", votes: 2 },
        ],
      },
    },
    "vxtwitter",
    "20",
  )!.post;
  expect(vx.poll?.choices).toEqual([
    { text: "yes", votes: 4 },
    { text: "no", votes: 2 },
  ]);
  const fx = normalizePost(
    {
      tweet: {
        ...fxPlain.tweet,
        article: {
          title: "Markdown article",
          content: {
            blocks: [{ text: " " }],
            entityMap: [
              { key: 0, value: { type: "MARKDOWN", data: { markdown: "Full article body" } } },
            ],
          },
        },
        poll: { choices: [{ label: "yes", count: 4 }], ends_at: "2026-11-11T10:00:00Z" },
      },
    },
    "fxtwitter",
    "20",
  )!.post;
  expect(fx.article?.text).toBe("Full article body");
  expect(fx.poll?.endsAt).toBe("2026-11-11T10:00:00.000Z");
});

it("omits empty post and Article text fields", () => {
  const article = normalizePost(fxArticle, "fxtwitter", "2036334114169823731")!.post;
  expect(article).not.toHaveProperty("text");
  expect(renderPost(article)).not.toContain("undefined");
  const preview = normalizePost(
    { ...xPlain, text: "", article: { title: "Unavailable body" } },
    "syndication",
    "20",
  )!;
  expect(preview.incomplete).toBe(true);
  expect(preview.post.article).toEqual({ title: "Unavailable body" });
  expect(preview.post).not.toHaveProperty("text");
});
