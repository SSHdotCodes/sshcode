import { useAtomValue } from "@effect/atom-react";
import { canRateSubagent } from "@t3tools/client-runtime/state/subagent-rankings";
import {
  SUBAGENT_GRADE_MAX,
  type EnvironmentId,
  type NodeId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { subagentRankingsEnvironment } from "../../state/server";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The lead's grade for a finished subagent, once it checked the result. */
export function SubagentGradeBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly taskId: NodeId;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly status: OrchestrationV2Subagent["status"];
}) {
  if (!canRateSubagent(props)) return null;
  return <Grade environmentId={props.environmentId} taskId={props.taskId} />;
}

function Grade(props: { readonly environmentId: EnvironmentId; readonly taskId: NodeId }) {
  const grade = useAtomValue(
    subagentRankingsEnvironment.gradeAtom(props.environmentId, props.taskId),
  );
  if (grade === undefined) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={`Lead's grade ${grade} of ${SUBAGENT_GRADE_MAX}`}
            className="shrink-0 rounded-sm bg-muted px-1 py-px text-2xs font-medium text-muted-foreground tabular-nums"
          />
        }
      >
        {grade}/{SUBAGENT_GRADE_MAX}
      </TooltipTrigger>
      <TooltipPopup>The lead's grade after checking this result</TooltipPopup>
    </Tooltip>
  );
}
