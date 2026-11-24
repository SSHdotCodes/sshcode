import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createdChatPresentation } from "@t3tools/client-runtime/state/subagent-display";
import {
  ProviderDriverKind,
  type EnvironmentId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { getExplicitModelEffortLabel, resolveSelectableModel } from "@t3tools/shared/model";
import { Pressable, View } from "react-native";
import { useEnvironmentServerConfig } from "../../state/entities";
import { createdChatShellAtom } from "../../state/threads";
import { SubagentCardRow, SubagentMetadata } from "./SubagentRow";
import { SubagentElapsed } from "./thread-subagent-group";

export function CreatedChatCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: Extract<OrchestrationV2TurnItem, { type: "thread_created" }>;
}) {
  const shell = useAtomValue(
    createdChatShellAtom(scopeThreadRef(props.environmentId, props.item.targetThreadId)),
  );
  const chat = createdChatPresentation(props.item, shell);
  const config = useEnvironmentServerConfig(props.environmentId);
  const provider = config?.providers.find(
    (candidate) => candidate.instanceId === chat.providerInstanceId,
  );
  const navigation = useNavigation();
  const modelSlug = provider
    ? resolveSelectableModel(provider.driver, chat.model, provider.models)
    : chat.model;
  const providerModel = provider?.models.find((candidate) => candidate.slug === modelSlug);
  const effort = getExplicitModelEffortLabel(shell?.modelSelection, providerModel?.capabilities);
  return (
    <View className="mb-1 gap-px">
      <Pressable
        accessibilityRole={chat.canOpenThread ? "link" : undefined}
        accessibilityLabel={`${chat.title}, ${chat.statusLabel}`}
        accessibilityHint={chat.canOpenThread ? "Opens this chat" : undefined}
        disabled={!chat.canOpenThread}
        onPress={() =>
          navigation.dispatch(
            StackActions.push("Thread", {
              environmentId: String(props.environmentId),
              threadId: String(props.item.targetThreadId),
            }),
          )
        }
        className="min-h-[44px] rounded-md px-0.5 py-1.5 active:bg-subtle"
      >
        <SubagentCardRow
          presentation={chat}
          driver={provider?.driver ?? ProviderDriverKind.make("unknown")}
          iconUrl={provider?.iconUrl}
          preview={chat.preview}
          elapsed={<SubagentElapsed agents={[chat]} />}
          metadata={
            <SubagentMetadata
              environmentId={props.environmentId}
              createdChat
              effort={effort}
              subagent={{
                model: chat.model,
                providerInstanceId: chat.providerInstanceId,
              }}
            />
          }
        />
      </Pressable>
    </View>
  );
}
