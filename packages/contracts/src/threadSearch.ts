import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
  TrimmedString,
} from "./baseSchemas.ts";

export const OrchestrationThreadSearchSource = Schema.Literals(["user", "assistant"]);
export type OrchestrationThreadSearchSource = typeof OrchestrationThreadSearchSource.Type;

const MessageSearchPosition = Schema.Struct({
  before: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  skip: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 511 }))),
});
const NameSearchPosition = Schema.Struct({
  score: Schema.Int,
  archived: Schema.Int,
  updatedAt: Schema.String.check(Schema.isMaxLength(32)),
  threadId: ThreadId,
});
const ThreadSearchCursor = Schema.Struct({
  names: Schema.optionalKey(NameSearchPosition),
  exact: Schema.optionalKey(MessageSearchPosition),
  words: Schema.optionalKey(MessageSearchPosition),
  fragments: Schema.optionalKey(MessageSearchPosition),
  corrections: Schema.optionalKey(Schema.NullOr(NameSearchPosition)),
});

// Bound input and payload size for remote clients as well as local search.
export const OrchestrationSearchThreadsInput = Schema.Struct({
  query: TrimmedString.check(Schema.isMinLength(2), Schema.isMaxLength(200)),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  mode: Schema.optionalKey(Schema.Literals(["keyword", "hybrid"])),
  cursor: Schema.optionalKey(ThreadSearchCursor),
});
export type OrchestrationSearchThreadsInput = typeof OrchestrationSearchThreadsInput.Type;

export const OrchestrationThreadSearchMatch = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  snippet: Schema.String.check(Schema.isMaxLength(240)),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
  messageId: Schema.optionalKey(Schema.NullOr(MessageId)),
  title: Schema.optionalKey(Schema.String),
  archived: Schema.optionalKey(Schema.Boolean),
  matchedModel: Schema.optionalKey(Schema.String),
  matchedHarness: Schema.optionalKey(Schema.String),
  titleCorrection: Schema.optionalKey(Schema.String),
  /** Last chat activity, independent of the timestamp on the excerpt. */
  activityAt: Schema.optionalKey(IsoDateTime),
  /** The title, workspace context or opening user message matched. */
  about: Schema.optionalKey(Schema.Boolean),
});
export type OrchestrationThreadSearchMatch = typeof OrchestrationThreadSearchMatch.Type;

export const ThreadSearchStatus = Schema.Struct({
  indexedMessages: Schema.Number,
  totalMessages: Schema.Number,
  embeddedChunks: Schema.Number,
  totalChunks: Schema.Number,
  model: Schema.String,
  modelStatus: Schema.Literals(["checking", "ready", "unavailable"]),
  paused: Schema.Boolean,
});
export type ThreadSearchStatus = typeof ThreadSearchStatus.Type;

export const OrchestrationSearchThreadsResult = Schema.Struct({
  matches: Schema.Array(OrchestrationThreadSearchMatch),
  status: Schema.optionalKey(ThreadSearchStatus),
  complete: Schema.optionalKey(Schema.Boolean),
  nextCursor: Schema.optionalKey(ThreadSearchCursor),
});
export type OrchestrationSearchThreadsResult = typeof OrchestrationSearchThreadsResult.Type;

export class OrchestrationSearchThreadsError extends Schema.TaggedError<OrchestrationSearchThreadsError>()(
  "OrchestrationSearchThreadsError",
  {
    message: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
