import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { Pressable } from "react-native";

import { environmentThreadDetails } from "../../state/threads";

/** A team board note in a chat opens the board; in a subagent's chat, its lead's board. */
export function TeamBoardNoteRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
  readonly children: ReactNode;
}) {
  const navigation = useNavigation();
  const leadId = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(props.environmentId, props.threadId)),
    (detail) => {
      const lineage = detail?.projection.thread.lineage;
      return lineage?.relationshipToParent === "subagent" &&
        lineage.parentEnvironmentId === undefined &&
        lineage.parentThreadId !== null
        ? lineage.parentThreadId
        : props.threadId;
    },
  );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityHint="Opens the team board"
      className="active:opacity-70"
      onPress={() =>
        navigation.navigate("ThreadTeamBoard", {
          environmentId: props.environmentId,
          threadId: leadId,
        })
      }
    >
      {props.children}
    </Pressable>
  );
}
