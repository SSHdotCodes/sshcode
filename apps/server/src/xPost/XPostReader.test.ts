import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import * as XPostReader from "./XPostReader.ts";
import { XPostInput } from "./schema.ts";
import xPlain from "./fixtures/syndication-plain.json" with { type: "json" };
import fxPlain from "./fixtures/fxtwitter-plain.json" with { type: "json" };
import vxPlain from "./fixtures/vxtwitter-plain.json" with { type: "json" };
import xNote from "./fixtures/syndication-note.json" with { type: "json" };
import fxNote from "./fixtures/fxtwitter-note.json" with { type: "json" };
import xReply from "./fixtures/syndication-reply.json" with { type: "json" };
import fxReply from "./fixtures/fxtwitter-reply.json" with { type: "json" };
import xArticle from "./fixtures/syndication-article.json" with { type: "json" };
import fxArticle from "./fixtures/fxtwitter-article.json" with { type: "json" };
import unavailable from "./fixtures/fxtwitter-unavailable.json" with { type: "json" };

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const json = (value: unknown) =>
  new Response(encodeJson(value), {
    headers: { "content-type": "application/json" },
  });
const read = (fetch: typeof globalThis.fetch, input: typeof XPostInput.Type = { url: "20" }) =>
  Effect.flatMap(XPostReader.XPostReader, (reader) => reader.read(input)).pipe(
    Effect.provide(XPostReader.layer),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
const post = (id: string, parentId?: string) => ({
  ...xPlain,
  id_str: id,
  text: `post ${id}`,
  ...(parentId ? { in_reply_to_status_id_str: parentId } : {}),
});

it.effect("uses the embed first, fixed hosts, a generic agent and no credentials", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => json(xPlain));
    const p = yield* read(fetch, {
      url: "https://fixupx.com/ignored/status/20?key=private#fragment",
    });
    expect(p.source).toBe("syndication");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://cdn.syndication.twimg.com/tweet-result?id=20&token=6dq1a2xwd93&lang=en",
    );
    expect(init).toMatchObject({
      redirect: "error",
      credentials: "omit",
      referrerPolicy: "no-referrer",
      headers: { "user-agent": "Mozilla/5.0" },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(init?.headers).not.toHaveProperty("cookie");
    expect(p).not.toHaveProperty("images");
  }),
);

it.effect("falls back in order on HTTP, invalid JSON, unavailable and wrong-id responses", () =>
  Effect.gen(function* () {
    for (const bad of [
      () => new Response("", { status: 404 }),
      () => new Response("not JSON"),
      () => json(unavailable),
      () => json({ ...xPlain, id_str: "21" }),
    ]) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async () => bad())
        .mockImplementationOnce(async () => json(fxPlain));
      expect((yield* read(fetch)).source).toBe("fxtwitter");
      expect(fetch.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
        "cdn.syndication.twimg.com",
        "api.fxtwitter.com",
      ]);
    }
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValueOnce(new Error("network"))
      .mockImplementationOnce(async () => json(unavailable))
      .mockImplementationOnce(async () => json(vxPlain));
    expect((yield* read(fetch)).source).toBe("vxtwitter");
    expect(fetch.mock.calls.map(([url]) => new URL(String(url)).hostname)).toEqual([
      "cdn.syndication.twimg.com",
      "api.fxtwitter.com",
      "api.vxtwitter.com",
    ]);
  }),
);

it.effect("enriches truncated notes and Articles, preserving first-source fields", () =>
  Effect.gen(function* () {
    for (const [id, embed, mirror] of [
      ["1886192184808149383", xNote, fxNote],
      ["2036334114169823731", xArticle, fxArticle],
    ] as const) {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async () => json(embed))
        .mockImplementationOnce(async () => json(mirror));
      const p = yield* read(fetch, { url: id });
      expect(p.source).toBe("fxtwitter");
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(p.limits).not.toContain("preview");
      if (p.article) expect(p.article.text).toContain("survives.");
      else expect(p.text?.length).toBe(997);
    }
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => json(xArticle))
      .mockImplementation(async () => json(unavailable));
    const preview = yield* read(fetch, { url: "2036334114169823731" });
    expect(preview.article?.text).toContain("The Gap Between");
    expect(preview.limits).toContain("preview");
    expect(fetch).toHaveBeenCalledTimes(3);
  }),
);

it.effect(
  "walks a recorded reply above the main post, oldest first, and can disable traversal",
  () =>
    Effect.gen(function* () {
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async () => json(xReply))
        .mockImplementationOnce(async () => json(fxReply))
        .mockImplementation(async () => json(post("2036836816654147718")));
      const p = yield* read(fetch, { url: "2036841069636370467" });
      expect(p.text).toBe(fxReply.tweet.text);
      expect(p.earlier?.map((p) => p.text)).toEqual(["post 2036836816654147718"]);
      expect(String(fetch.mock.calls[2]?.[0])).toContain("id=2036836816654147718");
      const disabled = vi.fn<typeof globalThis.fetch>(async () => json(post("20", "19")));
      expect(yield* read(disabled, { url: "20", thread: false })).not.toHaveProperty("earlier");
      expect(disabled).toHaveBeenCalledTimes(1);
    }),
);

it.effect(
  "bounds reply walks to 8 hops, detects cycles, and retains the main post on missing parents",
  () =>
    Effect.gen(function* () {
      const chain = vi.fn<typeof globalThis.fetch>(async (url) => {
        const id = new URL(String(url)).searchParams.get("id")!;
        return json(post(id, String(Number(id) - 1)));
      });
      const p = yield* read(chain);
      expect(p.earlier?.map((p) => p.text)).toEqual(
        [12, 13, 14, 15, 16, 17, 18, 19].map((id) => `post ${id}`),
      );
      expect(p.limits).toContain("8 reply hops");
      expect(chain).toHaveBeenCalledTimes(9);
      const cyclic = vi.fn<typeof globalThis.fetch>(async () => json(post("20", "20")));
      expect((yield* read(cyclic)).limits).toContain("cycle");
      expect(cyclic).toHaveBeenCalledTimes(1);
      const missing = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async () => json(post("20", "19")))
        .mockImplementation(async () => json(unavailable));
      expect((yield* read(missing)).text).toBe("post 20");
      expect(missing).toHaveBeenCalledTimes(4);
    }),
);

it.effect("rejects lookalike hosts and credentials before fetching", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>();
    for (const url of [
      "https://x.com.evil.example/a/status/1",
      "https://user:password@x.com/a/status/1",
      "https://user@x.com/a/status/1",
      "https://example.com/a/status/1",
    ]) {
      const error = yield* read(fetch, { url }).pipe(Effect.flip);
      expect(error.reason).toBe("invalid_url");
      expect(error.message).toContain("numeric post ID");
    }
    expect(fetch).not.toHaveBeenCalled();
  }),
);

it.effect("returns an actionable unavailable error without leaking lower-level messages", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => {
      throw new Error("private internal stack");
    });
    const error = yield* read(fetch).pipe(Effect.flip);
    expect(error.message).toBe(
      "X did not return this post; it may be deleted, private or age-restricted.",
    );
    expect(error.message).not.toContain("stack");
    expect(fetch).toHaveBeenCalledTimes(3);
  }),
);

it.effect("rejects redirected responses instead of contacting the location host", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response("redirect", {
          status: 302,
          headers: { location: "https://evil.example/post" },
        }),
    );
    yield* read(fetch).pipe(Effect.flip);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      fetch.mock.calls.every(
        ([url, init]) =>
          new URL(String(url)).hostname !== "evil.example" && init?.redirect === "error",
      ),
    ).toBe(true);
  }),
);

it.effect("enforces declared and streamed JSON size caps and cancels oversized bodies", () =>
  Effect.gen(function* () {
    for (const declared of [true, false]) {
      const cancel = vi.fn();
      const oversized = () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              if (!declared) c.enqueue(new Uint8Array(1024 * 1024 + 1));
            },
            cancel,
          }),
          { headers: declared ? { "content-length": String(1024 * 1024 + 1) } : {} },
        );
      const fetch = vi
        .fn<typeof globalThis.fetch>()
        .mockImplementationOnce(async () => oversized())
        .mockImplementationOnce(async () => json(fxPlain));
      expect((yield* read(fetch)).source).toBe("fxtwitter");
      expect(cancel).toHaveBeenCalledTimes(1);
    }
  }),
);

const photos = Array.from({ length: 5 }, (_, n) => ({
  type: "photo",
  media_url_https: `https://pbs.twimg.com/media/photo${n}.jpg?name=orig`,
}));
it.effect("returns no images by default, at most four small photos when requested", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) =>
      String(url).includes("pbs.twimg.com")
        ? new Response(new Uint8Array([1, 2]), { headers: { "content-type": "image/jpeg" } })
        : json({ ...xPlain, mediaDetails: photos }),
    );
    expect(yield* read(fetch)).not.toHaveProperty("images");
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockClear();
    const p = yield* read(fetch, { url: "20", includeImages: true });
    expect(p.images).toHaveLength(4);
    expect(p.images?.[0]).toEqual({ data: "AQI=", mimeType: "image/jpeg" });
    expect(fetch.mock.calls.slice(1).map(([url]) => String(url))).toEqual(
      photos.slice(0, 4).map((_, n) => `https://pbs.twimg.com/media/photo${n}.jpg?name=small`),
    );
  }),
);

it.effect("only fetches photos on pbs.twimg.com and caps each image at 4 MB", () =>
  Effect.gen(function* () {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () =>
        json({
          ...xPlain,
          mediaDetails: [
            ...photos.slice(0, 1),
            { type: "photo", media_url_https: "https://pbs.twimg.com.evil.example/media/a.jpg" },
            { type: "photo", media_url_https: "https://pbs.twimg.com/profile_images/a.jpg" },
          ],
        }),
      )
      .mockImplementation(
        async () =>
          new Response(new Uint8Array(4 * 1024 * 1024 + 1), {
            headers: { "content-type": "image/jpeg" },
          }),
      );
    const p = yield* read(fetch, { url: "20", includeImages: true });
    expect(p).not.toHaveProperty("images");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(p.limits).toContain("size limits");
    expect(p.limits).toContain("image host");
  }),
);

it.effect("skips a photo whose link does not parse instead of failing the read", () =>
  Effect.gen(function* () {
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(async () =>
      json({
        ...xPlain,
        mediaDetails: [{ type: "photo", media_url_https: "not a url" }],
      }),
    );
    const p = yield* read(fetch, { url: "20", includeImages: true });
    expect(p.text).toBe(xPlain.text);
    expect(p).not.toHaveProperty("images");
    expect(fetch).toHaveBeenCalledTimes(1);
  }),
);

it.effect("times out requests at 8 seconds and aborts their fetch signals", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    let signal: AbortSignal | undefined;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce((_url, init) => {
        signal = init?.signal ?? undefined;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          Deferred.doneUnsafe(started, Effect.void);
        });
      })
      .mockImplementation(async () => json(fxPlain));
    const fiber = yield* read(fetch).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust("8 seconds");
    expect((yield* Fiber.join(fiber)).source).toBe("fxtwitter");
    expect(signal?.aborted).toBe(true);
  }),
);

it.effect("caps the whole call at 25 seconds and returns already-read text", () =>
  Effect.gen(function* () {
    const waiting = yield* Deferred.make<void>();
    const signals: AbortSignal[] = [];
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => json({ ...post("20", "19"), note_tweet: { id: "note" } }))
      .mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            if (init?.signal) {
              signals.push(init.signal);
              init.signal.addEventListener("abort", () => reject(new Error("aborted")), {
                once: true,
              });
            }
            Deferred.doneUnsafe(waiting, Effect.void);
          }),
      );
    const fiber = yield* read(fetch).pipe(Effect.forkChild);
    yield* Deferred.await(waiting);
    yield* TestClock.adjust("25 seconds");
    const p = yield* Fiber.join(fiber);
    expect(p.text).toBe("post 20");
    expect(p.limits).toContain("time limit");
    expect(signals.every((s) => s.aborted)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(5);
  }),
);

it.effect("tries the last fallback when a mirror omits a known Article", () =>
  Effect.gen(function* () {
    const id = "2036334114169823731";
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockImplementationOnce(async () => json(xArticle))
      .mockImplementationOnce(async () =>
        json({ tweet: { ...fxPlain.tweet, id, text: "Article link" } }),
      )
      .mockImplementationOnce(async () => json(unavailable));
    const p = yield* read(fetch, { url: id });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(p.article?.title).toBe(xArticle.article.title);
    expect(p.limits).toContain("preview");
  }),
);
