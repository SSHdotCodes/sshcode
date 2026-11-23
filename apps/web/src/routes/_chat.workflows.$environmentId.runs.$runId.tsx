import type { EnvironmentId, WorkflowRunId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { WorkflowRunPage } from "../components/workflows/WorkflowRunView";
import { WorkflowsBetaGate } from "../components/workflows/WorkflowsBetaGate";

function WorkflowRunRoute() {
  const { environmentId, runId } = Route.useParams();
  return (
    <WorkflowsBetaGate environmentId={environmentId as EnvironmentId}>
      <WorkflowRunPage
        environmentId={environmentId as EnvironmentId}
        runId={runId as WorkflowRunId}
      />
    </WorkflowsBetaGate>
  );
}

export const Route = createFileRoute("/_chat/workflows/$environmentId/runs/$runId")({
  component: WorkflowRunRoute,
});
