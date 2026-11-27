import * as Schema from "effect/Schema";
import { NodeId, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TeamBoardMessage = TrimmedNonEmptyString.check(Schema.isMaxLength(280));

const TeamBoardAuthor = Schema.Struct({
  name: Schema.String,
  taskId: Schema.optionalKey(NodeId),
  user: Schema.optionalKey(Schema.Boolean),
});

export const TeamBoardPost = Schema.Struct({
  id: Schema.String,
  author: TeamBoardAuthor,
  kind: Schema.String,
  text: Schema.String,
  at: Schema.DateTimeUtc,
  files: Schema.optionalKey(Schema.Array(Schema.String)),
  to: Schema.optionalKey(Schema.String),
  replyTo: Schema.optionalKey(Schema.String),
  commit: Schema.optionalKey(Schema.String),
  pinned: Schema.optionalKey(Schema.Boolean),
  conflict: Schema.optionalKey(Schema.Struct({ file: Schema.String, owner: TeamBoardAuthor })),
});
export type TeamBoardPost = typeof TeamBoardPost.Type;

export const TeamBoardFile = Schema.Struct({
  path: Schema.String,
  agents: Schema.Array(
    Schema.Struct({
      author: TeamBoardAuthor,
      claims: Schema.optionalKey(Schema.Array(Schema.String)),
      ranges: Schema.optionalKey(
        Schema.Array(Schema.Struct({ start: NonNegativeInt, end: NonNegativeInt })),
      ),
      stale: Schema.optionalKey(Schema.Boolean),
    }),
  ),
  willConflict: Schema.optionalKey(Schema.Boolean),
});
export type TeamBoardFile = typeof TeamBoardFile.Type;

export const TeamBoardPush = Schema.Struct({
  id: Schema.String,
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.DateTimeUtc,
  members: Schema.Array(Schema.String),
  postCount: Schema.optionalKey(NonNegativeInt),
  overlapCount: Schema.optionalKey(NonNegativeInt),
});
export type TeamBoardPush = typeof TeamBoardPush.Type;

export const TeamBoardSnapshot = Schema.Struct({
  active: Schema.Boolean,
  postCount: NonNegativeInt,
  overlapCount: NonNegativeInt,
  latestPostId: Schema.optionalKey(Schema.String),
  presence: Schema.Array(Schema.Struct({ taskId: NodeId, files: Schema.Array(Schema.String) })),
  posts: Schema.optionalKey(Schema.Array(TeamBoardPost)),
  files: Schema.optionalKey(Schema.Array(TeamBoardFile)),
  pushId: Schema.optionalKey(Schema.String),
  /** Live repository choices when a lead has more than one board. The id selects its push. */
  repos: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  ),
  history: Schema.optionalKey(Schema.Array(TeamBoardPush)),
  historyHasMore: Schema.optionalKey(Schema.Boolean),
  /** An incremental frame uses the preceding frame of this subscription as its cursor. */
  delta: Schema.optionalKey(Schema.Boolean),
  removedPostIds: Schema.optionalKey(Schema.Array(Schema.String)),
});
export type TeamBoardSnapshot = typeof TeamBoardSnapshot.Type;

export const TeamBoardSubscribeInput = Schema.Struct({
  threadId: ThreadId,
  details: Schema.optionalKey(Schema.Boolean),
  pushId: Schema.optionalKey(Schema.String),
  /** Get the next history page after this archived push. */
  historyBefore: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  /** A fresh subscription starts with a complete snapshot, then sends incremental frames. */
  delta: Schema.optionalKey(Schema.Boolean),
  presenceOnly: Schema.optionalKey(Schema.Boolean),
});
export type TeamBoardSubscribeInput = typeof TeamBoardSubscribeInput.Type;

export const TeamBoardPostInput = Schema.Struct({
  threadId: ThreadId,
  text: TeamBoardMessage,
  /** Select the live repository's push by id. */
  repo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
  replyTo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  decision: Schema.optionalKey(Schema.Boolean),
  clientRequestId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});
export type TeamBoardPostInput = typeof TeamBoardPostInput.Type;

export class TeamBoardError extends Schema.TaggedError<TeamBoardError>()("TeamBoardError", {
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}
