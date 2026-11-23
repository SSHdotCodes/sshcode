import type { PendingBackgroundWorkItem } from "@t3tools/client-runtime/state/thread-execution";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";

import { threadEnvironment } from "../../state/threads";
import { useEnvironmentScope } from "../../state/session";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { Button } from "../ui/button";

/** Queue controls target the held child message, without opening its chat. */
export function HeldBackgroundWorkActions({
  environmentId,
  item,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: PendingBackgroundWorkItem;
}) {
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const resume = useOrchestrationCommand(
    threadEnvironment.resumeThreadQueue,
    "resume held message",
  );
  const remove = useOrchestrationCommand(threadEnvironment.cancelQueuedRun, "remove held message");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const held = item.held;
  const threadId = item.childThreadId;
  if (held === undefined || threadId === undefined) return null;

  const act = async (action: "resume" | "remove") => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (action === "resume") await resume({ environmentId, input: { threadId } });
      else await remove({ environmentId, input: { threadId, runId: held.runId } });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        size="xs"
        variant="ghost"
        aria-label={`Resume held message: ${item.label}`}
        disabled={!canOperate || busy}
        onClick={() => void act("resume")}
      >
        Resume
      </Button>
      <Button
        size="xs"
        variant="ghost"
        aria-label={`Remove held message: ${item.label}`}
        disabled={!canOperate || busy}
        onClick={() => void act("remove")}
      >
        Remove
      </Button>
    </>
  );
}
