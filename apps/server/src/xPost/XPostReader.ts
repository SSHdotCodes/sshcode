import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { FetchHttpClient } from "effect/http";

import { INVALID_URL, normalizePost, parsePostUrl, type NormalizedPost } from "./normalize.ts";
import { type Post, XPostInput, XPostReadResult } from "./schema.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const UNAVAILABLE = "X did not return this post; it may be deleted, private or age-restricted.";

export class XPostReadError extends Schema.TaggedError<XPostReadError>()("XPostReadError", {
  reason: Schema.Literals(["invalid_url", "unavailable", "timeout"]),
}) {
  override get message(): string {
    return this.reason === "invalid_url"
      ? INVALID_URL
      : this.reason === "timeout"
        ? "Reading this X post timed out. Try again."
        : UNAVAILABLE;
  }
}
class XPostRequestError extends Schema.TaggedError<XPostRequestError>()("XPostRequestError", {
  cause: Schema.Defect(),
}) {}

export class XPostReader extends Context.Service<
  XPostReader,
  {
    readonly read: (
      input: typeof XPostInput.Type,
    ) => Effect.Effect<typeof XPostReadResult.Type, XPostReadError>;
  }
>()("t3/xPost/XPostReader") {}

const make = Effect.gen(function* () {
  const fetch = yield* FetchHttpClient.Fetch;

  /** Fetch and consume under one timeout; redirects are refused before another host is contacted. */
  const request = (url: string, image = false) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await fetch(url, {
          signal,
          redirect: "error",
          credentials: "omit",
          referrerPolicy: "no-referrer",
          headers: { "user-agent": "Mozilla/5.0", accept: image ? "image/*" : "application/json" },
        });
        const cap = image ? 4 * 1024 * 1024 : 1024 * 1024;
        const reader = response.body?.getReader();
        if (!reader) throw new Error("Empty response");
        try {
          if (!response.ok || Number(response.headers.get("content-length")) > cap)
            throw new Error("Unavailable or oversized response");
          const chunks: Uint8Array[] = [];
          let size = 0;
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > cap) throw new Error("Response too large");
            chunks.push(chunk.value);
          }
          const bytes = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return {
            bytes,
            mimeType: response.headers.get("content-type")?.split(";")[0]?.trim() ?? "",
          };
        } finally {
          await reader.cancel().catch(() => undefined);
          reader.releaseLock();
        }
      },
      catch: (cause) => new XPostRequestError({ cause }),
    }).pipe(
      Effect.timeout("8 seconds"),
      Effect.catchTags({
        XPostRequestError: () => Effect.succeed(undefined),
        TimeoutError: () => Effect.succeed(undefined),
      }),
    );

  const load = (id: string, handle: string, deadline: number) =>
    Effect.gen(function* () {
      let best: NormalizedPost | undefined;
      const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, "");
      const sources = [
        [
          "syndication",
          `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`,
        ],
        ["fxtwitter", `https://api.fxtwitter.com/${handle}/status/${id}`],
        ["vxtwitter", `https://api.vxtwitter.com/${handle}/status/${id}`],
      ] as const;
      for (const [source, url] of sources) {
        const remaining = deadline - (yield* Clock.currentTimeMillis);
        if (remaining <= 0) break;
        const response = yield* request(url).pipe(
          Effect.timeoutOrElse({ duration: remaining, orElse: () => Effect.succeed(undefined) }),
        );
        if (!response) continue;
        const value = decodeJson(new TextDecoder().decode(response.bytes));
        if (Option.isNone(value)) continue;
        const normalized = normalizePost(value.value, source, id);
        if (!normalized) continue;
        // A mirror without Article data cannot complete an embed's Article preview.
        const incomplete =
          normalized.incomplete || Boolean(best?.post.article && !normalized.post.article);
        // Retain useful fields from the embed when a mirror supplies missing long text/counts.
        const candidate = best
          ? {
              ...normalized,
              incomplete,
              ...((normalized.parentId ?? best.parentId)
                ? { parentId: normalized.parentId ?? best.parentId }
                : {}),
              post: {
                ...best.post,
                ...normalized.post,
                ...(best.post.counts || normalized.post.counts
                  ? { counts: { ...best.post.counts, ...normalized.post.counts } }
                  : {}),
              },
            }
          : normalized;
        if (
          !best ||
          !candidate.incomplete ||
          (normalized.post.text?.length ?? 0) > (best.post.text?.length ?? 0) ||
          (normalized.post.article?.text?.length ?? 0) > (best.post.article?.text?.length ?? 0)
        )
          best = candidate;
        if (!candidate.incomplete) break;
      }
      return best;
    });

  const read: XPostReader["Service"]["read"] = Effect.fn("XPostReader.read")(function* (input) {
    const parsed = parsePostUrl(input.url);
    if (!parsed) return yield* Effect.fail(new XPostReadError({ reason: "invalid_url" }));
    const deadline = (yield* Clock.currentTimeMillis) + 25_000;
    const main = yield* load(parsed.id, parsed.handle, deadline);
    if (!main)
      return yield* Effect.fail(
        new XPostReadError({
          reason: (yield* Clock.currentTimeMillis) >= deadline ? "timeout" : "unavailable",
        }),
      );
    const limits = ["Replies and later posts in the thread are not available."];
    if (main.incomplete) limits.push("Only a preview of some text or an Article was available.");
    const earlier: Post[] = [];
    let parentId = main.parentId;
    const seen = new Set([main.id]);
    if (input.thread !== false) {
      for (let hop = 0; parentId && hop < 8; hop++) {
        if (seen.has(parentId)) {
          limits.push("The reply chain contained a cycle.");
          break;
        }
        seen.add(parentId);
        const parent = yield* load(parentId, "i", deadline);
        if (!parent) {
          limits.push("Some earlier posts could not be read within the time limit.");
          break;
        }
        earlier.unshift(parent.post);
        if (parent.incomplete) limits.push("An earlier post was only available as a preview.");
        parentId = parent.parentId;
      }
      if (parentId && earlier.length === 8)
        limits.push("Earlier posts are limited to 8 reply hops.");
    }
    const images: { data: string; mimeType: string }[] = [];
    if (input.includeImages) {
      const photos = (main.post.media ?? []).filter((m) => m.type === "photo").slice(0, 4);
      for (const photo of photos) {
        // A mirror's media link is not ours to trust: one that does not parse is skipped.
        const url = URL.canParse(photo.url) ? new URL(photo.url) : undefined;
        if (
          url === undefined ||
          url.protocol !== "https:" ||
          url.hostname !== "pbs.twimg.com" ||
          url.username ||
          url.password ||
          url.port ||
          !url.pathname.startsWith("/media/")
        ) {
          limits.push("A photo was not available from X's image host.");
          continue;
        }
        url.searchParams.set("name", "small");
        url.hash = "";
        const remaining = deadline - (yield* Clock.currentTimeMillis);
        const response =
          remaining > 0
            ? yield* request(url.href, true).pipe(
                Effect.timeoutOrElse({
                  duration: remaining,
                  orElse: () => Effect.succeed(undefined),
                }),
              )
            : undefined;
        if (
          !response ||
          !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(response.mimeType)
        ) {
          limits.push("A photo could not be read within the time and size limits.");
          continue;
        }
        images.push({
          data: Buffer.from(response.bytes).toString("base64"),
          mimeType: response.mimeType,
        });
      }
    }
    return {
      ...main.post,
      ...(earlier.length ? { earlier } : {}),
      limits: `${[...new Set(limits)].map((line) => line.replace(/\.$/, "")).join("; ")}.`,
      ...(images.length ? { images } : {}),
    };
  });
  return XPostReader.of({ read });
});

export const layer = Layer.effect(XPostReader, make);
