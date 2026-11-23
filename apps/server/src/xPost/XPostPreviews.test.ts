import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import { getXPostPreview, xPostPreviewFrom, xPreviewImageUrl } from "./XPostPreviews.ts";
import xPlain from "./fixtures/syndication-plain.json" with { type: "json" };
import xMedia from "./fixtures/syndication-media.json" with { type: "json" };
import unavailable from "./fixtures/fxtwitter-unavailable.json" with { type: "json" };

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const json = (value: unknown) =>
  new Response(encodeJson(value), { headers: { "content-type": "application/json" } });
const preview = (fetch: typeof globalThis.fetch, url: string) =>
  getXPostPreview(url).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));

it("only takes a small picture from X's own image host", () => {
  expect(xPreviewImageUrl("https://pbs.twimg.com/media/abc.jpg")).toBe(
    "https://pbs.twimg.com/media/abc.jpg?name=small",
  );
  expect(xPreviewImageUrl("https://pbs.twimg.com/media/abc?format=jpg&name=large#x")).toBe(
    "https://pbs.twimg.com/media/abc?format=jpg&name=small",
  );
  expect(xPreviewImageUrl("https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg")).toBe(
    "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg",
  );
  for (const url of [
    undefined,
    "not a url",
    "http://pbs.twimg.com/media/abc.jpg",
    "https://pbs.twimg.com.evil.io/media/abc.jpg",
    "https://user:pass@pbs.twimg.com/media/abc.jpg",
    "https://pbs.twimg.com:8443/media/abc.jpg",
    "https://example.com/a.jpg",
  ])
    expect(xPreviewImageUrl(url)).toBeNull();
});

it("keeps a card short and uses a video's still picture", () => {
  const card = xPostPreviewFrom({
    author: { name: "Someone", handle: "someone" },
    text: `${"word ".repeat(100)}\n\n\n\nend`,
    media: [
      {
        type: "video",
        url: "https://video.twimg.com/a.mp4",
        thumbnailUrl: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg",
      },
    ],
    url: "https://x.com/someone/status/1",
    source: "syndication",
  });
  expect(card.text.length).toBeLessThanOrEqual(280);
  expect(card.text.endsWith("…")).toBe(true);
  expect(card.image).toEqual({
    url: "https://pbs.twimg.com/ext_tw_video_thumb/1/pu/img/a.jpg",
    video: true,
  });
  expect(card.createdAt).toBeNull();
});

it.effect("reads a post once and remembers it", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      json({ ...xPlain, id_str: "880001", text: "hello from the card" }),
    );
    const first = yield* preview(fetch, "https://x.com/someone/status/880001?s=46");
    expect(first).toMatchObject({ text: "hello from the card", image: null });
    expect(first?.authorHandle).toBe(xPlain.user.screen_name);
    expect(yield* preview(fetch, "https://twitter.com/i/web/status/880001")).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  }),
);

it.effect("shows a picture post's picture", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(xMedia));
    const card = yield* preview(fetch, `https://x.com/a/status/${xMedia.id_str}`);
    expect(card?.image?.url).toMatch(/^https:\/\/pbs\.twimg\.com\//);
  }),
);

it.effect("gives nothing for other links or posts X will not show", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(unavailable));
    expect(yield* preview(fetch, "https://example.com/a/status/880002")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(yield* preview(fetch, "https://x.com/a/status/880003")).toBeNull();
    const calls = fetch.mock.calls.length;
    expect(calls).toBeGreaterThan(0);
    // The miss is remembered for a while too.
    expect(yield* preview(fetch, "https://x.com/a/status/880003")).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(calls);
  }),
);
