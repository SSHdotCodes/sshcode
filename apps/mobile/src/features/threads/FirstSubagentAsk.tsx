import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { firstSubagentAskTarget } from "@t3tools/client-runtime/state/first-subagent-ask";
import type {
  EnvironmentId,
  FirstSubagentVerdict,
  OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** One-tap correction under a chat's first subagent, for its first minute; no answer means Fine. */
export function FirstSubagentAsk(props: {
  readonly environmentId: EnvironmentId;
  readonly subagent: Pick<
    OrchestrationV2Subagent,
    "id" | "threadId" | "origin" | "childThreadId" | "startedAt" | "status" | "remote"
  >;
}) {
  const shell = useThreadShell(
    scopeThreadRef(props.environmentId, props.subagent.threadId),
  )?.source;
  const canAnswer = useAtomValue(
    serverEnvironment.firstSubagentVerdict.permissionAtom(props.environmentId),
  );
  const answer = useAtomCommand(serverEnvironment.firstSubagentVerdict, "first subagent answer");
  const interrupt = useAtomCommand(threadEnvironment.interruptTurn, "subagent stop");
  const [busy, setBusy] = useState(false);
  const target = firstSubagentAskTarget(shell, props.subagent, props.environmentId);
  if (target === null || !canAnswer) return null;

  const choose = (verdict: FirstSubagentVerdict) => {
    void Haptics.selectionAsync();
    setBusy(true);
    void answer({
      environmentId: props.environmentId,
      input: { threadId: props.subagent.threadId, taskId: props.subagent.id, verdict },
    })
      .then((result) =>
        result._tag === "Success" && verdict === "solo"
          ? interrupt({ environmentId: target.environmentId, input: { threadId: target.threadId } })
          : undefined,
      )
      // A saved answer removes the ask through the shell.
      .finally(() => setBusy(false));
  };

  return (
    <View className="flex-row items-center gap-1 px-3 pb-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Keep solo"
        accessibilityHint="Turns off subagents for this chat and stops this one"
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        hitSlop={6}
        onPress={() => choose("solo")}
        className="min-h-8 justify-center rounded-full border border-border px-3 active:opacity-70"
      >
        <Text className="text-xs font-medium text-foreground">Keep solo</Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Fine"
        accessibilityHint="Lets the agent keep using subagents here. Chosen by itself after a minute."
        accessibilityState={{ disabled: busy }}
        disabled={busy}
        hitSlop={6}
        onPress={() => choose("fine")}
        className="min-h-8 justify-center rounded-full px-3 active:opacity-70"
      >
        <Text className="text-xs text-foreground-muted">Fine</Text>
      </Pressable>
    </View>
  );
}
