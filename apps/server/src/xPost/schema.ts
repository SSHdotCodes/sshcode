import * as Schema from "effect/Schema";

export const XPostInput = Schema.Struct({
  url: Schema.String,
  includeImages: Schema.optional(Schema.Boolean),
  thread: Schema.optional(Schema.Boolean),
});

const Media = Schema.Struct({
  type: Schema.Literals(["photo", "video", "gif"]),
  url: Schema.String,
  altText: Schema.optional(Schema.String),
  thumbnailUrl: Schema.optional(Schema.String),
  durationSeconds: Schema.optional(Schema.Number),
});

const PostFields = {
  author: Schema.Struct({ name: Schema.String, handle: Schema.String }),
  createdAt: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  media: Schema.optional(Schema.Array(Media)),
  article: Schema.optional(
    Schema.Struct({ title: Schema.String, text: Schema.optional(Schema.String) }),
  ),
  poll: Schema.optional(
    Schema.Struct({
      choices: Schema.Array(
        Schema.Struct({ text: Schema.String, votes: Schema.optional(Schema.Number) }),
      ),
      endsAt: Schema.optional(Schema.String),
      totalVotes: Schema.optional(Schema.Number),
    }),
  ),
  communityNote: Schema.optional(Schema.String),
  counts: Schema.optional(
    Schema.Struct({
      likes: Schema.optional(Schema.Number),
      reposts: Schema.optional(Schema.Number),
      replies: Schema.optional(Schema.Number),
      views: Schema.optional(Schema.Number),
    }),
  ),
  url: Schema.String,
  source: Schema.Literals(["syndication", "fxtwitter", "vxtwitter"]),
};
const Quoted = Schema.Struct(PostFields);
export const Post = Schema.Struct({ ...PostFields, quoted: Schema.optional(Quoted) });
const XPostResult = Schema.Struct({
  ...Post.fields,
  earlier: Schema.optional(Schema.Array(Post)),
  limits: Schema.String,
});
export const XPostReadResult = Schema.Struct({
  ...XPostResult.fields,
  images: Schema.optional(
    Schema.Array(Schema.Struct({ data: Schema.String, mimeType: Schema.String })),
  ),
});
export type Post = typeof Post.Type;

/**
 * What the tool advertises and returns. The post is rendered once as text: the structured
 * post repeats its fields four times over (quoted, earlier, earlier's quoted), which cost
 * every agent 7.7 KB of output schema and sent each post twice.
 */
export const XPostToolResult = Schema.Struct({
  url: Schema.String,
  post: Schema.String.annotate({
    description:
      "Earlier posts, then the post: author, text, quoted post, media links, counts and what could not be read.",
  }),
  images: Schema.optional(
    Schema.Array(Schema.Struct({ data: Schema.String, mimeType: Schema.String })).annotate({
      description: "Returned as image content instead.",
    }),
  ),
});

export const XSearchToolResult = Schema.Struct({
  posts: Schema.String,
});
