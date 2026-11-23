import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  notificationChildThreadId,
  notificationSubagent,
} from "@t3tools/client-runtime/state/thread-execution";
import type { EnvironmentId, OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText } from "../../components/AppText";
import { formatTranscriptTimestamp } from "../../lib/time";
import { environmentThreadDetails } from "../../state/threads";
import { subagentNotificationPresentation } from "./subagent-card-presentation";
import { SubagentGradeBadge } from "./SubagentGradeBadge";
import { SubagentRow } from "./SubagentRow";
import { resolveSubagentRowPresentation } from "./threadAgentsPresentation";

/** A past subagent event uses the same card and frozen status wording as the Mac. */
export function SubagentNotificationRow(props: {
  readonly environmentId: EnvironmentId;
  readonly item: Extract<OrchestrationV2TurnItem, { type: "notification" }>;
  readonly children: ReactNode;
}) {
  const { item, environmentId } = props;
  const navigation = useNavigation();
  const subagent = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(environmentId, item.threadId)),
    (thread) => notificationSubagent(thread?.projection.subagents ?? [], item.source) ?? null,
  );
  const childThreadId = notificationChildThreadId(item.source);
  if (subagent === null || childThreadId === undefined) return props.children;
  const event = subagentNotificationPresentation(item.outcome);
  const snapshot = { ...subagent, status: event.status ?? subagent.status, childThreadId };
  const presentation = resolveSubagentRowPresentation(snapshot);
  return (
    <View>
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={`${presentation.title}, ${event.statusLabel}`}
        accessibilityHint="Opens this subagent's chat"
        className="min-h-[44px] rounded-md px-0.5 py-1.5 active:bg-subtle"
        onPress={() =>
          navigation.dispatch(
            StackActions.push("Thread", {
              environmentId: String(subagent.remote?.environmentId ?? environmentId),
              threadId: String(childThreadId),
            }),
          )
        }
      >
        <SubagentRow
          environmentId={environmentId}
          subagent={snapshot}
          statusLabel={event.statusLabel}
          elapsed={
            <AppText className="text-xs tabular-nums text-foreground-muted">
              {formatTranscriptTimestamp(DateTime.formatIso(item.startedAt ?? item.updatedAt))}
            </AppText>
          }
          grade={
            <SubagentGradeBadge
              environmentId={environmentId}
              taskId={subagent.id}
              origin={subagent.origin}
              status={subagent.status}
            />
          }
        />
      </Pressable>
    </View>
  );
}
