import * as Schema from "effect/Schema";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderOptionDescriptor } from "./model.ts";
import { MessageId, ThreadId, TurnItemId } from "./baseSchemas.ts";

export const CasualVoiceRole = Schema.Literals(["final", "update"]);
export type CasualVoiceRole = typeof CasualVoiceRole.Type;
export const CasualVoiceDisplay = Schema.Struct({
  role: CasualVoiceRole,
  blocks: Schema.Array(
    Schema.Struct({
      from: Schema.Number,
      to: Schema.Number,
      kind: Schema.Literals(["say", "status", "hide"]),
      bubbles: Schema.Array(Schema.String),
      text: Schema.String,
      original: Schema.String,
      before: Schema.String,
    }),
  ),
  trailing: Schema.String,
});
export type CasualVoiceDisplay = typeof CasualVoiceDisplay.Type;

/** A steer whose wording was rejected, but whose decision lines still covered every segment. */
export const CasualVoiceDecision = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("send"),
    segments: Schema.Array(Schema.Number),
  }),
  Schema.Struct({ kind: Schema.Literal("quiet") }),
]);
export type CasualVoiceDecision = typeof CasualVoiceDecision.Type;

export const CasualVoiceBackend = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("provider"),
    modelSelection: ModelSelection,
    styleFile: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
  }),
  Schema.Struct({
    kind: Schema.Literal("local"),
    styleFile: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
    url: Schema.String.check(Schema.isMaxLength(2048)),
    model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
]);
export type CasualVoiceBackend = typeof CasualVoiceBackend.Type;
export const CasualVoiceMode = Schema.Literals(["local", "hybrid", "cloud"]);
export type CasualVoiceMode = typeof CasualVoiceMode.Type;
export const CasualVoiceState = Schema.Struct({
  enabled: Schema.Boolean,
  backend: Schema.NullOr(CasualVoiceBackend),
  /** Absent on older replies. Hybrid is the default once both backends exist. */
  mode: Schema.optionalKey(CasualVoiceMode),
  cloudBackend: Schema.optionalKey(Schema.NullOr(CasualVoiceBackend)),
  /** Absent means the private training log is on. */
  saveTraining: Schema.optionalKey(Schema.Boolean),
});
export type CasualVoiceState = typeof CasualVoiceState.Type;
export const CasualVoiceRequest = Schema.Union([
  Schema.Struct({ action: Schema.Literal("get"), threadId: ThreadId }),
  Schema.Struct({
    action: Schema.Literal("configure"),
    threadId: ThreadId,
    enabled: Schema.optionalKey(Schema.Boolean),
    backend: Schema.optionalKey(Schema.NullOr(CasualVoiceBackend)),
    mode: Schema.optionalKey(CasualVoiceMode),
    cloudBackend: Schema.optionalKey(Schema.NullOr(CasualVoiceBackend)),
    saveTraining: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    action: Schema.Literal("rewrite"),
    threadId: ThreadId,
    messageId: MessageId,
    /** Targets a closed reasoning window by its first item; messageId identifies the steer. */
    reasoningItemId: Schema.optionalKey(TurnItemId),
    role: Schema.optionalKey(CasualVoiceRole),
  }),
  Schema.Struct({
    action: Schema.Literal("feedback"),
    threadId: ThreadId,
    inputHash: Schema.String.check(Schema.isMinLength(64), Schema.isMaxLength(64)),
  }),
]);
export type CasualVoiceRequest = typeof CasualVoiceRequest.Type;
export const CasualVoiceReply = Schema.Struct({
  ...CasualVoiceState.fields,
  display: Schema.optionalKey(CasualVoiceDisplay),
  models: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        instanceId: Schema.String,
        model: Schema.String,
        name: Schema.String,
        optionDescriptors: Schema.optionalKey(Schema.Array(ProviderOptionDescriptor)),
      }),
    ),
  ),
  /** Sha256 of the masked input. Present only for a cloud rewrite while training saves are on. */
  inputHash: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  /** Present only when a steer rewrite was rejected but its decision lines still parsed. */
  decision: Schema.optionalKey(CasualVoiceDecision),
});
export type CasualVoiceReply = typeof CasualVoiceReply.Type;
export class CasualVoiceError extends Schema.TaggedError<CasualVoiceError>()("CasualVoiceError", {
  message: Schema.String,
}) {}
