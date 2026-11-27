import { useAtomValue } from "@effect/atom-react";
import { canRateSubagent } from "@t3tools/client-runtime/state/subagent-rankings";
import {
  SUBAGENT_GRADE_MAX,
  type EnvironmentId,
  type NodeId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { subagentRankingsEnvironment } from "../../state/server";

/**
 * The lead's grade for a finished subagent, once it checked the result. A small
 * chip for the card's status line; nothing shows until the lead has graded.
 */
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
    <View
      accessible
      accessibilityLabel={`Lead's grade ${grade} of ${SUBAGENT_GRADE_MAX}`}
      className="shrink-0 rounded bg-subtle px-1.5 py-px"
    >
      <Text className="text-2xs font-medium text-foreground-muted">
        {grade}/{SUBAGENT_GRADE_MAX}
      </Text>
    </View>
  );
}
