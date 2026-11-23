import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DebugLog from "../../../debug/DebugLog.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DebugToolkit, DebugLogInput } from "./tools.ts";

const handle = Effect.fnUntraced(function* (input: typeof DebugLogInput.Type) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.thread === undefined || !scope.capabilities.has("orchestration"))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Debug logs need an agent thread.",
    });
  const log = yield* DebugLog.DebugLog;
  if (input.action !== "start" && !input.sessionId)
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: "Pass sessionId.",
    });
  const operation = Effect.gen(function* () {
    if (input.action === "start") return yield* log.start(scope.thread!.threadId);
    if (input.action === "read")
      return yield* log.read(scope.thread!.threadId, { ...input, sessionId: input.sessionId! });
    return yield* log.stop(scope.thread!.threadId, input.sessionId!);
  });
  return yield* operation.pipe(
    Effect.mapError(
      (error) => new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
    ),
  );
});

export const layer = McpToolAccess.toLayer(DebugToolkit, {
  debug_log: McpToolAccess.either(
    (input) => input.action === "read",
    McpToolAccess.readsAsCaller(handle),
    McpToolAccess.actsAsCaller(handle),
  ),
});
