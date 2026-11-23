import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MonitorInfo, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

const NO_MONITORS: ReadonlyArray<MonitorInfo> = [];

/** A live server roster, independent of provider turns and durable conversation history. */
export function useThreadMonitors(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<MonitorInfo> {
  const query = useEnvironmentQuery(
    threadId === null || environmentId === null
      ? null
      : orchestrationEnvironment.monitors({ environmentId, input: { threadId } }),
  );
  return query.data ?? NO_MONITORS;
}

/** App-owned monitors (monitor_start), listed in the Agents sheet beside the agents they wake. */
export function ThreadMonitorRows({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const monitors = useThreadMonitors(environmentId, threadId);
  const canStop = useAtomValue(orchestrationEnvironment.stopMonitor.permissionAtom(environmentId));
  const stop = useAtomCommand(orchestrationEnvironment.stopMonitor);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState(false);
  if (monitors.length === 0) return null;

  const stopMonitor = async (monitorId: string) => {
    setStopping(monitorId);
    setError(false);
    const result = await stop({ environmentId, input: { threadId, monitorId } });
    setError(result._tag === "Failure");
    setStopping(null);
  };

  return (
    <View accessibilityLabel="Monitors">
      <Text className="pb-1 pt-5 font-t3-medium text-xs text-foreground-muted">Monitors</Text>
      {monitors.map((monitor) => (
        <View
          key={monitor.monitorId}
          className="flex-row items-center gap-3 border-b border-border py-2"
        >
          <View className="min-w-0 flex-1">
            <Text className="text-sm leading-5 text-foreground" numberOfLines={2}>
              {monitor.description}
              {monitor.state ? ` (${monitor.state})` : ""}
            </Text>
          </View>
          {canStop ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Stop monitor: ${monitor.description}`}
              disabled={stopping !== null}
              className="min-h-11 min-w-11 items-center justify-center active:opacity-70"
              // Asks first: Stop sits at the edge of a list people scroll, and it ends the job.
              onPress={() =>
                Alert.alert("Stop this monitor?", monitor.description, [
                  { text: "Keep running", style: "cancel" },
                  {
                    text: "Stop monitor",
                    style: "destructive",
                    onPress: () => void stopMonitor(monitor.monitorId),
                  },
                ])
              }
            >
              <Text className="text-sm text-foreground">
                {stopping === monitor.monitorId ? "Stopping…" : "Stop"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ))}
      {error ? (
        <Text className="pt-2 text-xs text-foreground-muted" accessibilityRole="alert">
          Could not stop the monitor. Try again.
        </Text>
      ) : null}
    </View>
  );
}
