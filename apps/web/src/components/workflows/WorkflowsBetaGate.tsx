import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import { WorkflowIcon } from "lucide-react";
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
        <WorkflowIcon className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Workflows</h1>
      </WorkspacePageHeader>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
        <div className="flex size-10 items-center justify-center rounded-xl border border-border/60 bg-card text-muted-foreground dark:inset-shadow-card-highlight">
          <WorkflowIcon className="size-5" />
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium text-foreground">Workflows beta is turned off</p>
          <p className="max-w-sm text-xs leading-5 text-muted-foreground">
            Turn on Workflows in Beta settings to draw and run multi-agent teams.
          </p>
        </div>
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
