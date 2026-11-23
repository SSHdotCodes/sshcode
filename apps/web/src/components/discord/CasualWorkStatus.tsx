import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCasualStatus } from "./useCasualVoice";
export function CasualWorkStatus(props: {
  environmentId: EnvironmentId | null;
  threadId: ThreadId | null;
  runId: string | null;
  active: boolean;
}) {
  const status = useCasualStatus(props.environmentId, props.threadId, props.runId, props.active);
  return status ? (
    <p role="status" data-casual-work-status className="select-none text-xs text-muted-foreground">
      {status}
    </p>
  ) : null;
}
