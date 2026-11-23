import {
  OrchestratorMcpFailure,
  WorkflowRunDiagnostic,
  WorkflowRunStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));

export const WorkflowBox = Schema.Struct({
  id: Text(40),
  label: Text(80),
  /** "instanceId/model" or a model slug from orchestrator_capabilities. */
  model: Text(200),
  count: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16 }))),
  upTo: Schema.optional(Schema.Boolean),
  parent: Schema.optional(Text(40)),
  after: Schema.optional(Text(40)),
  brief: Schema.optional(Text(4_000)),
  worktree: Schema.optional(Schema.Boolean),
});

export const WorkflowToolInput = Schema.Struct({
  action: Schema.Literals(["list", "save", "start", "status"]),
  id: Schema.optional(Text(64)),
  name: Schema.optional(Text(120)),
  boxes: Schema.optional(Schema.Array(WorkflowBox).check(Schema.isMaxLength(64))),
  notes: Schema.optional(Schema.Array(Text(4_000)).check(Schema.isMaxLength(16))),
  task: Schema.optional(Text(20_000)),
  clientRequestId: Schema.optional(Text(100)),
});

export const WorkflowToolkit = Toolkit.make(
  Tool.make("workflow", {
    description:
      "Saved agent teams. list. save {name, boxes, notes?, id?}: box {id, label, model, count?, upTo?, parent?, after? (sibling first), brief?, worktree?}. One parentless lead. start {id, task, clientRequestId} runs a subagent; reuse the key to retry. Completion wakes you. status {id: runId} shows execution differences.",
    parameters: WorkflowToolInput,
    success: Schema.Union([
      Schema.Struct({
        workflows: Schema.Array(
          Schema.Struct({ id: Schema.String, name: Schema.String, boxes: Schema.String }),
        ),
      }),
      Schema.Struct({ id: Schema.String, issues: Schema.Array(Schema.String) }),
      Schema.Struct({ runId: Schema.String, taskId: Schema.String, leadThreadId: Schema.String }),
      Schema.Struct({
        runId: Schema.String,
        status: WorkflowRunStatus,
        diagnostics: Schema.Array(WorkflowRunDiagnostic),
      }),
    ]),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagement.ThreadManagementService,
    ],
  })
    .annotate(Tool.Title, "Workflows")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false),
);
