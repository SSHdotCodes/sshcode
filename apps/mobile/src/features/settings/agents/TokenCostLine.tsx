import { useAtomValue } from "@effect/atom-react";
import {
  agentTokenCostLine,
  agentTokenHarness,
  weeklyChatsByHarness,
} from "@t3tools/client-runtime/state/agent-behavior";
import type { AgentTokenLevel } from "@t3tools/shared/agentTokenEstimates";
import { harnessMascotAgentId } from "@t3tools/shared/harnessMascots";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";
import { useCoarseNow } from "../../../lib/useCoarseNow";
import { environmentServerConfigsAtom } from "../../../state/server";
import { environmentThreadShells } from "../../../state/threads";

/**
 * Token use's measured cost: "About +N% tokens vs <harness> alone · about +M% of plan usage".
 * Tapping the harness opens every measured harness. Render it only for a measured level.
 */
export function TokenCostLine({ level }: { readonly level: AgentTokenLevel }) {
  const shells = useAtomValue(environmentThreadShells.threadShellsAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const nowMs = useCoarseNow();
  const [open, setOpen] = useState(false);
  const chats = useMemo(
    () =>
      weeklyChatsByHarness(
        shells.map((shell) => {
          const config = configs.get(shell.environmentId);
          const driver = config?.providers.find(
            (provider) => provider.instanceId === shell.providerInstanceId,
          )?.driver;
          return {
            harness: agentTokenHarness(
              driver,
              harnessMascotAgentId(
                driver,
                config?.settings.providerInstances[shell.providerInstanceId]?.config,
              ),
            ),
            activeAt: shell.activityLastAt ?? shell.latestUserMessageAt,
          };
        }),
        nowMs,
      ),
    [configs, nowMs, shells],
  );
  const line = agentTokenCostLine(level, chats);
  if (line === null) return null;
  return (
    <View className="gap-1">
      <Text className="text-xs text-foreground-muted" style={{ fontVariant: ["tabular-nums"] }}>
        {line.shown.lineBeforeHarness}
        <Text
          accessibilityRole="button"
          accessibilityHint="Shows every measured harness"
          className="text-xs text-primary"
          onPress={() => setOpen(!open)}
        >
          {line.shown.label}
        </Text>
        {line.shown.lineAfterHarness}
      </Text>
      {open ? (
        <View className="gap-1 rounded-xl bg-foreground/5 px-3 py-2">
          {line.rows.map((row) => (
            <View key={row.harness} className="gap-0.5">
              <View className="flex-row gap-3">
                <Text className="flex-1 text-xs text-foreground">{row.label}</Text>
                <Text
                  className="text-xs text-foreground-muted"
                  style={{ fontVariant: ["tabular-nums"] }}
                >
                  {row.tokens} tokens · {row.usage} usage
                </Text>
              </View>
              <Text
                className="text-[11px] text-foreground-muted/80"
                style={{ fontVariant: ["tabular-nums"] }}
              >
                {row.measuredLabel}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}
