import { createFileRoute } from "@tanstack/react-router";
import { SidebarInset, SidebarTrigger } from "../components/ui/sidebar";

export const Route = createFileRoute("/_chat/terminal/")({
  component: TerminalSessionsLanding,
});

function TerminalSessionsLanding() {
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden md:h-dvh">
      <header data-chat-header className="flex min-h-14 shrink-0 items-center gap-3 border-b px-4">
        <SidebarTrigger />
        <h2 className="text-sm font-medium">Terminal sessions</h2>
      </header>
      <p className="m-auto px-4 text-sm text-muted-foreground">
        Choose a session in the Terminal tab.
      </p>
    </SidebarInset>
  );
}
