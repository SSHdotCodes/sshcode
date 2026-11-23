import * as Schema from "effect/Schema";
import { ToolActivitySource } from "./providerRuntime.ts";

const SessionId = Schema.String.check(Schema.isPattern(/^cse_[A-Za-z0-9]+$/));
export const CLAUDE_RC_TAB = "builtin:terminal-sessions:sidebar-tab";

/** Remote Control clients never create orchestration threads or launch a provider. */
export const ClaudeRcSession = Schema.Struct({
  id: SessionId,
  title: Schema.String,
  updatedAt: Schema.String,
  working: Schema.Boolean,
});
export type ClaudeRcSession = typeof ClaudeRcSession.Type;
export const ClaudeRcSelection = Schema.Struct({ sessionId: SessionId });
export const ClaudeRcSessions = Schema.Array(ClaudeRcSession);
/** A tool call joined with its result, so clients can label it like a chat's work log. */
export const ClaudeRcTool = Schema.Struct({
  name: Schema.String,
  /** An MCP tool's display name and server, as Claude Code reports them. */
  title: Schema.optionalKey(Schema.String),
  source: Schema.optionalKey(ToolActivitySource),
  input: Schema.optionalKey(Schema.Unknown),
  output: Schema.optionalKey(Schema.String),
  failed: Schema.optionalKey(Schema.Boolean),
  done: Schema.optionalKey(Schema.Boolean),
});
export type ClaudeRcTool = typeof ClaudeRcTool.Type;
export const ClaudeRcItem = Schema.Struct({
  id: Schema.String,
  role: Schema.Literals(["user", "assistant", "tool", "notice"]),
  /** Plain text for every role; tool items keep it for clients without `tool`. */
  text: Schema.String,
  tool: Schema.optionalKey(ClaudeRcTool),
});
export type ClaudeRcItem = typeof ClaudeRcItem.Type;
export const ClaudeRcPermission = Schema.Struct({
  requestId: Schema.String,
  toolName: Schema.String,
  description: Schema.String,
});
export type ClaudeRcPermission = typeof ClaudeRcPermission.Type;
export const ClaudeRcEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("textDelta"), id: Schema.String, text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("item"), item: ClaudeRcItem }),
  Schema.Struct({ type: Schema.Literal("permission"), permission: ClaudeRcPermission }),
  Schema.Struct({ type: Schema.Literal("permissionResolved"), requestId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("status"),
    phase: Schema.Literals(["connecting", "connected", "disconnected"]),
    working: Schema.Boolean,
    message: Schema.optionalKey(Schema.String),
  }),
]);
export type ClaudeRcEvent = typeof ClaudeRcEvent.Type;
export const ClaudeRcCommand = Schema.Union([
  Schema.Struct({
    action: Schema.Literal("send"),
    sessionId: SessionId,
    text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100_000)),
  }),
  Schema.Struct({ action: Schema.Literal("interrupt"), sessionId: SessionId }),
  Schema.Struct({
    action: Schema.Literal("permission"),
    sessionId: SessionId,
    requestId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
    allow: Schema.Boolean,
  }),
]);
export type ClaudeRcCommand = typeof ClaudeRcCommand.Type;
export class ClaudeRcError extends Schema.TaggedError<ClaudeRcError>()("ClaudeRcError", {
  message: Schema.String,
}) {}
