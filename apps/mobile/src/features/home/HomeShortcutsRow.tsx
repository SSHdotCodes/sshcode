import { View } from "react-native";
import { OverviewHomeRow } from "../overview/OverviewHomeRow";
import { useOverviewEnabled } from "../overview/useOverview";
import { WorkflowsHomeRow } from "../workflows/WorkflowsHomeRow";
import { useWorkflowsEnabled } from "../workflows/state";

/**
 * Shortcuts as quiet outlined chips at the end of the tab chips row, behind a hairline, so
 * the chat list starts right under one row of chips and nothing above it outweighs the chats.
 */
export function HomeShortcutChips() {
  const [overview] = useOverviewEnabled();
  const [workflows] = useWorkflowsEnabled();
  if (!overview && !workflows) return null;
  return (
    <>
      <View className="mx-1 h-4 w-px self-center bg-border" />
      <OverviewHomeRow />
      <WorkflowsHomeRow />
    </>
  );
}

/** The same chips in a row of their own, for the layout without tab chips. */
export function HomeShortcutsRow() {
  const [overview] = useOverviewEnabled();
  const [workflows] = useWorkflowsEnabled();
  if (!overview && !workflows) return null;
  return (
    <View className="flex-row gap-1.5 px-4 pb-2 pt-0.5">
      <OverviewHomeRow />
      <WorkflowsHomeRow />
    </View>
  );
}
