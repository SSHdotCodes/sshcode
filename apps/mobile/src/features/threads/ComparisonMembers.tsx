import { useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import { useNavigation } from "@react-navigation/native";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ModelComparison,
  type ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AppText as Text } from "../../components/AppText";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import { useThreadShells, useServerConfigs } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

/** A compact member list keeps each chat's native approvals, questions and composer intact. */
export function ComparisonMembers({
  comparison,
  environmentId,
  threadId,
}: {
  comparison: ModelComparison;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const threads = useThreadShells();
  const configs = useServerConfigs();
  const navigation = useNavigation();
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const update = useAtomCommand(serverEnvironment.chatTabsCommand, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const continueWith = async () => {
    if (busy || !canOperate) return;
    setBusy(true);
    const result = await update({
      environmentId,
      input: { action: "continue-comparison", comparisonId: comparison.id, threadId },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      Alert.alert(
        "Could not continue",
        failure instanceof Error ? failure.message : "Your chats are still saved. Try again.",
      );
    }
  };
  return (
    <View className="border-b border-border bg-screen px-3 py-2">
      <Text className="text-sm font-semibold" numberOfLines={1}>
        Compare: {comparison.title}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingVertical: 8 }}
      >
        {comparison.threadIds.map((id, index) => {
          const member = threads.find(
            (thread) => thread.environmentId === environmentId && thread.id === id,
          );
          const provider = configs
            .get(environmentId)
            ?.providers.find((entry) => entry.instanceId === member?.modelSelection.instanceId);
          const instanceLabel = provider
            ? resolveProviderInstanceDisplayName(provider)
            : member?.modelSelection.instanceId;
          const attention =
            member?.hasPendingApprovals ||
            member?.hasPendingUserInput ||
            member?.pendingSubagentRequest;
          return (
            <Pressable
              key={id}
              accessibilityRole="button"
              accessibilityState={{ selected: id === threadId }}
              onPress={() => navigation.navigate("Thread", { environmentId, threadId: id })}
              className="rounded-lg border border-border px-3 py-2"
            >
              <Text className={id === threadId ? "text-sm font-semibold" : "text-sm"}>
                {member?.modelSelection.model ?? `Chat ${index + 1}`}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {instanceLabel ? `${instanceLabel} · ` : ""}
                {attention ? "Needs you" : (member?.runtime?.status ?? "Ready")}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      <Pressable
        accessibilityRole="button"
        disabled={busy || !canOperate}
        onPress={() => void continueWith()}
        className="py-1"
      >
        <Text className="text-sm text-primary">
          {busy ? "Stopping other chats…" : "Continue with this"}
        </Text>
      </Pressable>
      <Text className="text-xs text-foreground-muted">
        Other chats move to Settled. You can reopen them anytime.
      </Text>
    </View>
  );
}
