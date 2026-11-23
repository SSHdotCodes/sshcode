import * as Schema from "effect/Schema";
import { AuthMcpClientAccess } from "./auth.ts";

const Id = Schema.String.check(Schema.isMaxLength(64));

/** An outside agent waiting at its sign-in page for the owner to let it in. */
export const OutsideAgentSignIn = Schema.Struct({
  id: Id,
  /** Only approval-capable authenticated sessions may read this state. */
  code: Schema.String.check(Schema.isPattern(/^[0-9]{4}$/)),
  /** Self-declared by the agent, so shown as such. */
  clientName: Schema.String,
  /** Where approving sends the agent's code: its https host, or a loopback address. */
  redirectHost: Schema.String,
  requestedAt: Schema.Number,
  expiresAt: Schema.Number,
});
export type OutsideAgentSignIn = typeof OutsideAgentSignIn.Type;

export const OutsideAgentsState = Schema.Struct({
  /** The `outsideAgents` server setting. */
  enabled: Schema.Boolean,
  /** Until when new agents may sign in; null while SSHCode is not taking any. */
  acceptingUntil: Schema.NullOr(Schema.Number),
  pending: Schema.Array(OutsideAgentSignIn),
});
export type OutsideAgentsState = typeof OutsideAgentsState.Type;

export const OutsideAgentsCommand = Schema.Union([
  Schema.TaggedStruct("approve", {
    id: Id,
    access: AuthMcpClientAccess,
    // Decode old clients so the service can explain that they must update.
    code: Schema.optionalKey(Schema.String),
  }),
  Schema.TaggedStruct("deny", { id: Id }),
  /** Takes new sign-ins for the next few minutes. */
  Schema.TaggedStruct("accept-new", {}),
  Schema.TaggedStruct("stop-accepting", {}),
]);
export type OutsideAgentsCommand = typeof OutsideAgentsCommand.Type;

export class OutsideAgentsError extends Schema.TaggedError<OutsideAgentsError>()(
  "OutsideAgentsError",
  { message: Schema.String },
) {}
