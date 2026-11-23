import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { useEnvironment } from "../../state/environments";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { claudeRcEnvironment } from "../../state/claudeRc";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { TerminalSessionChat } from "./TerminalSessionChat";
import { terminalHostPhase } from "@t3tools/client-runtime/terminal-sessions";

export function TerminalSessionRouteView(props: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
}) {
  const environment = useEnvironment(props.environmentId);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const config = configs.get(props.environmentId);
  const host = terminalHostPhase({
    environmentId: environment?.environmentId ?? null,
    connected: environment?.connection.phase === "connected",
    connecting:
      environment?.connection.phase === "connecting" ||
      environment?.connection.phase === "reconnecting",
    configLoaded: config !== undefined,
    claudeRemoteControl: config?.environment.capabilities.claudeRemoteControl,
  });
  const navigate = useNavigate();
  const back = () => void navigate({ to: "/terminal" });
  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden md:h-dvh">
      {config?.environment.capabilities.claudeRemoteControl === true ? (
        <ReadyTerminalSession
          key={`${props.environmentId}:${props.sessionId}`}
          {...props}
          label={environment?.label ?? "Machine"}
          hostMessage={host.message}
          hostReady={host.phase === "ready"}
          onBack={back}
        />
      ) : (
        <div className="flex h-full flex-col gap-3 p-4">
          <SidebarTrigger />
          <p role="status" className="text-sm text-muted-foreground">
            {host.message ?? "Connecting…"}
          </p>
          <div>
            <Button variant="ghost" onClick={back}>
              Back to Terminal sessions
            </Button>
          </div>
        </div>
      )}
    </SidebarInset>
  );
}

function ReadyTerminalSession(props: {
  readonly environmentId: EnvironmentId;
  readonly sessionId: string;
  readonly label: string;
  readonly hostMessage: string | null;
  readonly hostReady: boolean;
  readonly onBack: () => void;
}) {
  const sessions = useEnvironmentQuery(
    claudeRcEnvironment.sessions({ environmentId: props.environmentId, input: {} }),
  );
  const session = sessions.data?.find((item) => item.id === props.sessionId) ?? {
    id: props.sessionId,
    title: "Terminal session",
    updatedAt: "",
    working: false,
  };
  return (
    <TerminalSessionChat
      environmentId={props.environmentId}
      session={session}
      machineLabel={props.label}
      onBack={props.onBack}
      hostMessage={props.hostMessage}
      hostReady={props.hostReady}
    />
  );
}
