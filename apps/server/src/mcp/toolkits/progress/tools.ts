import {
  OrchestratorMcpFailure,
  ReportProgressInput,
  ReportProgressResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as LiveProgress from "../../../liveProgress/LiveProgress.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** Listed only while Settings > Agents token use is High (agentToolListVisible). */
const ReportProgressTool = Tool.make("report_progress", {
  description:
    "Update the user's live progress card: stages (titles ≤60 chars) with rough minutes, a plain update line ≤140, or percent.",
  parameters: ReportProgressInput,
  success: ReportProgressResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    LiveProgress.LiveProgress,
  ],
})
  .annotate(Tool.Title, "Report progress")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const ProgressToolkit = Toolkit.make(ReportProgressTool);
