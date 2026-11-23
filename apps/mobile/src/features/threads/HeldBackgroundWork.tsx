import {
  formatPendingBackgroundWorkItem,
  type PendingBackgroundWorkItem,
} from "@t3tools/client-runtime/state/thread-execution";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { threadEnvironment } from "../../state/threads";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";

export function HeldBackgroundWorkActions({
  environmentId,
  item,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: PendingBackgroundWorkItem;
}) {
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const resume = useAtomCommand(threadEnvironment.resumeThreadQueue, "resume held message");
  const remove = useAtomCommand(threadEnvironment.cancelQueuedRun, "remove held message");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const held = item.held;
  const threadId = item.childThreadId;
  if (held === undefined || threadId === undefined) return null;

  const act = async (action: "resume" | "remove") => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      if (action === "resume") await resume({ environmentId, input: { threadId } });
      else await remove({ environmentId, input: { threadId, runId: held.runId } });
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <View className="flex-row items-center gap-2">
      {(["resume", "remove"] as const).map((action) => (
        <Pressable
          key={action}
          accessibilityRole="button"
          accessibilityLabel={`${action === "resume" ? "Resume" : "Remove"} held message: ${item.label}`}
          disabled={busy || !canOperate}
          className="min-h-11 justify-center px-1 active:opacity-70 disabled:opacity-40"
          onPress={(event) => {
            event.stopPropagation();
            void act(action);
          }}
        >
          <Text className="font-t3-medium text-xs text-foreground">
            {action === "resume" ? "Resume" : "Remove"}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

/** Held sends replace the child's working row until its queue is resumed or removed. */
export function HeldBackgroundWorkRow({
  environmentId,
  item,
  onOpen,
}: {
  readonly environmentId: EnvironmentId;
  readonly item: PendingBackgroundWorkItem;
  readonly onOpen: () => void;
}) {
  return (
    <View className="border-b border-border py-2">
      <Pressable accessibilityRole="link" onPress={onOpen} className="active:opacity-70">
        <Text className="text-sm leading-5 text-foreground">
          {formatPendingBackgroundWorkItem(item)}
        </Text>
      </Pressable>
      <HeldBackgroundWorkActions environmentId={environmentId} item={item} />
    </View>
  );
}
