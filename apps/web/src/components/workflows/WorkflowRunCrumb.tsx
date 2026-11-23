import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";

import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { useWorkflowRunForChat } from "./WorkflowRunChatsTracker";

/** Chat header crumb back to the run a chat belongs to; renders nothing otherwise. */
export function WorkflowRunCrumb({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const run = useWorkflowRunForChat(environmentId, threadId);
  if (!run) return null;
  return (
    <>
      <WorkspaceBreadcrumbItem>
        <Link
          to="/workflows/$environmentId/runs/$runId"
          params={{ environmentId, runId: run.runId }}
          aria-label={`Back to the ${run.name} run`}
          className="inline-flex min-w-0 max-w-48 items-center gap-1.5 rounded-sm transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <WorkflowIcon className="size-3.5 shrink-0" />
          <WorkspaceBreadcrumbText>{run.name}</WorkspaceBreadcrumbText>
        </Link>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}
