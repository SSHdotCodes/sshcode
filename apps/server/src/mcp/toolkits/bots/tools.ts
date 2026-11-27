import {
  BOT_MEMORY_ENTRY_MAX,
  BOT_MESSAGE_MAX,
  BOT_WATCH_EVENTS,
  BOT_WATCH_MAX,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
];

/** Listed in every chat but a bot's own while Bots are on with a bot; nowhere otherwise. */
export const MessageBotTool = Tool.make("message_bot", {
  description:
    "Tell the user's bot something (results, a question for later). It reaches the user through the bot.",
  // Names carry the meaning; the server rejects empty text and picks the first bot by default.
  parameters: Schema.Struct({
    text: Schema.String.check(Schema.isMaxLength(BOT_MESSAGE_MAX)),
    bot: Schema.optionalKey(Schema.String),
    urgent: Schema.optionalKey(Schema.Boolean),
  }),
  success: Schema.Struct({
    bot: Schema.String,
    delivery: Schema.Literals(["now", "soon", "held"]),
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Message the bot")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const MemoryEntry = Schema.Struct({ id: Schema.String, at: Schema.String, text: Schema.String });
const MemoryText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(BOT_MEMORY_ENTRY_MAX),
);

const BotMemoryTool = Tool.make("bot_memory", {
  description:
    "Your dated notes: add, replace {id,text} or remove an id. Returns them all. Keep preferences and standing asks, not chat logs.",
  parameters: Schema.Struct({
    add: Schema.optional(MemoryText),
    replace: Schema.optional(Schema.Struct({ id: Schema.String, text: MemoryText })),
    remove: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ memory: Schema.Array(MemoryEntry) }),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Update the bot's memory")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false);

const Watching = Schema.Struct({
  watching: Schema.Array(
    Schema.Struct({
      threadId: Schema.String,
      title: Schema.String,
      events: Schema.Array(Schema.String),
      until: Schema.optional(Schema.String),
    }),
  ),
});
const ThreadIds = Schema.Array(Schema.String).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(BOT_WATCH_MAX),
);

const WatchChatsTool = Tool.make("watch_chats", {
  description:
    "Wake on these chats' events (default finished, failed, question). Updates come batched in one note; questions and failures wake you at once. Survives restarts.",
  parameters: Schema.Struct({
    threadIds: ThreadIds,
    events: Schema.optional(Schema.Array(Schema.Literals(BOT_WATCH_EVENTS))),
    until: Schema.optional(Schema.String).annotate({ description: "ISO time to stop" }),
  }),
  success: Watching,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Watch chats")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const UnwatchChatsTool = Tool.make("unwatch_chats", {
  description: "Stop watching these chats. Returns what you still watch.",
  parameters: Schema.Struct({ threadIds: ThreadIds }),
  success: Watching,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Stop watching chats")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const MessageBotToolkit = Toolkit.make(MessageBotTool);
export const BotChatToolkit = Toolkit.make(BotMemoryTool, WatchChatsTool, UnwatchChatsTool);
export const BotToolkit = Toolkit.make(
  MessageBotTool,
  BotMemoryTool,
  WatchChatsTool,
  UnwatchChatsTool,
);
