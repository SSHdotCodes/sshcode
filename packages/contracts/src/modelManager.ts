import * as Schema from "effect/Schema";

import { RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Reserved since the first Models helper shipped, including saved state.json threads. */
export const MODEL_MANAGER_THREAD_ID_PREFIX = "models:";

export function isModelManagerThreadId(threadId: string): boolean {
  return threadId.startsWith(MODEL_MANAGER_THREAD_ID_PREFIX);
}

/**
 * Add or remove a model in one of the user's harnesses: "https://openrouter.ai/tencent/hy4",
 * "tencent/hy4", or "remove hy4". An agent in the Models chat edits the harness's own
 * config, checks the model loads, and the server then refreshes the harness's model list.
 */
export const ModelManagerRequest = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
  instanceId: ProviderInstanceId,
});
export type ModelManagerRequest = typeof ModelManagerRequest.Type;

export const ModelManagerReply = Schema.Struct({
  /** The Models chat that does the work; one chat is reused for every request. */
  threadId: ThreadId,
  /** "queued" when the Models chat is still busy with an earlier request. */
  delivery: Schema.Literals(["started", "queued"]),
  /** The run doing this request, so a client can show when it ends. */
  runId: Schema.NullOr(RunId),
});
export type ModelManagerReply = typeof ModelManagerReply.Type;

export class ModelManagerError extends Schema.TaggedError<ModelManagerError>()(
  "ModelManagerError",
  { message: Schema.String },
) {}
