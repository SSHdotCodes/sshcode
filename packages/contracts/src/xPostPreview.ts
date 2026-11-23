import * as Schema from "effect/Schema";

/** What a chat shows for a linked X post: display only, never sent to an agent. */
export const XPostPreview = Schema.Struct({
  url: Schema.String,
  authorName: Schema.String,
  authorHandle: Schema.String,
  text: Schema.String,
  createdAt: Schema.NullOr(Schema.String),
  /** From X's own image host. `video` marks a video's still picture. */
  image: Schema.NullOr(Schema.Struct({ url: Schema.String, video: Schema.Boolean })),
});
export type XPostPreview = typeof XPostPreview.Type;
