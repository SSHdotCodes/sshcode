import { Link, useLocation } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";

import { useWorkflowsBeta } from "../workflows/workflowsBeta";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

/** Shown only with the Workflows Beta on. */
export function SidebarWorkflowsLink() {
  const enabled = useWorkflowsBeta();
  const active = useLocation({ select: (location) => location.pathname.startsWith("/workflows") });
  const { isMobile, setOpenMobile } = useSidebar();
  if (!enabled) return null;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={active}
          render={<Link to="/workflows" />}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          <WorkflowIcon />
          <span>Workflows</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
