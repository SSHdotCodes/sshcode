import { Link, useLocation } from "@tanstack/react-router";
import { ListChecksIcon } from "lucide-react";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

export function SidebarNotesLink() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={pathname === "/notes"}
          render={<Link to="/notes" />}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          <ListChecksIcon />
          <span>Notes</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
