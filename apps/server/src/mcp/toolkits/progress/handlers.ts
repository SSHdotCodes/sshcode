import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as LiveProgress from "../../../liveProgress/LiveProgress.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { ProgressToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ProgressToolkit, {
  report_progress: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "report_progress");
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const shell = yield* threads
        .getThreadShell(caller.thread.threadId)
        .pipe(Effect.mapError(unavailable));
      const progress = yield* LiveProgress.LiveProgress;
      const workStartedAt = shell?.activityRunStartedAt;
      yield* progress.report({
        threadId: caller.thread.threadId,
        model: shell?.modelSelection.model ?? null,
        workStartedAt: workStartedAt == null ? null : DateTime.toEpochMillis(workStartedAt),
        report: input,
      });
      return { ok: true as const };
    }),
  ),
});
