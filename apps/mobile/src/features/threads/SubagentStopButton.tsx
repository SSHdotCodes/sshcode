import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Alert, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { subagentStopTarget } from "./threadAgentsPresentation";

/**
 * Stops one running app-owned subagent from the Agents sheet. It asks first: the button sits
 * at the edge of a list people scroll with their thumb, and a stopped run can't be resumed.
 */
export function SubagentStopButton(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: OrchestrationV2Subagent;
  readonly title: string;
}) {
  const target = subagentStopTarget(props.subagent, props.environmentId);
  const canOperate = useEnvironmentScope(
    target?.environmentId ?? props.environmentId,
    AuthOrchestrationOperateScope,
  );
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, "subagent stop");
  const [stopping, setStopping] = useState(false);
  if (target === null || !canOperate) return null;
  // Stays "Stopping…" until the projection settles the task and the row drops this button.
  const pending = stopping || props.subagent.cancellationRequested === true;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Stop subagent: ${props.title}`}
      accessibilityState={{ disabled: pending, busy: pending }}
      disabled={pending}
      className="min-h-11 min-w-11 items-center justify-center px-1 active:opacity-70"
      onPress={() => {
        void Haptics.selectionAsync();
        Alert.alert("Stop this subagent?", props.title, [
          { text: "Keep running", style: "cancel" },
          {
            text: "Stop subagent",
            style: "destructive",
            onPress: () => {
              setStopping(true);
              void interrupt({
                environmentId: target.environmentId,
                input: { threadId: target.threadId },
              }).then((result) => {
                if (result._tag === "Failure") setStopping(false);
              });
            },
          },
        ]);
      }}
    >
      <Text className="text-sm text-foreground">{pending ? "Stopping…" : "Stop"}</Text>
    </Pressable>
  );
}
