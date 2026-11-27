import { useWithoutBotThreads } from "../bots/state";
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  isUsageWindowAlmostOut,
  usedPercentLabel,
  recentUseBySource,
} from "@t3tools/shared/usageLimits";
import * as Haptics from "expo-haptics";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useKeyboardState } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Circle, Svg } from "react-native-svg";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GlassSurface } from "../../components/GlassSurface";
import { ProviderIcon } from "../../components/ProviderIcon";
import { useNavigationThreadShells, useThreadShells } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentPresentations } from "../../state/presentation";
import { useWorkspaceConnectionState } from "../../state/workspace";
import { shellPreviewPresentation } from "../../state/threads";
import { workspaceThreadCounts } from "../../state/shell-preview";
import {
  LIMIT_TONE_COLOR,
  limitTone,
  planRunsFromThreads,
  planUse,
  resetsInShort,
  statusRowRings,
  statusRowVisibleRings,
  summarizeProviderLimits,
  tightestProviderLimits,
  type ProviderLimits,
} from "../usage/limitsGlance";
import {
  resolveStatusAccessoryItems,
  statusAccessoryItemsNeedClock,
  type StatusAccessoryItem,
} from "../../lib/statusAccessoryItems";
import type { ConnectionSummary } from "./statusAccessory";
import { useConnectionAccessoryStatus } from "./useConnectionAccessoryStatus";

const CAPSULE_HEIGHT = 44;
const ITEM_GAP = 16;
const CAPSULE_PADDING = 16;
const RING_SIZE = 24;
const MINUTE = 60_000;

/** Re-reads the clock once a minute while a countdown is on screen. */
function useMinuteClock(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setNow(Date.now()), MINUTE);
    return () => clearInterval(interval);
  }, [active]);
  return now;
}

function LimitRing(props: { readonly limits: ProviderLimits }) {
  const { tightest, driver, pool } = props.limits;
  // Only older readings behind it (their probes read nothing lately): drawn quieter.
  const older =
    pool.accounts.length > 0 &&
    pool.accounts.every((account) => account.asOf !== undefined && !account.limits.refreshing);
  const stroke = 2.5;
  const radius = (RING_SIZE - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const used = Math.min(
    isUsageWindowAlmostOut(tightest) ? 99 : 100,
    Math.max(0, tightest.usedPercent),
  );
  return (
    <View style={{ width: RING_SIZE, height: RING_SIZE, opacity: older ? 0.45 : 1 }}>
      <Svg width={RING_SIZE} height={RING_SIZE} style={StyleSheet.absoluteFill}>
        <Circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={radius}
          stroke="rgba(127,127,127,0.28)"
          strokeWidth={stroke}
          fill="none"
        />
        <Circle
          cx={RING_SIZE / 2}
          cy={RING_SIZE / 2}
          r={radius}
          stroke={LIMIT_TONE_COLOR[limitTone(used)]}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={`${(used / 100) * circumference} ${circumference}`}
          fill="none"
          transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
        />
      </Svg>
      <View style={StyleSheet.absoluteFill} className="items-center justify-center">
        <ProviderIcon provider={driver} size={11} />
      </View>
    </View>
  );
}

const CONNECTION_SYMBOL: Record<
  Exclude<ConnectionSummary, "none">,
  { readonly name: "wifi" | "wifi.slash" | "arrow.clockwise"; readonly tint: string }
> = {
  connected: { name: "wifi", tint: "accent-icon-muted" },
  connecting: { name: "arrow.clockwise", tint: "accent-warning-foreground" },
  offline: { name: "wifi.slash", tint: "accent-danger-foreground" },
};

const CONNECTION_LABEL: Record<ConnectionSummary, string> = {
  connected: "Connected",
  connecting: "Reconnecting",
  offline: "Offline",
  none: "No computer connected",
};

function CountBadge(props: {
  readonly icon: "bolt.circle" | "bell.badge";
  readonly count: number;
  readonly tint: string;
}) {
  return (
    <View className="flex-row items-center gap-0.5">
      <SymbolView name={props.icon} size={14} tintColorClassName={props.tint} type="monochrome" />
      <Text className="text-xs font-t3-medium tabular-nums text-foreground">{props.count}</Text>
    </View>
  );
}

interface RenderedItem {
  readonly key: StatusAccessoryItem;
  readonly label: string;
  readonly node: ReactNode;
}

function useStatusAccessoryState() {
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const items = resolveStatusAccessoryItems(
    AsyncResult.isSuccess(preferences) ? preferences.value.statusAccessoryItems : undefined,
  );
  const connection = useConnectionAccessoryStatus(useWorkspaceConnectionState());
  const visible =
    !keyboardVisible && items.some((item) => item !== "connection" || connection !== null);
  const ringChoices = AsyncResult.isSuccess(preferences)
    ? preferences.value.statusAccessoryRings
    : undefined;
  const combinedRings = AsyncResult.isSuccess(preferences)
    ? preferences.value.statusAccessoryCombinedRings
    : undefined;
  return { items, connection, visible, ringChoices, combinedRings };
}

export function useWorkspaceStatusAccessoryVisible() {
  return useStatusAccessoryState().visible;
}

/** UIKit owns this row's size and position; older iOS uses a row above the tabs. */
export function WorkspaceStatusAccessory(props: {
  readonly hidden: boolean;
  readonly native?: boolean;
}) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { visible, items, connection, ringChoices, combinedRings } = useStatusAccessoryState();
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const threads = useWithoutBotThreads(useNavigationThreadShells());
  const previewCounts = useAtomValue(shellPreviewPresentation.countsAtom);
  // The rings pool windows by the minute too, so they share the countdown's clock.
  const now = useMinuteClock(statusAccessoryItemsNeedClock(items));

  // Hours each plan's chats and subagents ran this past week, as their servers count them.
  const recentUse = useMemo(() => recentUseBySource(presentations), [presentations]);
  const providers = useMemo(
    () =>
      summarizeProviderLimits(
        collectLimitPools(collectLimitAccounts(presentations), now, recentUse),
      ),
    [now, presentations, recentUse],
  );
  // Rings the user turned off stay out of the row and out of its countdown.
  const rings = useMemo(
    () => statusRowRings(providers, ringChoices, combinedRings),
    [combinedRings, providers, ringChoices],
  );
  // Every chat and subagent, archived too: the plans they ran on lately get the room.
  const allThreads = useThreadShells();
  const planRuns = useMemo(() => planRunsFromThreads(allThreads), [allThreads]);
  const use = useMemo(() => planUse(planRuns, now, recentUse), [now, planRuns, recentUse]);
  // Room for the plans in use; the rest are a count, and all are on Usage.
  const visibleRings = useMemo(() => statusRowVisibleRings(rings, use), [rings, use]);
  const counts = workspaceThreadCounts(threads, previewCounts);
  const workingCount = counts?.working ?? 0;
  const needsYouCount = counts?.needsYou ?? 0;

  if (props.hidden || !visible) return null;

  const rendered = items.flatMap((item): RenderedItem[] => {
    switch (item) {
      case "limits": {
        if (rings.length === 0)
          return [
            {
              key: item,

              label: "Usage limits unavailable",
              node: (
                <View className="flex-row items-center gap-1.5">
                  <SymbolView
                    name="chart.bar.xaxis"
                    size={16}
                    tintColorClassName="accent-icon-muted"
                  />
                  <Text className="text-xs text-foreground-muted">Usage</Text>
                </View>
              ),
            },
          ];
        return [
          {
            key: item,

            label: rings
              .map(
                (ring) =>
                  `${ring.label ?? PROVIDER_DISPLAY_NAMES[ring.limits.driver] ?? ring.limits.driver} ${ring.limits.tightest.label} ${usedPercentLabel(ring.limits.tightest)}${ring.limits.pool.accounts.some((account) => account.limits.refreshing) ? ", refreshing" : ""}`,
              )
              .join(", "),
            node: (
              <View className="flex-row items-center gap-1">
                {visibleRings.shown.map((ring) => (
                  <LimitRing key={ring.key} limits={ring.limits} />
                ))}
                {visibleRings.more > 0 ? (
                  <Text className="ml-0.5 text-xs font-t3-medium tabular-nums text-foreground-muted">
                    +{visibleRings.more}
                  </Text>
                ) : null}
              </View>
            ),
          },
        ];
      }
      case "connection": {
        if (connection === null) return [];
        const symbol = CONNECTION_SYMBOL[connection === "none" ? "offline" : connection];
        return [
          {
            key: item,

            label: CONNECTION_LABEL[connection],
            node: (
              <View className="flex-row items-center gap-1.5">
                <SymbolView
                  name={symbol.name}
                  size={15}
                  tintColorClassName={symbol.tint}
                  type="monochrome"
                />
                <Text className="text-xs text-foreground-muted">
                  {CONNECTION_LABEL[connection]}
                </Text>
              </View>
            ),
          },
        ];
      }
      case "working":
        if (counts === null) return [];
        return [
          {
            key: item,

            label: `${workingCount} working`,
            node: <CountBadge icon="bolt.circle" count={workingCount} tint="accent-icon-muted" />,
          },
        ];
      case "needsYou":
        if (counts === null) return [];
        return [
          {
            key: item,

            label: `${needsYouCount} waiting for you`,
            node: (
              <CountBadge
                icon="bell.badge"
                count={needsYouCount}
                tint="accent-warning-foreground"
              />
            ),
          },
        ];
      case "nextReset": {
        const tightest = tightestProviderLimits(rings.map((ring) => ring.limits))?.tightest;
        const resetsIn = tightest ? resetsInShort(tightest, now) : null;
        if (!tightest || !resetsIn)
          return [
            {
              key: item,
              label: "Next reset unavailable",
              node: <Text className="text-xs text-foreground-muted">Reset unavailable</Text>,
            },
          ];
        return [
          {
            key: item,

            label: `${tightest.label} resets in ${resetsIn}`,
            node: (
              <View className="flex-row items-center gap-0.5">
                <SymbolView
                  name="arrow.clockwise"
                  size={11}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
                <Text className="text-xs tabular-nums text-foreground-muted">{resetsIn}</Text>
              </View>
            ),
          },
        ];
      }
    }
  });
  if (rendered.length === 0) return null;
  const openUsage = () =>
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsUsage", initial: false },
    });
  const openSettings = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: { screen: "SettingsStatusAccessory", initial: false },
    });
  };

  const content = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={rendered.map((item) => item.label).join(", ")}
      accessibilityHint="Opens usage. Long press to choose what shows here."
      onPress={openUsage}
      onLongPress={openSettings}
      style={{ flex: 1, minHeight: CAPSULE_HEIGHT }}
      className="active:opacity-80"
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{
          flexGrow: 1,
          alignItems: "center",
          justifyContent: "center",
          gap: ITEM_GAP,
          paddingHorizontal: CAPSULE_PADDING,
        }}
      >
        {rendered.map((item) => (
          <View key={item.key}>{item.node}</View>
        ))}
      </ScrollView>
    </Pressable>
  );
  if (props.native) return content;
  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <GlassSurface
        chrome="none"
        style={{
          position: "absolute",
          left: 20,
          right: 20,
          bottom: insets.bottom + 74,
          height: CAPSULE_HEIGHT,
          borderRadius: CAPSULE_HEIGHT / 2,
        }}
      >
        {content}
      </GlassSurface>
    </View>
  );
}
