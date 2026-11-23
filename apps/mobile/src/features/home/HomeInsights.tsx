/**
 * The home screen's Insights: what you have been doing, below the chats. Activity by day
 * and harness, this month's pace, when you start chats, your plans' limits and the week's
 * work at API prices, drawn in the app's chunky ordered dither in each harness's own
 * colour. Everything but the week's work comes from data the phone already holds; that
 * one asks the server only once the section is on screen.
 */
import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { PROVIDER_DISPLAY_NAMES, type UsageProviderKind } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  harnessIdentityTint,
  harnessMascotAgentId,
  harnessMascotForDriver,
} from "@t3tools/shared/harnessMascots";
import { harnessMascotIdentity } from "@t3tools/shared/harnessThemes";
import {
  collectLimitAccounts,
  collectLimitPools,
  isUsageWindowAlmostOut,
  recentUseBySource,
} from "@t3tools/shared/usageLimits";
import { formatUsd, makeWindow } from "@t3tools/shared/usageFormat";
import { AsyncResult } from "effect/reactivity";
import { chatBackdropPalette } from "@t3tools/client-runtime/new-chat-dashboard";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import {
  PixelRatio,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type ViewInstance,
} from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { HarnessMascot } from "../../components/HarnessMascot";
import { ProviderIcon } from "../../components/ProviderIcon";
// oxlint-disable-next-line t3code/no-mobile-uniwind-theme-escape-hatches -- SVG paths take their colours as props.
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useThreadShells } from "../../state/entities";
import { environmentPresentations, threadListEnvironmentsAtom } from "../../state/presentation";
import { environmentServerConfigsAtom } from "../../state/server";
import { useUsage } from "../../state/usage";
import {
  LIMIT_TONE_COLOR,
  limitTone,
  resetsInLabel,
  summarizeProviderLimits,
  type ProviderLimits,
} from "../usage/limitsGlance";
import { useCountUp } from "../usage/UsageBestModels";
import { PROVIDER_LABEL } from "../usage/usageProviders";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { mosaicGap, snapToDots } from "./dither";
import { DitherHeatmap, DitherLayers, DitherPaceChart, useReveal } from "./ditherViews";
import { useArrived } from "./insightsViewport";
import { skyLayers, type SkyTone } from "./skyField";
import {
  HEATMAP_WEEKS,
  busiestHour,
  buildHomeInsights,
  formatChange,
  formatHour,
  localDayOrdinal,
  type HomeInsights as Insights,
} from "./homeInsightsData";

const CARD_PADDING = 16;
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
/** Family names for the pets' harnesses and makers. */
const HARNESS_LABEL: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  muse: "Muse",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
  kimi: "Kimi",
  mistral: "Mistral",
  acp: "Other agents",
  qwen: "Qwen",
  deepseek: "DeepSeek",
  gemini: "Gemini",
  glm: "GLM",
  minimax: "MiniMax",
  devin: "Devin",
};

/** Each usage source's harness, so its colour is its pet's, as everywhere in Insights. */
const USAGE_HARNESS: Record<UsageProviderKind, readonly [string, string | null]> = {
  claude: ["claudeAgent", null],
  codex: ["codex", null],
  grok: ["grok", null],
  cursor: ["cursor", null],
  opencode: ["opencode", null],
  antigravity: ["antigravity", null],
  pi: ["pi", null],
  muse: ["muse", null],
  vibe: ["acpRegistry", "mistral-vibe"],
  "qwen-code": ["acpRegistry", "qwen-code"],
  kimi: ["acpRegistry", "kimi"],
  hermes: ["acpRegistry", "deepseek"],
  devin: ["acpRegistry", "devin"],
};

function usageTint(provider: UsageProviderKind): string {
  const [driver, agentId] = USAGE_HARNESS[provider] ?? ["acpRegistry", null];
  return harnessIdentityTint(driver, agentId);
}

interface Harness {
  readonly key: string;
  readonly driver: string | null;
  readonly agentId: string | null;
  readonly tint: string;
  readonly label: string;
}

/* ─── Data ──────────────────────────────────────────────────────────── */

/** Which pet fronts each chat: its harness, or the maker of its model on a many-maker harness. */
export function useHarnessResolver() {
  const { providersByEnvironmentId } = useAtomValue(threadListEnvironmentsAtom);
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  return useMemo(() => {
    const harnesses = new Map<string, Harness>();
    const keyOf = (thread: Pick<EnvironmentThreadShell, "environmentId">) => {
      const shell = thread as EnvironmentThreadShell;
      const instanceId = shell.runtime?.providerInstanceId ?? shell.modelSelection?.instanceId;
      const driver =
        providersByEnvironmentId
          .get(shell.environmentId)
          ?.find((provider) => provider.instanceId === instanceId)?.driver ?? null;
      const identity = harnessMascotIdentity({
        driver,
        instanceId,
        model: shell.modelSelection?.model,
        agentId: harnessMascotAgentId(
          driver,
          instanceId
            ? serverConfigs.get(shell.environmentId)?.settings.providerInstances[
                instanceId as never
              ]?.config
            : undefined,
        ),
      });
      const mascot =
        harnessMascotForDriver(identity.driver, identity.agentId) ??
        harnessMascotForDriver("acpRegistry");
      const key = mascot?.id ?? "acp";
      if (!harnesses.has(key)) {
        harnesses.set(key, {
          key,
          driver: identity.driver,
          agentId: identity.agentId,
          tint: mascot?.tint ?? "#c4ad86",
          label: HARNESS_LABEL[key] ?? mascot?.name ?? "Other",
        });
      }
      return key;
    };
    return { keyOf, harnesses };
  }, [providersByEnvironmentId, serverConfigs]);
}

/**
 * Rebuilds only when a chat is started or the day turns: other updates to the loaded
 * chats (a turn finishing, a title) change nothing Insights shows.
 */
export function useHomeInsights() {
  const threads = useThreadShells();
  const resolver = useHarnessResolver();
  const now = Date.now();
  const today = localDayOrdinal(now);
  let latest = "";
  for (const thread of threads) if (thread.createdAt > latest) latest = thread.createdAt;
  const signature = `${today}|${threads.length}|${latest}`;
  const [state, setState] = useState(() => ({
    signature,
    resolver,
    insights: buildHomeInsights(threads, resolver.keyOf, now),
  }));
  if (state.signature !== signature || state.resolver !== resolver) {
    const next = { signature, resolver, insights: buildHomeInsights(threads, resolver.keyOf, now) };
    setState(next);
    return { insights: next.insights, harnesses: resolver.harnesses };
  }
  return { insights: state.insights, harnesses: resolver.harnesses };
}

/* ─── Motion ────────────────────────────────────────────────────────── */

/** A card and whether it has scrolled into view yet. */
function useCard() {
  const ref = useRef<ViewInstance>(null);
  return { ref, arrived: useArrived(ref) };
}

/** Counts up from zero once `arrived`. */
function useArrivalCount(target: number, arrived: boolean): number {
  return useCountUp(arrived ? target : 0, true);
}

/** 0 to 1 once `arrived`, after `delay`, for one thing inside a card. */
function useArrivalProgress(arrived: boolean, delay: number, duration = 700) {
  return useReveal(arrived, delay, duration);
}

/** Rises in after `index` steps once its card has arrived. */
function Stagger({
  index,
  arrived,
  children,
  style,
}: {
  index: number;
  arrived: boolean;
  children: ReactNode;
  style?: object;
}) {
  const progress = useArrivalProgress(arrived, 160 + index * 70, 520);
  const motion = useAnimatedStyle(() => ({
    opacity: progress.get(),
    transform: [{ translateY: (1 - progress.get()) * 10 }],
  }));
  return <Animated.View style={[style, motion]}>{children}</Animated.View>;
}

/* ─── Cards ─────────────────────────────────────────────────────────── */

function Card({
  cardRef,
  arrived,
  children,
  onPress,
  accessibilityLabel,
  flex = false,
}: {
  cardRef: RefObject<ViewInstance | null>;
  arrived: boolean;
  children: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  flex?: boolean;
}) {
  const reduced = useReducedMotion();
  const shown = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (!arrived) return;
    shown.set(
      withTiming(1, {
        duration: 680,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [arrived, shown]);
  // Rises a little, settles from slightly small, and comes up out of the dark.
  const motion = useAnimatedStyle(() => ({
    opacity: shown.get(),
    transform: [{ translateY: (1 - shown.get()) * 30 }, { scale: 0.96 + 0.04 * shown.get() }],
  }));
  const body = (
    <View className="border-border bg-card" style={[styles.card, flex && { flex: 1 }]}>
      {children}
    </View>
  );
  return (
    <View ref={cardRef} collapsable={false} style={flex ? { flex: 1 } : undefined}>
      <Animated.View style={[motion, flex && { flex: 1 }]}>
        {onPress ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={accessibilityLabel}
            onPress={onPress}
            style={({ pressed }) => ({
              flex: flex ? 1 : undefined,
              transform: [{ scale: pressed ? 0.98 : 1 }],
              opacity: pressed ? 0.85 : 1,
            })}
          >
            {body}
          </Pressable>
        ) : (
          body
        )}
      </Animated.View>
    </View>
  );
}

function CardTitle({ title, caption }: { title: string; caption?: string }) {
  return (
    <View style={styles.titleRow}>
      <Text className="text-foreground" style={styles.title}>
        {title}
      </Text>
      {caption ? (
        <Text className="text-foreground-tertiary" style={styles.caption}>
          {caption}
        </Text>
      ) : null}
    </View>
  );
}

function Figure({
  value,
  label,
  detail,
  arrived,
  accent,
}: {
  value: number;
  label: string;
  detail?: string;
  arrived: boolean;
  accent?: string;
}) {
  const counted = useArrivalCount(value, arrived);
  return (
    <View
      style={{ flex: 1 }}
      accessible
      accessibilityLabel={`${label}: ${value.toLocaleString()}${detail ? `, ${detail}` : ""}`}
    >
      <Text className="text-foreground-muted" style={styles.caption}>
        {label}
      </Text>
      <Text
        className={accent ? undefined : "text-foreground"}
        style={[styles.figure, accent ? { color: accent } : null]}
      >
        {Math.round(counted).toLocaleString()}
      </Text>
      {detail ? (
        <Text className="text-foreground-tertiary" numberOfLines={1} style={styles.small}>
          {detail}
        </Text>
      ) : null}
    </View>
  );
}

/** Today, this week and the streak, the streak lit in your harness's colour while it runs. */
function TodayCard({ insights, tint }: { insights: Insights; tint: string }) {
  const { ref, arrived } = useCard();
  return (
    <Card cardRef={ref} arrived={arrived}>
      <View style={{ flexDirection: "row", gap: 12 }}>
        <Figure
          label="Today"
          value={insights.today}
          detail={insights.today === 1 ? "chat started" : "chats started"}
          arrived={arrived}
        />
        <Figure
          label="This week"
          value={insights.week.chats}
          detail={formatChange(insights.week.chats, insights.week.previous, "week")}
          arrived={arrived}
        />
        <Figure
          label="Streak"
          value={insights.streak}
          detail={insights.streak === 1 ? "day" : "days in a row"}
          arrived={arrived}
          accent={insights.streak >= 3 ? tint : undefined}
        />
      </View>
    </Card>
  );
}

/**
 * Weeks back to the first chat loaded and one more, at least 8 so a new phone still has a
 * shape, at most HEATMAP_WEEKS: the grid is the history there is, not months of blanks.
 */
function activityWeeks(insights: Insights): number {
  const first = insights.days.findIndex((day) => day.count > 0);
  if (first < 0) return 8;
  const used = HEATMAP_WEEKS - Math.floor(first / 7);
  return Math.max(8, Math.min(HEATMAP_WEEKS, used + 1));
}

/** Recent weeks of chats: each day in the colour of the harness it used most, as full as it was busy. */
function ActivityCard({
  insights,
  harnesses,
}: {
  insights: Insights;
  harnesses: ReadonlyMap<string, Harness>;
}) {
  const { ref, arrived } = useCard();
  const progress = useArrivalProgress(arrived, 180, 1200);
  const weeks = activityWeeks(insights);
  const days = useMemo(
    () =>
      insights.days.slice((HEATMAP_WEEKS - weeks) * 7).map((day) => ({
        level: day.level,
        future: day.future,
        shares: day.mix.slice(0, 1).map((entry) => ({
          color: harnesses.get(entry.key)?.tint ?? "#c4ad86",
          share: 1,
        })),
      })),
    [harnesses, insights.days, weeks],
  );
  const total = useArrivalCount(insights.total, arrived);
  return (
    <Card cardRef={ref} arrived={arrived}>
      <CardTitle title="Activity" caption={`${weeks} weeks`} />
      <DitherHeatmap
        days={days}
        weeks={weeks}
        maxCell={28}
        progress={progress}
        accessibilityLabel={`${insights.total} chats started across ${insights.activeDays} active days in the last ${weeks} weeks`}
      />
      <Text className="text-foreground-muted" style={[styles.caption, { marginTop: 12 }]}>
        {Math.round(total).toLocaleString()} {insights.total === 1 ? "chat" : "chats"} ·{" "}
        {insights.activeDays} active {insights.activeDays === 1 ? "day" : "days"}
      </Text>
    </Card>
  );
}

/** One harness's part of a bar, growing in from the left once its card arrives. */
function GrowSegment({
  color,
  weight,
  index,
  arrived,
}: {
  color: string;
  weight: number;
  index: number;
  arrived: boolean;
}) {
  const progress = useArrivalProgress(arrived, 140 + index * 110, 620);
  const motion = useAnimatedStyle(() => ({ transform: [{ scaleX: progress.get() }] }));
  return (
    <View style={{ flex: weight, height: "100%" }}>
      <Animated.View
        style={[
          { flex: 1, borderRadius: 4, backgroundColor: color, transformOrigin: "left" },
          motion,
        ]}
      />
    </View>
  );
}

/** The last 30 days by harness: one bar of the top four and the rest, and the pets behind it. */
function HarnessCard({
  insights,
  harnesses,
}: {
  insights: Insights;
  harnesses: ReadonlyMap<string, Harness>;
}) {
  const { ref, arrived } = useCard();
  const theme = useUniwindTheme();
  const muted = String(theme["--color-foreground-tertiary"]);
  const total = insights.harnesses.reduce((sum, entry) => sum + entry.count, 0);
  const top = insights.harnesses.slice(0, 4);
  const rest = insights.harnesses.slice(4).reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return null;
  const segments = top.map((entry) => ({
    key: entry.key,
    count: entry.count,
    color: harnesses.get(entry.key)?.tint ?? "#c4ad86",
  }));
  if (rest > 0) segments.push({ key: "rest", count: rest, color: muted });
  return (
    <Card cardRef={ref} arrived={arrived}>
      <CardTitle title="Harnesses" caption="30 days" />
      <View style={styles.segmentBar}>
        {segments.map((segment, index) => (
          <GrowSegment
            key={segment.key}
            color={segment.color}
            weight={segment.count}
            index={index}
            arrived={arrived}
          />
        ))}
      </View>
      <View style={{ marginTop: 14, gap: 10 }}>
        {top.map((entry, index) => {
          const harness = harnesses.get(entry.key);
          const share = Math.round((entry.count / total) * 100);
          return (
            <Stagger key={entry.key} index={index + 1} arrived={arrived}>
              <View
                style={styles.legendRow}
                accessible
                accessibilityLabel={`${harness?.label ?? entry.key}: ${entry.count} chats, ${share} percent`}
              >
                <View style={styles.pet}>
                  <HarnessMascot
                    driver={harness?.driver ?? null}
                    agentId={harness?.agentId ?? null}
                    size={26}
                    visible={arrived}
                  />
                </View>
                <Text
                  className="text-foreground"
                  numberOfLines={1}
                  style={[styles.body, { flex: 1 }]}
                >
                  {harness?.label ?? entry.key}
                </Text>
                <Text className="text-foreground-tertiary" style={styles.caption}>
                  {entry.count.toLocaleString()}
                </Text>
                <Text
                  style={[
                    styles.caption,
                    styles.share,
                    { color: harness?.tint ?? undefined, fontWeight: "600" },
                  ]}
                >
                  {share}%
                </Text>
              </View>
            </Stagger>
          );
        })}
        {rest > 0 ? (
          <Stagger index={top.length + 1} arrived={arrived}>
            <Text className="text-foreground-tertiary" style={styles.small}>
              +{rest.toLocaleString()} on {insights.harnesses.length - top.length} more
            </Text>
          </Stagger>
        ) : null}
      </View>
    </Card>
  );
}

/** This month's running total against last month's, the line drawing itself over its light. */
function PaceCard({ insights, tint }: { insights: Insights; tint: string }) {
  const { ref, arrived } = useCard();
  const progress = useArrivalProgress(arrived, 260, 1300);
  const counted = useArrivalCount(insights.month.chats, arrived);
  return (
    <Card cardRef={ref} arrived={arrived} flex>
      <CardTitle title="This month" />
      <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6 }}>
        <Text className="text-foreground" style={styles.figure}>
          {Math.round(counted).toLocaleString()}
        </Text>
        <Text
          className="text-foreground-tertiary"
          numberOfLines={1}
          style={[styles.small, { flex: 1 }]}
        >
          {formatChange(insights.month.chats, insights.month.previous, "month")}
        </Text>
      </View>
      <View style={{ marginTop: 8, flex: 1, justifyContent: "flex-end" }}>
        <DitherPaceChart pace={insights.pace} tint={tint} height={56} progress={progress} />
      </View>
      <Text className="text-foreground-tertiary" style={[styles.small, { marginTop: 4 }]}>
        vs. {insights.pace.previousMonth}
      </Text>
    </Card>
  );
}

/** One hour's bar, rising from the floor after its neighbours to its left. */
function HourBar({
  height,
  color,
  index,
  progress,
}: {
  height: number;
  color: string;
  index: number;
  progress: SharedValue<number>;
}) {
  const motion = useAnimatedStyle(() => {
    const local = Math.min(1, Math.max(0, progress.get() * 1.6 - index * 0.025));
    return { transform: [{ scaleY: 1 - (1 - local) ** 3 }] };
  });
  return (
    <View style={{ flex: 1, height: "100%", justifyContent: "flex-end" }}>
      <Animated.View
        style={[
          {
            height,
            backgroundColor: color,
            borderTopLeftRadius: 2,
            borderTopRightRadius: 2,
            transformOrigin: "bottom",
          },
          motion,
        ]}
      />
    </View>
  );
}

/** The hours you start chats in, over 30 days, the busiest lit in your harness's colour. */
function HoursCard({ insights, tint }: { insights: Insights; tint: string }) {
  const { ref, arrived } = useCard();
  const progress = useArrivalProgress(arrived, 320, 1100);
  const peak = busiestHour(insights.hours);
  const most = Math.max(1, ...insights.hours);
  const height = 56;
  const dim = `${tint}55`;
  return (
    <Card cardRef={ref} arrived={arrived} flex>
      <CardTitle title="Your hours" />
      <Text className="text-foreground" numberOfLines={1} style={styles.body}>
        {peak === null ? "No chats yet" : `Busiest at ${formatHour(peak)}`}
      </Text>
      <View
        style={{ flexDirection: "row", gap: 2, height, marginTop: 10 }}
        accessibilityElementsHidden
      >
        {insights.hours.map((count, hour) => (
          <HourBar
            key={formatHour(hour)}
            index={hour}
            progress={progress}
            height={count === 0 ? 2 : Math.max(4, (count / most) * height)}
            color={hour === peak ? tint : count === 0 ? `${tint}22` : dim}
          />
        ))}
      </View>
      <View style={styles.hourAxis}>
        {(["12a", "6a", "12p", "6p"] as const).map((label) => (
          <Text key={label} className="text-foreground-tertiary" style={[styles.tiny, { flex: 1 }]}>
            {label}
          </Text>
        ))}
      </View>
    </Card>
  );
}

/** One line of the Plan limits card: a plan's tightest window, or its note when it has none. */
type PlanLine =
  | {
      readonly kind: "bar";
      readonly key: string;
      readonly name: string;
      readonly limits: ProviderLimits;
    }
  | {
      readonly kind: "note";
      readonly key: string;
      readonly name: string;
      readonly driver: string;
      readonly note: string;
    };

/**
 * Every plan, as Usage lists them: this card is the overview, so the status row's ring
 * choices (hidden, combined) don't apply here. A plan its probe can't read keeps a line
 * with its note.
 */
function usePlanLimits() {
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(interval);
  }, []);
  const lines = useMemo(() => {
    const pools = collectLimitPools(
      collectLimitAccounts(presentations, { withNotices: true }),
      now,
      recentUseBySource(presentations),
    );
    const summaries = new Map(
      summarizeProviderLimits(pools).map((entry) => [entry.pool.key, entry]),
    );
    return pools.flatMap((pool): PlanLine[] => {
      const summary = summaries.get(pool.key);
      const only = pool.accounts.length === 1 ? pool.accounts[0] : undefined;
      const bar: PlanLine[] = summary
        ? [
            {
              kind: "bar",
              key: pool.key,
              name:
                pool.label ??
                only?.displayName ??
                PROVIDER_DISPLAY_NAMES[pool.driver] ??
                String(pool.driver),
              limits: summary,
            },
          ]
        : [];
      const notes = pool.unread.map((account): PlanLine => ({
        kind: "note",
        key: account.key,
        name:
          account.displayName ?? PROVIDER_DISPLAY_NAMES[account.driver] ?? String(account.driver),
        driver: String(account.driver),
        note: account.notice ?? "",
      }));
      return [...bar, ...notes];
    });
  }, [now, presentations]);
  return { lines, now };
}

/** One plan's tightest window: a slim bar that fills to its share in its tone. */
function LimitBar({
  usedPercent,
  almostOut,
  arrived,
  delay,
}: {
  usedPercent: number;
  almostOut: boolean;
  arrived: boolean;
  delay: number;
}) {
  const progress = useArrivalProgress(arrived, delay, 900);
  const used = Math.min(almostOut ? 99 : 100, Math.max(0, usedPercent));
  const color = LIMIT_TONE_COLOR[limitTone(used)];
  const motion = useAnimatedStyle(() => ({ transform: [{ scaleX: progress.get() }] }));
  return (
    <View className="bg-border" style={styles.limitTrack}>
      <Animated.View
        style={[
          {
            width: `${used}%`,
            height: "100%",
            borderRadius: 3,
            backgroundColor: color,
            transformOrigin: "left",
          },
          motion,
        ]}
      />
    </View>
  );
}

function LimitRow({
  name,
  driver,
  detail,
  usedPercent,
  almostOut,
  arrived,
  index,
  accessibilityLabel,
}: {
  name: string;
  driver: string;
  detail: string;
  usedPercent: number;
  almostOut: boolean;
  arrived: boolean;
  index: number;
  accessibilityLabel: string;
}) {
  const counted = useArrivalCount(Math.round(usedPercent), arrived);
  const tone = LIMIT_TONE_COLOR[limitTone(usedPercent)];
  return (
    <Stagger index={index} arrived={arrived}>
      <View accessible accessibilityLabel={accessibilityLabel}>
        <View style={styles.legendRow}>
          <ProviderIcon provider={driver} size={14} />
          <Text className="text-foreground" numberOfLines={1} style={styles.caption}>
            {name}
          </Text>
          <Text
            className="text-foreground-tertiary"
            numberOfLines={1}
            style={[styles.small, { flex: 1 }]}
          >
            {detail}
          </Text>
          <Text
            className={usedPercent >= 80 ? undefined : "text-foreground"}
            style={[
              styles.caption,
              styles.share,
              { fontWeight: "600" },
              usedPercent >= 80 ? { color: tone } : null,
            ]}
          >
            {Math.round(counted)}%
          </Text>
        </View>
        <LimitBar
          usedPercent={usedPercent}
          almostOut={almostOut}
          arrived={arrived}
          delay={260 + index * 80}
        />
      </View>
    </Stagger>
  );
}

/** Each plan's limit closest to running out, with names and resets; every plan, as on Usage. */
function LimitsCard({ onOpen }: { onOpen: () => void }) {
  const { ref, arrived } = useCard();
  const { lines, now } = usePlanLimits();
  if (lines.length === 0) return null;
  return (
    <Card
      cardRef={ref}
      arrived={arrived}
      onPress={onOpen}
      accessibilityLabel="Plan limits. Opens Usage."
    >
      <CardTitle title="Plan limits" caption="Usage ›" />
      <View style={{ gap: 14 }}>
        {lines.map((line, index) => {
          if (line.kind === "note") {
            return (
              <Stagger key={line.key} index={index} arrived={arrived}>
                <View
                  accessible
                  accessibilityLabel={`${line.name}: ${line.note}`}
                  style={styles.legendRow}
                >
                  <ProviderIcon provider={line.driver} size={14} />
                  <Text className="text-foreground" numberOfLines={1} style={styles.caption}>
                    {line.name}
                  </Text>
                  <Text
                    className="text-foreground-tertiary"
                    numberOfLines={2}
                    style={[styles.small, { flex: 1 }]}
                  >
                    {line.note}
                  </Text>
                </View>
              </Stagger>
            );
          }
          const tightest = line.limits.tightest;
          const resets = resetsInLabel(tightest, now);
          return (
            <LimitRow
              key={line.key}
              name={line.name}
              driver={line.limits.driver}
              detail={`${tightest.label}${resets ? ` · ${resets}` : ""}`}
              usedPercent={tightest.usedPercent}
              almostOut={isUsageWindowAlmostOut(tightest)}
              arrived={arrived}
              index={index}
              accessibilityLabel={`${line.name}, ${tightest.label}: ${Math.round(tightest.usedPercent)}% used${resets ? `, ${resets.toLowerCase()}` : ""}`}
            />
          );
        })}
      </View>
    </Card>
  );
}

function localDayKey(ordinal: number) {
  const date = new Date(ordinal * 86_400_000);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

/** One day's column of work, its providers stacked, rising after the days before it. */
function WorkColumn({
  parts,
  height,
  index,
  progress,
  quiet,
}: {
  parts: ReadonlyArray<{ readonly color: string; readonly height: number }>;
  height: number;
  index: number;
  progress: SharedValue<number>;
  quiet: string;
}) {
  const motion = useAnimatedStyle(() => {
    const local = Math.min(1, Math.max(0, progress.get() * 1.5 - index * 0.07));
    return { transform: [{ scaleY: 1 - (1 - local) ** 3 }] };
  });
  const total = parts.reduce((sum, part) => sum + part.height, 0);
  return (
    <View style={{ flex: 1, height, justifyContent: "flex-end" }}>
      {total <= 0 ? (
        <View style={{ height: 2, borderRadius: 1, backgroundColor: quiet, opacity: 0.5 }} />
      ) : (
        <Animated.View
          style={[
            {
              height: total,
              borderTopLeftRadius: 5,
              borderTopRightRadius: 5,
              overflow: "hidden",
              gap: 1.5,
              transformOrigin: "bottom",
            },
            motion,
          ]}
        >
          {parts.map((part) => (
            <View
              key={part.color}
              style={{ height: Math.max(2, part.height - 1.5), backgroundColor: part.color }}
            />
          ))}
        </Animated.View>
      )}
    </View>
  );
}

/** The week's work at API prices by day and provider, and the month's top models. */
function WorkCard({ onOpen }: { onOpen: () => void }) {
  const { ref, arrived } = useCard();
  const theme = useUniwindTheme();
  const quiet = String(theme["--color-foreground-tertiary"]);
  const today = localDayOrdinal(Date.now());
  // The Usage page's own 30-day window, so the two share one answer from the server.
  const window = useMemo(() => makeWindow(30), [today]);
  const { merged, isPending } = useUsage(window);
  const height = 78;
  const progress = useArrivalProgress(arrived && !isPending, 120, 1000);
  const days = useMemo(() => {
    const byDay = new Map(merged.daily.map((day) => [day.day, day]));
    return Array.from({ length: 7 }, (_, index) => {
      const ordinal = today - 6 + index;
      return { ordinal, totals: byDay.get(localDayKey(ordinal)) };
    });
  }, [merged.daily, today]);
  const week = days.reduce((sum, day) => sum + (day.totals?.costUsd ?? 0), 0);
  const counted = useArrivalCount(week, arrived && !isPending);
  const order = useMemo(() => {
    const totals = new Map<UsageProviderKind, number>();
    for (const day of days)
      for (const [provider, value] of day.totals?.byProvider ?? [])
        totals.set(provider, (totals.get(provider) ?? 0) + value.costUsd);
    return [...totals].filter(([, cost]) => cost > 0).sort((left, right) => right[1] - left[1]);
  }, [days]);
  const columns = useMemo(() => {
    const most = Math.max(...days.map((day) => day.totals?.costUsd ?? 0), 0.01);
    return days.map((day) => {
      // Largest provider at the base, as the legend reads: the column is drawn top down.
      // Slivers too thin to see as their own colour gather in one quiet cap.
      const parts: { color: string; height: number }[] = [];
      let slivers = 0;
      for (const [provider] of order) {
        const value = day.totals?.byProvider.get(provider)?.costUsd ?? 0;
        if (value <= 0) continue;
        const part = (value / most) * height;
        if (part < 5) slivers += part;
        else parts.unshift({ color: usageTint(provider), height: part });
      }
      if (slivers > 0) parts.unshift({ color: quiet, height: Math.max(3, slivers) });
      return { ordinal: day.ordinal, parts };
    });
  }, [days, order, quiet]);
  const models = merged.models.filter((model) => model.costUsd > 0).slice(0, 3);
  if (!isPending && merged.records === 0) return null;
  return (
    <Card
      cardRef={ref}
      arrived={arrived}
      onPress={onOpen}
      accessibilityLabel={`Work this week at API prices: ${formatUsd(week)}. Opens Usage.`}
    >
      <CardTitle title="Work this week" caption="at API prices" />
      <Text className="text-foreground" style={styles.figure}>
        {isPending ? "Counting…" : formatUsd(counted)}
      </Text>
      <View
        style={{ flexDirection: "row", gap: 8, height, marginTop: 12 }}
        accessibilityElementsHidden
      >
        {columns.map((column, index) => (
          <WorkColumn
            key={column.ordinal}
            parts={column.parts}
            height={height}
            index={index}
            progress={progress}
            quiet={quiet}
          />
        ))}
      </View>
      <View style={styles.weekAxis}>
        {days.map((day) => (
          <Text
            key={day.ordinal}
            className={day.ordinal === today ? "text-foreground" : "text-foreground-tertiary"}
            style={[styles.tiny, { flex: 1, textAlign: "center" }]}
          >
            {WEEKDAYS[new Date(day.ordinal * 86_400_000).getUTCDay()]}
          </Text>
        ))}
      </View>
      {order.length > 0 ? (
        <View style={styles.providerLegend}>
          {order.slice(0, 4).map(([provider]) => (
            <View key={provider} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <View
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  backgroundColor: usageTint(provider),
                }}
              />
              <Text className="text-foreground-muted" style={styles.small}>
                {PROVIDER_LABEL[provider]}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
      {models.length > 0 ? (
        <View style={{ marginTop: 14, gap: 9 }}>
          <Text className="text-foreground-tertiary" style={styles.small}>
            Top models · 30 days
          </Text>
          {models.map((model, index) => (
            <Stagger key={`${model.provider}:${model.model}`} index={index + 2} arrived={arrived}>
              <View style={styles.legendRow}>
                <ProviderIcon
                  provider={model.provider === "claude" ? "claudeAgent" : model.provider}
                  size={14}
                />
                <Text
                  className="text-foreground"
                  numberOfLines={1}
                  style={[styles.caption, { flex: 1 }]}
                >
                  {model.model}
                </Text>
                <Text className="text-foreground-muted" style={styles.caption}>
                  {formatUsd(model.costUsd)}
                </Text>
              </View>
            </Stagger>
          ))}
        </View>
      ) : null}
    </Card>
  );
}

/* ─── Section ───────────────────────────────────────────────────────── */

const DAWN_HEIGHT = 150;

/**
 * Where Insights begin: a bank of fog in the colours of the month's harnesses, the same
 * light as the sky over the chats, dissolving in as the section comes into view.
 */
function InsightsHeader({
  insights,
  harnesses,
}: {
  insights: Insights;
  harnesses: ReadonlyMap<string, Harness>;
}) {
  const { ref, arrived } = useCard();
  const { width: screenWidth } = useWindowDimensions();
  const width = snapToDots(screenWidth);
  const { themeAppearance } = useAppearancePreferences();
  const dark = themeAppearance === "dark";
  const progress = useArrivalProgress(arrived, 0, 1500);
  const recent = insights.harnesses.reduce((sum, entry) => sum + entry.count, 0);
  const toneKey = insights.harnesses
    .filter((entry, index) => index === 0 || entry.count >= recent * 0.1)
    .slice(0, 3)
    .map((entry) => `${entry.key}:${entry.count}`)
    .join("|");
  const gap = mosaicGap(PixelRatio.get());
  const layers = useMemo(() => {
    if (!arrived || width === 0) return null;
    const tones: SkyTone[] = toneKey
      .split("|")
      .filter(Boolean)
      .map((part) => {
        const [key, count] = part.split(":");
        const harness = harnesses.get(key ?? "");
        const palette = chatBackdropPalette(
          harness?.driver ?? "claudeAgent",
          harness?.agentId ?? null,
        );
        return {
          glow: palette.glow,
          rim: dark ? palette.rimDark : palette.rimLight,
          share: Number(count),
        };
      });
    if (tones.length === 0) return null;
    return skyLayers(width, DAWN_HEIGHT, tones, 0.5, gap);
  }, [arrived, dark, gap, harnesses, toneKey, width]);
  const first = insights.days.find((day) => day.count > 0);
  const since = first
    ? new Date(first.ordinal * 86_400_000).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
    : null;
  const headingMotion = useAnimatedStyle(() => ({
    opacity: Math.min(1, progress.get() * 2),
    transform: [{ translateY: (1 - Math.min(1, progress.get() * 1.6)) * 12 }],
  }));
  return (
    <View ref={ref} collapsable={false} style={styles.header}>
      {layers ? (
        <View pointerEvents="none" style={[styles.dawn, { width }]}>
          <View style={[StyleSheet.absoluteFill, { opacity: dark ? 0.6 : 0.5 }]}>
            <DitherLayers
              width={width}
              height={DAWN_HEIGHT}
              layers={layers.glow}
              progress={progress}
            />
          </View>
          <View style={[StyleSheet.absoluteFill, { opacity: dark ? 0.7 : 0.56 }]}>
            <DitherLayers
              width={width}
              height={DAWN_HEIGHT}
              layers={layers.rim}
              progress={progress}
            />
          </View>
        </View>
      ) : null}
      <Animated.View style={headingMotion}>
        <Text className="text-foreground" style={styles.heading} accessibilityRole="header">
          Insights
        </Text>
        {since ? (
          <Text className="text-foreground-muted" style={styles.subheading}>
            Since {since} · {insights.total.toLocaleString()}{" "}
            {insights.total === 1 ? "chat" : "chats"}
          </Text>
        ) : null}
      </Animated.View>
    </View>
  );
}

/**
 * Past the end of the chat list. `revealed` turns on once the section is near; each card
 * then rises in as it scrolls into view, and its charts draw themselves.
 */
export const HomeInsights = memo(function HomeInsights({ revealed }: { revealed: boolean }) {
  const navigation = useNavigation();
  const { insights, harnesses } = useHomeInsights();
  const lead = insights.harnesses[0]?.key;
  const tint = (lead ? harnesses.get(lead)?.tint : undefined) ?? "#d97757";
  const openUsage = (tab: "usage" | "limits") =>
    navigation.navigate(
      ...([
        "SettingsSheet",
        { screen: "SettingsContent", params: { screen: "SettingsUsage", params: { tab } } },
      ] as never),
    );
  if (!revealed) {
    // Room for the cards, so the list does not jump when they mount.
    return <View style={{ height: 320 }} testID="home-insights" />;
  }
  return (
    <View style={styles.section} testID="home-insights">
      <InsightsHeader insights={insights} harnesses={harnesses} />
      <View style={{ gap: 12 }}>
        <TodayCard insights={insights} tint={tint} />
        <ActivityCard insights={insights} harnesses={harnesses} />
        <HarnessCard insights={insights} harnesses={harnesses} />
        <View style={{ flexDirection: "row", gap: 12 }}>
          <PaceCard insights={insights} tint={tint} />
          <HoursCard insights={insights} tint={tint} />
        </View>
        <LimitsCard onOpen={() => openUsage("limits")} />
        <WorkCard onOpen={() => openUsage("usage")} />
        <Text
          className="text-foreground-tertiary"
          style={[styles.small, { textAlign: "center", marginTop: 6 }]}
        >
          From the chats loaded on this phone
        </Text>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  section: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8 },
  header: { paddingTop: 44, paddingBottom: 18, paddingHorizontal: 4 },
  dawn: { position: "absolute", top: 0, left: -16, height: DAWN_HEIGHT },
  heading: { fontSize: 30, fontWeight: "700", letterSpacing: -0.6 },
  subheading: { fontSize: 13, marginTop: 2, fontVariant: ["tabular-nums"] },
  card: {
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    padding: CARD_PADDING,
    overflow: "hidden",
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    marginBottom: 12,
    gap: 6,
  },
  title: { fontSize: 15, fontWeight: "600", letterSpacing: -0.2 },
  body: { fontSize: 14 },
  caption: { fontSize: 12, fontVariant: ["tabular-nums"] },
  small: { fontSize: 11, lineHeight: 14, fontVariant: ["tabular-nums"] },
  tiny: { fontSize: 10, fontVariant: ["tabular-nums"] },
  figure: { fontSize: 28, fontWeight: "600", fontVariant: ["tabular-nums"], letterSpacing: -0.6 },
  legendRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  pet: { width: 28, height: 28, alignItems: "center", justifyContent: "center" },
  share: { width: 40, textAlign: "right" },
  segmentBar: { flexDirection: "row", gap: 3, height: 8 },
  limitTrack: { height: 6, borderRadius: 3, marginTop: 7, overflow: "hidden" },
  hourAxis: { flexDirection: "row", marginTop: 6 },
  weekAxis: { flexDirection: "row", gap: 8, marginTop: 6 },
  providerLegend: { flexDirection: "row", flexWrap: "wrap", gap: 12, marginTop: 12 },
});
