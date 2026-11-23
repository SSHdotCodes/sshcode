import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { EnvironmentId, ModelSelection, ServerConfig } from "@t3tools/contracts";
import {
  buildNewChatActivity,
  formatChatDelta,
  formatQuotaReset,
  newChatAccounts,
  newChatUsageWindows,
} from "@t3tools/client-runtime/new-chat-dashboard";
import { AppText as Text } from "../../components/AppText";
export { NewChatBackdrop } from "./NewChatBackdrop";
// oxlint-disable-next-line t3code/no-mobile-uniwind-theme-escape-hatches -- SVG paths take their colours as props.
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useThreadShells } from "../../state/entities";
import { DitherHeatmap, DitherPaceChart, useReveal, type HeatmapDay } from "../home/ditherViews";

const PACE_HEIGHT = 40;

/** A compact, scrollable dashboard below the resting composer; hidden for typing. */
export function NewChatDashboard({
  environmentId,
  config,
  driver,
  instanceId,
  selection,
  balanceAccounts,
  acceptsAccount,
  onPickAccount,
  maxHeight,
  bottomInset,
}: {
  environmentId: EnvironmentId;
  config: ServerConfig | null;
  driver: string | null;
  /** The account the selected model runs on; its limits are the ones shown. */
  instanceId: string | null;
  /** The selected model: with two accounts of its provider, Usage shows both as equals. */
  selection: ModelSelection | null;
  /** Says where new chats start; off when the user picks accounts by hand. */
  balanceAccounts: boolean;
  /** Whether this chat could start a model on an account (its project, hidden models). */
  acceptsAccount: (provider: ServerConfig["providers"][number], model: string) => boolean;
  /** Starts this chat on another of the user's accounts. */
  onPickAccount: (instanceId: string) => void;
  maxHeight: number;
  bottomInset: number;
}) {
  const threads = useThreadShells();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);
  const activity = useMemo(
    () => buildNewChatActivity(threads, environmentId, now),
    [threads, environmentId, now],
  );
  // Neutral ink: only the horizon carries the harness colour.
  const ink = String(useUniwindTheme()["--color-foreground"]);
  const heatmapDays = useMemo(
    () =>
      activity.days.map((day) => ({
        level: day.level as HeatmapDay["level"],
        future: day.future,
        shares: [{ color: ink, share: 1 }],
      })),
    [activity.days, ink],
  );
  const reveal = useReveal(true, 120, 900);
  const windows = useMemo(
    () => newChatUsageWindows(config, environmentId, driver, instanceId),
    [config, environmentId, driver, instanceId],
  );
  const accounts = useMemo(
    () => newChatAccounts(config, selection, now, acceptsAccount),
    [acceptsAccount, config, selection, now],
  );
  const cardStyle = {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 12,
  };
  return (
    <ScrollView
      style={{ maxHeight, flexGrow: 0 }}
      contentContainerStyle={[styles.dashboard, { paddingBottom: bottomInset }]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      accessibilityLabel="Your chat activity"
      testID="new-chat-dashboard"
    >
      <View className="border-border bg-card" style={cardStyle}>
        <View style={styles.heading}>
          <Text className="text-foreground" style={styles.title}>
            Activity
          </Text>
          <Text className="text-foreground-muted" style={styles.caption}>
            26 weeks
          </Text>
        </View>
        <DitherHeatmap
          days={heatmapDays}
          weeks={26}
          maxCell={12}
          progress={reveal}
          accessibilityLabel={`${activity.total} ${activity.total === 1 ? "chat" : "chats"} started across ${activity.activeDays} active ${activity.activeDays === 1 ? "day" : "days"} in the last 26 weeks, from loaded chats on this machine`}
        />
        <Text className="text-foreground-muted" style={[styles.caption, { marginTop: 10 }]}>
          {activity.total.toLocaleString()} {activity.total === 1 ? "chat" : "chats"} ·{" "}
          {activity.activeDays} active {activity.activeDays === 1 ? "day" : "days"}
        </Text>
      </View>
      <View style={styles.bottomRow}>
        {accounts ? (
          <View className="border-border bg-card" style={[cardStyle, { flex: 1 }]}>
            <Text className="text-foreground" style={[styles.title, { marginBottom: 10 }]}>
              Usage
            </Text>
            {accounts.rows.map((account) => {
              const used = Math.round(account.limit?.usedPercent ?? 0);
              const ink = account.current ? "text-foreground" : "text-foreground-muted";
              return (
                <Pressable
                  key={account.instanceId}
                  accessibilityRole="button"
                  accessibilityState={{ selected: account.current }}
                  accessibilityLabel={`${account.name}, ${account.limit ? `${used}% used` : "no limits reported"}${account.current ? ", this chat" : ""}`}
                  accessibilityHint={account.current ? undefined : "Starts this chat on it"}
                  hitSlop={4}
                  onPress={() => {
                    if (!account.current) onPickAccount(account.instanceId);
                  }}
                  style={{ marginBottom: 8 }}
                >
                  <View style={[styles.heading, { marginBottom: 6 }]}>
                    <Text className={ink} numberOfLines={1} style={[styles.caption, { flex: 1 }]}>
                      {account.name}
                      {account.current ? " · this chat" : ""}
                    </Text>
                    <Text className={ink} style={styles.caption}>
                      {account.limit ? `${used}% used` : "No limits"}
                    </Text>
                  </View>
                  <View className="bg-border/40" style={styles.track}>
                    <View
                      className="bg-foreground"
                      style={{
                        opacity: account.current ? 0.72 : 0.38,
                        width: `${account.limit?.usedPercent ?? 0}%`,
                        height: 4,
                        borderRadius: 4,
                      }}
                    />
                  </View>
                </Pressable>
              );
            })}
            {balanceAccounts && accounts.note ? (
              <Text className="text-foreground-muted" numberOfLines={2} style={styles.source}>
                {/* The reason is in the model picker; this card is half the screen wide. */}
                {accounts.note.split(":")[0]}
              </Text>
            ) : null}
          </View>
        ) : windows.length > 0 ? (
          <View className="border-border bg-card" style={[cardStyle, { flex: 1 }]}>
            <Text className="text-foreground" style={[styles.title, { marginBottom: 10 }]}>
              Usage
            </Text>
            {windows.slice(0, 1).map((window) => (
              <View key={window.key} style={{ marginBottom: 8 }}>
                <View style={styles.heading}>
                  <Text
                    className="text-foreground-muted"
                    numberOfLines={1}
                    style={[styles.caption, { flex: 1 }]}
                  >
                    {window.accountLabel} · {window.label}
                  </Text>
                  <Text className="text-foreground" style={styles.caption}>
                    {Math.round(window.usedPercent)}% used
                  </Text>
                </View>
                <View
                  accessibilityRole="progressbar"
                  accessibilityLabel={`${window.accountLabel} ${window.label} used`}
                  accessibilityValue={{ min: 0, max: 100, now: window.usedPercent }}
                  className="bg-border/40"
                  style={styles.track}
                >
                  <View
                    className="bg-foreground"
                    style={{
                      opacity: 0.72,
                      width: `${window.usedPercent}%`,
                      height: 4,
                      borderRadius: 4,
                    }}
                  />
                </View>
                {window.resetsAt ? (
                  <Text className="text-foreground-muted" style={styles.source}>
                    {`Resets ${formatQuotaReset(window.resetsAt)}`}
                  </Text>
                ) : null}
              </View>
            ))}
            {windows.length > 1 ? (
              <Text className="text-foreground-muted" numberOfLines={1} style={styles.source}>
                +{windows.length - 1} more in Usage
              </Text>
            ) : null}
          </View>
        ) : null}
        <View className="border-border bg-card" style={[cardStyle, { flex: 1 }]}>
          <Text className="text-foreground" style={[styles.title, { marginBottom: 10 }]}>
            This month
          </Text>
          <View style={{ marginBottom: 8 }}>
            <Text className="text-foreground-muted" style={styles.caption}>
              Chats started
            </Text>
            <View style={{ flexDirection: "row", alignItems: "baseline", gap: 8 }}>
              <Text
                className="text-foreground"
                style={{ fontSize: 24, fontVariant: ["tabular-nums"] }}
              >
                {activity.month.chats.toLocaleString()}
              </Text>
              <Text
                className="text-foreground-muted"
                accessibilityLabel={`${formatChatDelta(activity.delta.chats)} versus the same days last month`}
                style={styles.caption}
              >
                {formatChatDelta(activity.delta.chats)}
              </Text>
            </View>
          </View>
          <View style={{ marginTop: 4 }} testID="new-chat-pace">
            <DitherPaceChart
              pace={activity.pace}
              tint={ink}
              height={PACE_HEIGHT}
              progress={reveal}
            />
          </View>
          <Text className="text-foreground-muted" style={styles.source}>
            vs. same days in {activity.pace.previousMonth}
          </Text>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  dashboard: { paddingHorizontal: 12, paddingTop: 10, paddingBottom: 12, gap: 10 },
  heading: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 5,
    marginBottom: 8,
  },
  title: { fontSize: 13, fontWeight: "500" },
  caption: { fontSize: 12, fontVariant: ["tabular-nums"] },
  source: { fontSize: 11, marginTop: 5, lineHeight: 14 },
  bottomRow: { flexDirection: "row", gap: 10 },
  track: { height: 4, borderRadius: 4, overflow: "hidden" },
});
