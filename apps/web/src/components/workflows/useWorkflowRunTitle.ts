import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, WorkflowRun } from "@t3tools/contracts";

import { useThreadShell } from "../../state/entities";

/**
 * A run reads as its lead chat's title, generated like any chat's; the task
 * stands in until then, and for runs started inside an existing chat.
 */
export function useWorkflowRunTitle(environmentId: EnvironmentId, run: WorkflowRun): string {
  const shell = useThreadShell(
    run.origin === "workflows" ? scopeThreadRef(environmentId, run.leadThreadId) : null,
  );
  const title = shell?.title.trim();
  return title && title !== "New thread" ? title : run.task;
}
