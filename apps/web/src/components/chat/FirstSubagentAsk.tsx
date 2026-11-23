import { useAtomValue } from "@effect/atom-react";
import { firstSubagentAskTarget } from "@t3tools/client-runtime/state/first-subagent-ask";
import type {
  FirstSubagentVerdict,
  OrchestrationV2Subagent,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { useState } from "react";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** One-tap correction on a chat's first subagent, for its first minute; no answer means Fine. */
export function FirstSubagentAsk(props: {
  readonly parentRef: ScopedThreadRef;
  readonly agent: OrchestrationV2Subagent;
}) {
  const shell = useThreadShell(props.parentRef)?.source;
  const environmentId = props.parentRef.environmentId;
  const canAnswer = useAtomValue(
    serverEnvironment.firstSubagentVerdict.permissionAtom(environmentId),
  );
  const answer = useAtomCommand(serverEnvironment.firstSubagentVerdict, { reportFailure: false });
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const target = firstSubagentAskTarget(shell, props.agent, environmentId);
  if (target === null || !canAnswer) return null;

  const choose = async (verdict: FirstSubagentVerdict) => {
    setBusy(true);
    const result = await answer({
      environmentId,
      input: { threadId: props.parentRef.threadId, taskId: props.agent.id, verdict },
    });
    if (result._tag === "Success" && verdict === "solo") {
      const stopped = await interrupt({
        environmentId: target.environmentId,
        input: { threadId: target.threadId },
      });
      if (stopped._tag === "Failure")
        toastManager.add({ type: "error", title: "Subagents are off, but this one did not stop" });
    }
    if (result._tag === "Failure")
      toastManager.add({ type: "error", title: "Could not save that" });
    // A saved answer removes this row's ask through the shell.
    setBusy(false);
  };

  return (
    <span className="ml-1 flex shrink-0 items-center gap-0.5" data-first-subagent-ask="true">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="micro"
              variant="outline"
              disabled={busy}
              onClick={() => void choose("solo")}
            />
          }
        >
          Keep solo
        </TooltipTrigger>
        <TooltipPopup>Turn off subagents for this chat and stop this one</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="micro"
              variant="ghost-muted"
              disabled={busy}
              onClick={() => void choose("fine")}
            />
          }
        >
          Fine
        </TooltipTrigger>
        <TooltipPopup>
          Let the agent keep using subagents here. Chosen by itself after a minute.
        </TooltipPopup>
      </Tooltip>
    </span>
  );
}
