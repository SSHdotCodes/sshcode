import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as DebugLog from "../../../debug/DebugLog.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const DebugLogInput = Schema.Struct({
  action: Schema.Literals(["start", "read", "stop"]),
  sessionId: Schema.optional(Schema.String),
  cursor: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  filter: Schema.optional(Schema.String.check(Schema.isMaxLength(1000))),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 }))),
});

export const DebugToolkit = Toolkit.make(
  Tool.make("debug_log", {
    description:
      "Temporary runtime logs for this thread. start returns write-only ingestUrl, plus remoteUrl for other devices: POST JSON or text, max 64 KiB/event, 5 MiB/10k events. read uses a cursor and optional text filter; replies are bounded. stop removes the capture and closes the URL. Expires after 2h idle. Remove instrumentation when done.",
    parameters: DebugLogInput,
    success: Schema.Union([
      Schema.Struct({
        sessionId: Schema.String,
        ingestUrl: Schema.String,
        remoteUrl: Schema.optional(Schema.String),
      }),
      Schema.Struct({
        events: Schema.Array(
          Schema.Struct({ cursor: Schema.Int, time: Schema.Number, text: Schema.String }),
        ),
        nextCursor: Schema.Int,
        hasMore: Schema.Boolean,
      }),
      Schema.Struct({ stopped: Schema.Literal(true) }),
    ]),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      DebugLog.DebugLog,
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  })
    .annotate(Tool.Title, "Debug logs")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
);
