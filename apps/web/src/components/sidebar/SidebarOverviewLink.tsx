import { Link, useLocation } from "@tanstack/react-router";

import { useOverviewEnabled } from "../../hooks/useOverview";
import { HarnessMascot } from "../HarnessMascot";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";

/** Overview runs on Claude, so it wears Clawd. Hidden while the prototype is off. */
export function SidebarOverviewLink() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const [enabled] = useOverviewEnabled();
  if (!enabled) return null;
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton
          isActive={pathname === "/overview"}
          render={<Link to="/overview" />}
          onClick={() => {
            if (isMobile) setOpenMobile(false);
          }}
        >
          {/* Muted beside the one-colour icons of Notes and Workflows; its own colours on
              hover and while Overview is open. */}
          <span className="inline-flex shrink-0 opacity-70 grayscale transition-[filter,opacity] in-[a:hover]:opacity-100 in-[a:hover]:grayscale-0 in-data-[active=true]:opacity-100 in-data-[active=true]:grayscale-0 motion-reduce:transition-none">
            <HarnessMascot driver="claudeAgent" size={16} still />
          </span>
          <span>Overview</span>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
