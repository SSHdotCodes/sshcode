import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import { TerminalSessionRouteView } from "../components/sidebar/TerminalSessionRouteView";

export const Route = createFileRoute("/_chat/terminal/$environmentId/$sessionId")({
  component: TerminalSessionRoute,
});

function TerminalSessionRoute() {
  const { environmentId, sessionId } = Route.useParams();
  return (
    <TerminalSessionRouteView
      environmentId={EnvironmentId.make(environmentId)}
      sessionId={sessionId}
    />
  );
}
