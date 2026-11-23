import type { EnvironmentId, WorkflowDefinition } from "@t3tools/contracts";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { WorkflowButton, WorkflowSheet } from "./WorkflowSheets";
import { workflowsState } from "./state";

export function WorkflowPicker({
  environmentId,
  onPick,
  onClose,
}: {
  environmentId: EnvironmentId;
  onPick: (workflow: WorkflowDefinition) => void;
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(workflowsState({ environmentId, input: {} }));
  return (
    <WorkflowSheet title="Use a workflow" onClose={onClose}>
      <Text className="text-sm text-foreground-muted">
        This chat leads the run on its current model. Add a task, then send.
      </Text>
      {query.error ? (
        <View className="gap-2">
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {query.error}
          </Text>
          <WorkflowButton title="Retry" onPress={query.refresh} />
        </View>
      ) : query.data === null ? (
        <Text className="text-foreground-muted">Loading workflows…</Text>
      ) : query.data.workflows.length === 0 ? (
        <Text className="text-foreground-muted">
          No workflows yet. Create one from the Workflows row on Home.
        </Text>
      ) : (
        query.data.workflows.map((workflow) => (
          <Pressable
            key={workflow.id}
            accessibilityRole="button"
            onPress={() => onPick(workflow)}
            className="min-h-16 gap-1 rounded-xl bg-secondary p-4"
          >
            <Text className="font-t3-semibold">{workflow.name}</Text>
            <Text className="text-xs text-foreground-muted">
              {workflow.nodes.filter((node) => node.kind === "agent").length} boxes
            </Text>
          </Pressable>
        ))
      )}
    </WorkflowSheet>
  );
}
