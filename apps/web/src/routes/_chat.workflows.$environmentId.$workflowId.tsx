import type { EnvironmentId, WorkflowId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { WorkflowEditorPage } from "../components/workflows/WorkflowEditor";
import { WorkflowsBetaGate } from "../components/workflows/WorkflowsBetaGate";

function WorkflowEditorRoute() {
  const { environmentId, workflowId } = Route.useParams();
  return (
    <WorkflowsBetaGate environmentId={environmentId as EnvironmentId}>
      <WorkflowEditorPage
        environmentId={environmentId as EnvironmentId}
        workflowId={workflowId as WorkflowId}
      />
    </WorkflowsBetaGate>
  );
}

export const Route = createFileRoute("/_chat/workflows/$environmentId/$workflowId")({
  component: WorkflowEditorRoute,
});
