import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { isElectron } from "../../env";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { Button } from "../ui/button";
import { SidebarInset } from "../ui/sidebar";
import { useWorkflowsBeta } from "./workflowsBeta";

/** Workflows pages render only with the Beta on; a stale link explains how to turn it on. */
export function WorkflowsBetaGate({
  children,
  environmentId,
}: {
  readonly children: ReactNode;
  readonly environmentId?: EnvironmentId;
}) {
  const enabled = useWorkflowsBeta(environmentId);
  const navigate = useNavigate();
  if (enabled)
    return <SidebarInset className="h-dvh min-h-0 overflow-hidden">{children}</SidebarInset>;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden">
      <WorkspacePageHeader electron={isElectron}>
        <h1 className="text-sm font-medium">Workflows</h1>
      </WorkspacePageHeader>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <p className="text-sm text-muted-foreground">Workflows is a Beta and it’s turned off.</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void navigate({ to: "/settings/general", hash: "beta" })}
        >
          Open Beta settings
        </Button>
      </div>
    </SidebarInset>
  );
}
