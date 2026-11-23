import { Link, useLocation } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

/** Every chat as a box on one screen. */
export function SidebarBoardLink() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={pathname === "/board"}
          render={<Link to="/board" />}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          <LayoutGridIcon className="size-4" />
          <span>Board</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
