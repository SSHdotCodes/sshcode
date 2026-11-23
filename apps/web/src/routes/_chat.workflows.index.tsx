import { createFileRoute } from "@tanstack/react-router";

import { WorkflowsBetaGate } from "../components/workflows/WorkflowsBetaGate";
import { WorkflowsPage } from "../components/workflows/WorkflowsPage";

function WorkflowsRoute() {
  return (
    <WorkflowsBetaGate>
      <WorkflowsPage />
    </WorkflowsBetaGate>
  );
}

export const Route = createFileRoute("/_chat/workflows/")({ component: WorkflowsRoute });
