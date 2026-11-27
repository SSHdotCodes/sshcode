import { type BotsError, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { botTools } from "../../../bots/botsRuntime.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { BotToolkit } from "./tools.ts";

const toFailure = (error: BotsError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "invalid" || error.reason === "notFound"
        ? "invalid_request"
        : "orchestration_error",
    message: error.message,
  });

/** The calling chat and the running bot service; both are needed by every bot tool. */
const context = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const { thread } = yield* McpInvocationContext.requireThreadScope(scope, "This tool");
  const tools = botTools();
  if (tools === null)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Bots are off.",
    });
  return { threadId: ThreadId.make(thread.threadId), tools };
});

const handlers = {
  message_bot: McpToolAccess.actsAsCaller((input) =>
    context.pipe(
      Effect.flatMap(({ threadId, tools }) =>
        tools.messageBot(threadId, input).pipe(Effect.mapError(toFailure)),
      ),
    ),
  ),
  bot_memory: McpToolAccess.actsAsCaller((input) =>
    context.pipe(
      Effect.flatMap(({ threadId, tools }) =>
        tools.memory(threadId, input).pipe(Effect.mapError(toFailure)),
      ),
      Effect.map((memory) => ({ memory })),
    ),
  ),
  watch_chats: McpToolAccess.actsAsCaller((input) =>
    context.pipe(
      Effect.flatMap(({ threadId, tools }) =>
        tools.watch(threadId, input).pipe(Effect.mapError(toFailure)),
      ),
      Effect.map((watching) => ({ watching })),
    ),
  ),
  unwatch_chats: McpToolAccess.actsAsCaller((input) =>
    context.pipe(
      Effect.flatMap(({ threadId, tools }) =>
        tools.unwatch(threadId, input.threadIds).pipe(Effect.mapError(toFailure)),
      ),
      Effect.map((watching) => ({ watching })),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof BotToolkit.tools>;

export const layer = McpToolAccess.toLayer(BotToolkit, handlers);
