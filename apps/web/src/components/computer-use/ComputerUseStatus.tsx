import { useNavigate } from "@tanstack/react-router";
import { computerUseChatStatus } from "@t3tools/client-runtime/state/computer-use";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Clock3Icon, MonitorIcon, MousePointer2Icon, PauseIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { useEnvironment } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { computerUseEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function ComputerUseStatusIcon({
  kind,
  className,
}: {
  readonly kind: NonNullable<ReturnType<typeof computerUseChatStatus>>["kind"];
  readonly className?: string;
}) {
  switch (kind) {
    case "controlling":
      return <MousePointer2Icon aria-hidden className={cn("text-success", className)} />;
    case "queued":
      return <Clock3Icon aria-hidden className={cn("text-warning", className)} />;
    case "paused":
      return <PauseIcon aria-hidden className={cn("text-warning", className)} />;
    case "busy":
      return <MonitorIcon aria-hidden className={cn("text-info", className)} />;
    case "needs-setup":
      return <MonitorIcon aria-hidden className={cn("text-warning", className)} />;
    case "unavailable":
      return <MonitorIcon aria-hidden className={cn("text-destructive", className)} />;
    case "setup-unknown":
    case "ready":
      return <MonitorIcon aria-hidden className={cn("text-muted-foreground", className)} />;
  }
}

export function ComputerUseStatus({
  environmentId,
  threadId,
  discord = false,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly discord?: boolean;
}) {
  const navigate = useNavigate();
  const environment = useEnvironment(environmentId);
  const enabled =
    environment?.serverConfig?.computerUse === true &&
    environment.serverConfig.settings.computerUse.enabled;
  const query = useEnvironmentQuery(
    enabled ? computerUseEnvironment.state({ environmentId, input: {} }) : null,
  );
  const status = query.data ? computerUseChatStatus(query.data, threadId) : null;
  if (!status) return null;

  const label = `${status.label}. Open Computer use settings.`;
  const openSettings = () =>
    void navigate({
      to: "/settings/computer-use",
      search: { machine: environmentId },
    });
  const trigger = discord ? (
    <button
      type="button"
      className="dc-icon-button [-webkit-app-region:no-drag]"
      aria-label={label}
      onClick={openSettings}
    >
      <ComputerUseStatusIcon kind={status.kind} className="size-5" />
    </button>
  ) : (
    <Button
      variant="ghost"
      size="icon-sm"
      className="[-webkit-app-region:no-drag]"
      aria-label={label}
      onClick={openSettings}
    >
      <ComputerUseStatusIcon kind={status.kind} />
    </Button>
  );

  return (
    <Tooltip>
      <TooltipTrigger render={trigger} />
      <TooltipPopup side="bottom">
        <span className="block font-medium">{status.label}</span>
        <span className="block">{status.detail}</span>
        <span className="block">Open Computer use settings.</span>
      </TooltipPopup>
    </Tooltip>
  );
}
