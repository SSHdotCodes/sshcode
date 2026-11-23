import type { EnvironmentId, UsageProviderKind } from "@t3tools/contracts";
import {
  describePick,
  describePlan,
  pickBarShare,
  pickRouteIcon,
  picksBasis,
  pickTitle,
  pickValueText,
} from "@t3tools/shared/modelPickEvidence";
import {
  MODEL_PICK_KINDS,
  type ModelPick,
  type ModelPickKind,
  type ModelPicks,
  type PickRoute,
} from "@t3tools/shared/modelPicks";
import { useEffect, useMemo, useRef, useState } from "react";
import { PixelRatio, ScrollView, useWindowDimensions, View } from "react-native";
import Animated, {
  FadeIn,
  FadeInDown,
  ReduceMotion,
  useReducedMotion,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ProviderIcon } from "../../components/ProviderIcon";
import { DitherCanvas, DOT, mosaicGap, type DitherLayer } from "../home/dither";
import { useModelPicks } from "./useModelPicks";

const KIND_STYLE: Record<
  ModelPickKind,
  { readonly color: string; readonly symbol: AppSymbolName }
> = {
  quality: { color: "#8c7bd1", symbol: "star.fill" },
  value: { color: "#4d9f8a", symbol: "chart.bar.xaxis" },
  speed: { color: "#e8a33d", symbol: "bolt.fill" },
  frugal: { color: "#5b9bbd", symbol: "arrow.down.circle" },
};

// The icon component is keyed by provider driver; usage names a few of them differently.
const USAGE_ICON: Record<UsageProviderKind, string> = {
  claude: "claudeAgent",
  codex: "codex",
  grok: "grok",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
  pi: "pi",
  muse: "muse",
  vibe: "acpRegistry",
  "qwen-code": "acpRegistry",
  kimi: "acpRegistry",
  hermes: "acpRegistry",
  devin: "acpRegistry",
};

// The glow ends above the model name, so the texture never sits under text to be read.
const DITHER_HEIGHT = 55;
const DITHER_REACH = 0.55;
const COUNT_MS = 700;

/**
 * A dithered tile-mosaic glow for a card's top right corner: 5pt square tiles separated by
 * whole-device-pixel hairlines, fraying out in Bayer order toward the card's interior.
 */
function mosaicGlowLayers(width: number, color: string, gap: number): DitherLayer[] {
  const columns = Math.ceil(width / DOT);
  const rows = Math.ceil(DITHER_HEIGHT / DOT);
  const canvas = new DitherCanvas(1, gap);
  canvas.paint(
    columns,
    rows,
    (column, row) => {
      const x = (column + 0.5) / columns;
      const y = (row + 0.5) / rows;
      const distance = Math.hypot((1 - x) / DITHER_REACH, y);
      return 0.7 * Math.max(0, 1 - distance) ** 1.5;
    },
    () => color,
  );
  return canvas.layers();
}

/** Eases a figure to its target from zero; jumps there when the system asks for less motion. */
export function useCountUp(target: number, animate: boolean): number {
  const still = useReducedMotion() || !animate;
  const [value, setValue] = useState(still ? target : 0);
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  });
  useEffect(() => {
    const from = valueRef.current;
    if (still || !Number.isFinite(target) || from === target) {
      setValue(target);
      return;
    }
    const start = Date.now();
    let frame = requestAnimationFrame(function step() {
      const progress = Math.min(1, (Date.now() - start) / COUNT_MS);
      setValue(from + (target - from) * (1 - (1 - progress) ** 4));
      if (progress < 1) frame = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(frame);
  }, [still, target]);
  return value;
}

function routeIconProvider(route: PickRoute): string | null {
  const icon = pickRouteIcon(route);
  if (icon === null) return null;
  return "usage" in icon ? USAGE_ICON[icon.usage] : icon.driver;
}

function PickCard(props: {
  readonly pick: ModelPick;
  readonly picks: ModelPicks;
  readonly index: number;
  readonly width: number;
}) {
  const { pick, picks } = props;
  const style = KIND_STYLE[pick.kind];
  const description = describePick(pick, picks);
  const counted = useCountUp(description?.headline.value ?? 0, description?.headline.value != null);
  const gap = mosaicGap(PixelRatio.get());
  const dither = useMemo(
    () => mosaicGlowLayers(props.width, style.color, gap),
    [gap, props.width, style.color],
  );
  const winner = pick.winner;
  const runners = pick.ranked.slice(1, 3);
  const iconProvider = winner ? routeIconProvider(winner.route) : null;

  return (
    <Animated.View
      entering={FadeInDown.delay(props.index * 70)
        .duration(420)
        .reduceMotion(ReduceMotion.System)}
      style={{ width: props.width }}
      className="overflow-hidden rounded-[24px] border-continuous bg-grouped-card"
    >
      <Animated.View
        entering={FadeIn.delay(180 + props.index * 70)
          .duration(700)
          .reduceMotion(ReduceMotion.System)}
        pointerEvents="none"
        style={{ position: "absolute", top: 0, right: 0, opacity: 0.85 }}
      >
        <Svg width={props.width} height={DITHER_HEIGHT}>
          {dither.map((layer) => (
            <Path
              key={`${layer.color}:${layer.opacity}`}
              d={layer.d}
              fill={layer.color}
              fillOpacity={layer.opacity}
            />
          ))}
        </Svg>
      </Animated.View>
      <View className="flex-1 gap-2.5 p-4">
        <View className="flex-row items-center justify-between gap-2">
          <View className="flex-row items-center gap-1.5">
            <SymbolView name={style.symbol} size={13} tintColor={style.color} />
            <Text className="text-xs font-t3-medium uppercase tracking-wider text-foreground-muted">
              {pickTitle(pick.kind)}
            </Text>
          </View>
          {description?.badge ? (
            <View
              className="rounded-full border px-2 py-0.5"
              style={{ borderColor: `${style.color}73` }}
            >
              <Text className="text-2xs font-t3-medium" style={{ color: style.color }}>
                {description.badge}
              </Text>
            </View>
          ) : null}
        </View>

        {winner && description ? (
          <>
            <View className="gap-0.5">
              <View className="flex-row items-center gap-2">
                {iconProvider ? <ProviderIcon provider={iconProvider} size={16} /> : null}
                <Text
                  className="min-w-0 flex-1 text-lg font-t3-medium text-foreground"
                  numberOfLines={1}
                >
                  {winner.label}
                </Text>
              </View>
              <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
                {winner.route.routeLabel}
              </Text>
            </View>
            <View className="gap-0.5">
              <Text className="text-3xl font-t3-bold tabular-nums text-foreground">
                {description.headline.value === null
                  ? description.headline.text
                  : description.headline.format(counted)}
              </Text>
              <Text className="text-sm text-foreground-muted">{description.headline.unit}</Text>
            </View>
            <View className="gap-1">
              {description.lines.map((line) => (
                <Text key={line} className="text-sm text-foreground-muted">
                  {line}
                </Text>
              ))}
            </View>
            {runners.length > 0 ? (
              <View className="mt-auto gap-2 border-t border-border-subtle pt-3">
                {runners.map((candidate, runnerIndex) => (
                  <View key={candidate.key} className="gap-1">
                    <View className="flex-row items-baseline justify-between gap-2">
                      <Text
                        className="min-w-0 flex-1 text-xs text-foreground-muted"
                        numberOfLines={1}
                      >
                        {runnerIndex + 2}. {candidate.label}
                      </Text>
                      <Text className="text-xs tabular-nums text-foreground-muted">
                        {pickValueText(pick.kind, candidate, pick)}
                      </Text>
                    </View>
                    <View className="h-0.5 overflow-hidden rounded-full bg-border-subtle">
                      <View
                        className="h-full rounded-full"
                        style={{
                          width: `${Math.max(2, pickBarShare(pick.kind, candidate, pick) * 100)}%`,
                          backgroundColor: style.color,
                          opacity: 0.7,
                        }}
                      />
                    </View>
                  </View>
                ))}
              </View>
            ) : null}
          </>
        ) : (
          <Text className="text-sm text-foreground-muted">
            Not enough evidence yet. This fills in as you use more models and your leads grade their
            subagents.
          </Text>
        )}
      </View>
    </Animated.View>
  );
}

/** What each plan costs against what it bought at API prices: the basis of Value and Low cost. */
function PlanList(props: { readonly picks: ModelPicks }) {
  const plans = props.picks.plans;
  if (plans.length === 0) return null;
  return (
    <View className="gap-2">
      <Text className="px-1 text-sm font-t3-medium text-foreground">
        Your plans against API prices
      </Text>
      <View className="overflow-hidden rounded-[24px] border-continuous bg-grouped-card">
        {plans.map((plan, index) => {
          const description = describePlan(plan);
          return (
            <View
              key={plan.accountKey ?? plan.instanceId}
              className={`gap-1.5 px-4 py-3 ${index > 0 ? "border-t border-border-subtle" : ""}`}
            >
              <View className="flex-row items-baseline justify-between gap-3">
                <View className="min-w-0 flex-1 flex-row items-baseline gap-2">
                  <Text className="shrink text-sm font-t3-medium text-foreground" numberOfLines={1}>
                    {plan.label}
                  </Text>
                  {description.price === null ? null : (
                    <Text className="text-xs text-foreground-tertiary">{description.price}</Text>
                  )}
                </View>
                {description.usedTimes === null ? null : (
                  <Text className="text-sm font-t3-bold tabular-nums text-foreground">
                    {description.usedTimes}
                  </Text>
                )}
              </View>
              <Text className="text-xs text-foreground-muted">
                {[description.used, description.capacity].filter(Boolean).join(" · ")}
              </Text>
              {description.price === null ? (
                <Text className="text-xs text-foreground-tertiary">
                  Enter what it costs in Usage on your Mac to see its real prices.
                </Text>
              ) : null}
              {description.usedShare === null ? null : (
                <View className="h-0.5 overflow-hidden rounded-full bg-border-subtle">
                  <View
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.max(1, description.usedShare * 100)}%`,
                      backgroundColor: KIND_STYLE.value.color,
                      opacity: 0.7,
                    }}
                  />
                </View>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** The best model for quality, value, speed and low cost, from the user's own evidence. */
export function UsageBestModels(props: {
  readonly selectedEnvironmentIds: ReadonlySet<EnvironmentId> | null;
}) {
  const [now] = useState(() => Date.now());
  const { picks, table } = useModelPicks(props.selectedEnvironmentIds, now);
  const { width: screenWidth } = useWindowDimensions();
  // Wide enough to read, narrow enough that the next card peeks in.
  const cardWidth = Math.min(300, Math.round(screenWidth * 0.74));

  if (picks === null || picks.candidates.length === 0) return null;

  return (
    <View className="gap-3">
      <View className="gap-0.5 px-1">
        <Text className="text-base font-t3-medium text-foreground">Best models for you</Text>
        <Text className="text-xs text-foreground-tertiary">{picksBasis(picks, table)}</Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        decelerationRate="fast"
        snapToInterval={cardWidth + 12}
        // Bleeds to the screen edges so cards scroll under the page padding.
        style={{ marginHorizontal: -20 }}
        contentContainerStyle={{ gap: 12, paddingHorizontal: 20 }}
      >
        {MODEL_PICK_KINDS.map((kind, index) => (
          <PickCard
            key={kind}
            pick={picks.picks[kind]}
            picks={picks}
            index={index}
            width={cardWidth}
          />
        ))}
      </ScrollView>
      <PlanList picks={picks} />
    </View>
  );
}
