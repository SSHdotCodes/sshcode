import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { teamBoardPresenceLabel } from "@t3tools/client-runtime/state/team-board";
import type { EnvironmentId, NodeId, ThreadId } from "@t3tools/contracts";
import { Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { teamBoardEnvironment } from "../../state/teamBoard";

/** What a subagent is claiming or editing now ("settings.ts +2"); opens the board for it. */
export function TeamBoardPresenceChip(props: {
  readonly environmentId: EnvironmentId;
  /** The lead chat that owns the board. */
  readonly threadId: ThreadId;
  readonly taskId: NodeId;
}) {
  const navigation = useNavigation();
  const files = useAtomValue(
    teamBoardEnvironment.presenceAtom(
      scopeThreadRef(props.environmentId, props.threadId),
      props.taskId,
    ),
  );
  const label = files === null ? null : teamBoardPresenceLabel(files);
  if (files === null || label === null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`On the team board: ${files.join(", ")}`}
      accessibilityHint="Opens the team board for this subagent"
      hitSlop={6}
      onPress={() =>
        navigation.navigate("ThreadTeamBoard", {
          environmentId: props.environmentId,
          threadId: props.threadId,
          taskId: props.taskId,
        })
      }
      className="max-w-[45%] shrink flex-row items-center gap-0.5 rounded-full border border-border-subtle bg-subtle px-1.5 py-px active:opacity-70"
    >
      <Text numberOfLines={1} className="shrink font-mono text-xs text-foreground-muted">
        {label.name}
      </Text>
      {label.more > 0 ? (
        <Text className="font-mono text-xs text-foreground-muted">+{label.more}</Text>
      ) : null}
    </Pressable>
  );
}
