import type {
  OrchestratorMcpDelegateTaskInput,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpFailure,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { WorkflowsService } from "./WorkflowsService.ts";

/** Agent access follows the authoritative server setting and its change stream. */
export interface WorkflowsAgentAccess {
  readonly service: WorkflowsService["Service"];
  readonly providers: Effect.Effect<ReadonlyArray<ServerProvider>>;
}

let enabled = false;
let access: WorkflowsAgentAccess | null = null;

export const workflowsBetaEnabled = () => enabled;

export const setWorkflowsBetaEnabled = (value: boolean) => {
  enabled = value;
};

export const workflowsAgentAccess = () => access;

export const registerWorkflowsAgentAccess = (value: WorkflowsAgentAccess | null) => {
  access = value;
};

/** delegate_task as the caller, registered by the orchestrator so `start` runs a workflow as a subagent. */
export type WorkflowsDelegate = (
  scope: McpInvocationScope,
  key: string,
) => {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly spawn: (
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
};

let delegate: WorkflowsDelegate | null = null;

export const workflowsDelegate = () => delegate;

export const registerWorkflowsDelegate = (value: WorkflowsDelegate | null) => {
  delegate = value;
};
