import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import {
  CommandId,
  MessageId,
  type EnvironmentId,
  type OrchestrationMessageContext,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildCardReplyContext,
  cardChartBar,
  cardChartRange,
  cardChartSeriesColors,
  type CardAction,
  type CardBlock,
  type CardChart,
  type CardIcon,
  type CardImage,
  type CardInput,
  type CardInputValues,
  type CardLockedState,
  type CardProgress,
  type CardRowItem,
  type CardRowStatus,
  type CardSpec,
  type CardStatItem,
  type CardTone,
  formatCardInputsReply,
  formatChartNumber,
  formatSliderValue,
  initialCardInputValues,
  layoutChartXLabels,
  snapSliderValue,
  statDeltaSentiment,
} from "@t3tools/shared/cards";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import { Image as ExpoImage } from "expo-image";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, Switch, TextInput, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, G, Line, Path, Rect } from "react-native-svg";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPill";
import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { assetImageSource } from "../../lib/assetImageSource";
import { cn } from "../../lib/cn";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { uuidv4 } from "../../lib/uuid";
import { useAssetUrlState } from "../../state/assets";
import { useThreadShell } from "../../state/entities";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";

function lightHaptic() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

/** Outline bot face glyph: circle stroke + two filled rounded-rect eyes, no mouth. */
export function BotFaceGlyph(props: { readonly size?: number; readonly color: string }) {
  const size = props.size ?? 18;
  return (
    <Svg width={size} height={size} viewBox="0 0 18 18" fill="none">
      <Circle cx={9} cy={9} r={7.25} stroke={props.color} strokeWidth={1.5} />
      <Rect x={5.45} y={6.5} width={2.2} height={3.5} rx={1.1} fill={props.color} />
      <Rect x={10.35} y={6.5} width={2.2} height={3.5} rx={1.1} fill={props.color} />
    </Svg>
  );
}

/** Tiny "from card" glyph shown beside a user bubble sent from an interactive card. */
export function CardReplyGlyph(props: { readonly size?: number; readonly color: string }) {
  const size = props.size ?? 12;
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <Rect
        x={1.5}
        y={2.25}
        width={11}
        height={9.5}
        rx={2.25}
        stroke={props.color}
        strokeWidth={1.3}
      />
      <Path
        d="M4.25 5.5H9.75M4.25 8.25H7.5"
        stroke={props.color}
        strokeWidth={1.3}
        strokeLinecap="round"
      />
    </Svg>
  );
}

const TONE_HEX: Record<CardTone, { readonly light: string; readonly dark: string } | null> = {
  neutral: null,
  good: { light: "#059669", dark: "#34d399" },
  warn: { light: "#d97706", dark: "#fbbf24" },
  bad: { light: "#dc2626", dark: "#f87171" },
};

const ICON_SYMBOL: Record<Exclude<CardIcon, "bot">, AppSymbolName> = {
  chat: "bubble.left",
  check: "checkmark.circle",
  alert: "exclamationmark.circle",
  clock: "clock",
  chart: "chart.bar.xaxis",
  list: "checklist",
  spark: "sparkles",
};

function CardHeaderIcon(props: {
  readonly icon: CardIcon;
  readonly tone: CardTone;
  readonly appearance: "light" | "dark";
  readonly mutedColor: string;
}) {
  const tint = TONE_HEX[props.tone]?.[props.appearance] ?? props.mutedColor;
  if (props.icon === "bot") {
    return <BotFaceGlyph size={18} color={tint} />;
  }
  return <SymbolView name={ICON_SYMBOL[props.icon]} size={18} tintColor={tint} type="monochrome" />;
}

/** Pulsing dot for running rows; uses Reanimated and respects Reduce Motion. */
function PulsingStatusDot(props: { readonly color: string }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.35, { duration: 900, reduceMotion: ReduceMotion.System }),
        withTiming(1, { duration: 900, reduceMotion: ReduceMotion.System }),
      ),
      -1,
      false,
      undefined,
      ReduceMotion.System,
    );
  }, [opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: props.color }, style]}
    />
  );
}

function RowStatusIndicator(props: {
  readonly status: CardRowStatus;
  readonly appearance: "light" | "dark";
  readonly primaryColor: string;
  readonly mutedColor: string;
}) {
  switch (props.status) {
    case "running":
      return (
        <View className="h-5 w-5 items-center justify-center">
          <PulsingStatusDot color={props.primaryColor} />
        </View>
      );
    case "done":
      return (
        <View className="h-5 w-5 items-center justify-center">
          <SymbolView
            name="checkmark"
            size={13}
            tintColor={props.appearance === "dark" ? "#34d399" : "#059669"}
            type="monochrome"
          />
        </View>
      );
    case "failed":
      return (
        <View className="h-5 w-5 items-center justify-center">
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: props.appearance === "dark" ? "#f87171" : "#dc2626",
            }}
          />
        </View>
      );
    case "waiting":
      return (
        <View className="h-5 w-5 items-center justify-center">
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: props.appearance === "dark" ? "#fbbf24" : "#d97706",
            }}
          />
        </View>
      );
    case "idle":
      return (
        <View className="h-5 w-5 items-center justify-center">
          <View
            style={{
              width: 8,
              height: 8,
              borderRadius: 4,
              backgroundColor: props.mutedColor,
              opacity: 0.45,
            }}
          />
        </View>
      );
  }
}

/** Lightweight inline markdown (bold, code, italic) for card text blocks at 14pt. */
function CardTextBlock(props: { readonly text: string }) {
  const lines = props.text.split("\n");
  return (
    <View className="gap-1.5">
      {lines.map((line, lineIdx) => {
        const tokens = line.split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g);
        return (
          <Text key={lineIdx} selectable className="text-[14px] leading-5 text-foreground">
            {tokens.map((token, idx) => {
              if (token.startsWith("**") && token.endsWith("**") && token.length > 4) {
                return (
                  <Text key={idx} className="font-t3-semibold text-foreground">
                    {token.slice(2, -2)}
                  </Text>
                );
              }
              if (token.startsWith("`") && token.endsWith("`") && token.length > 2) {
                return (
                  <Text key={idx} className="font-mono text-[13px] text-foreground">
                    {token.slice(1, -1)}
                  </Text>
                );
              }
              if (token.startsWith("*") && token.endsWith("*") && token.length > 2) {
                return (
                  <Text key={idx} className="italic text-foreground">
                    {token.slice(1, -1)}
                  </Text>
                );
              }
              return token;
            })}
          </Text>
        );
      })}
    </View>
  );
}

function CardRow(props: {
  readonly row: CardRowItem;
  readonly environmentId: EnvironmentId;
  readonly appearance: "light" | "dark";
  readonly primaryColor: string;
  readonly mutedColor: string;
  readonly chevronColor: string;
  readonly showDivider: boolean;
}) {
  const navigation = useNavigation();
  const linked = useThreadShell(
    props.row.chat ? scopeThreadRef(props.environmentId, ThreadId.make(props.row.chat)) : null,
  );
  const canOpen = linked !== null && linked.deletedAt === null;

  const inner = (
    <View
      className={cn(
        "min-h-[44px] flex-row items-center gap-2.5 py-2",
        props.showDivider && "border-b border-border-subtle",
      )}
    >
      {props.row.status ? (
        <RowStatusIndicator
          status={props.row.status}
          appearance={props.appearance}
          primaryColor={props.primaryColor}
          mutedColor={props.mutedColor}
        />
      ) : null}
      <View className="min-w-0 flex-1">
        <Text className="text-[14px] leading-snug text-foreground" numberOfLines={1}>
          {props.row.title}
        </Text>
        {props.row.detail ? (
          <Text className="text-[12px] leading-snug text-foreground-muted" numberOfLines={1}>
            {props.row.detail}
          </Text>
        ) : null}
      </View>
      {props.row.value ? (
        <Text className="text-[13px] text-foreground-muted" numberOfLines={1}>
          {props.row.value}
        </Text>
      ) : null}
      {canOpen ? (
        <SymbolView
          name="chevron.right"
          size={12}
          tintColor={props.chevronColor}
          type="monochrome"
        />
      ) : null}
    </View>
  );

  if (canOpen) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.row.title}
        className="active:opacity-65"
        onPress={() => {
          lightHaptic();
          navigation.navigate("Thread", {
            environmentId: String(props.environmentId),
            threadId: String(linked.id),
          });
        }}
      >
        {inner}
      </Pressable>
    );
  }
  return inner;
}

function CardStatsBlock(props: {
  readonly stats: ReadonlyArray<CardStatItem>;
  readonly appearance: "light" | "dark";
}) {
  const widthPct = props.stats.length === 1 ? "100%" : props.stats.length === 3 ? "33.33%" : "50%";
  const goodColor = props.appearance === "dark" ? "#34d399" : "#059669";
  const badColor = props.appearance === "dark" ? "#f87171" : "#dc2626";
  return (
    <View className="flex-row flex-wrap -mx-1.5">
      {props.stats.map((stat, index) => {
        const sentiment = statDeltaSentiment(stat.delta, stat.tone);
        return (
          <View key={`${stat.label}-${index}`} style={{ width: widthPct }} className="px-1.5 py-1">
            <View className="flex-row items-baseline gap-1.5">
              <Text
                className="text-[20px] font-t3-semibold leading-tight text-foreground"
                numberOfLines={1}
              >
                {stat.value}
              </Text>
              {stat.delta ? (
                <Text
                  className="text-[12px] font-t3-medium text-foreground-muted"
                  style={[
                    sentiment === "good"
                      ? { color: goodColor }
                      : sentiment === "bad"
                        ? { color: badColor }
                        : null,
                  ]}
                  numberOfLines={1}
                >
                  {stat.delta}
                </Text>
              ) : null}
            </View>
            <Text className="mt-0.5 text-[12px] text-foreground-muted" numberOfLines={1}>
              {stat.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

function CardProgressBlock(props: { readonly progress: CardProgress }) {
  const clamped = Math.min(100, Math.max(0, props.progress.percent));
  const widthPct = useSharedValue(clamped);
  useEffect(() => {
    widthPct.value = withTiming(clamped, {
      duration: 600,
      easing: Easing.out(Easing.cubic),
      reduceMotion: ReduceMotion.System,
    });
  }, [clamped, widthPct]);
  const fillStyle = useAnimatedStyle(() => ({
    width: `${widthPct.value}%`,
  }));
  return (
    <View className="gap-1.5">
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-[13px] text-foreground-muted" numberOfLines={1}>
          {props.progress.label}
        </Text>
        <Text className="text-[13px] text-foreground-muted">
          {props.progress.eta ?? `${Math.round(clamped)}%`}
        </Text>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={props.progress.label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped) }}
        className="h-1.5 w-full overflow-hidden rounded-full bg-subtle-strong"
      >
        <Animated.View className="h-full rounded-full bg-primary" style={fillStyle} />
      </View>
    </View>
  );
}

function CardChartBlock(props: {
  readonly chart: CardChart;
  readonly appearance: "light" | "dark";
  readonly primaryColor: string;
  readonly baselineColor: string;
}) {
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [chartWidth, setChartWidth] = useState(300);
  const [labelWidths, setLabelWidths] = useState<ReadonlyArray<number | undefined>>([]);
  const colors = cardChartSeriesColors(props.appearance, props.primaryColor);
  const pointCount = Math.max(...props.chart.series.map((s) => s.points.length), 1);
  const xLabels = props.chart.xLabels?.slice(0, pointCount);
  const { min: minVal, max: maxVal } = cardChartRange(
    props.chart.kind,
    props.chart.series.flatMap((s) => s.points),
  );
  const range = maxVal - minVal;

  const svgHeight = 98;
  const padTop = 8;
  const padBottom = 6;
  const padX = 6;
  const plotW = Math.max(1, chartWidth - padX * 2);
  const plotH = svgHeight - padTop - padBottom;
  const bottomY = padTop + plotH;

  const xFor = (i: number) => {
    if (pointCount === 1) return padX + plotW / 2;
    if (props.chart.kind === "bar") {
      const slotW = plotW / pointCount;
      return padX + slotW * i + slotW / 2;
    }
    return padX + (i / (pointCount - 1)) * plotW;
  };
  const yFor = (val: number) => padTop + plotH - ((val - minVal) / range) * plotH;
  // Bars grow from zero, so the one baseline sits at zero for them.
  const baselineY = props.chart.kind === "bar" ? yFor(0) : bottomY;

  const labelPositions = xLabels?.every(
    (label, index) => !label || labelWidths[index] !== undefined,
  )
    ? layoutChartXLabels(
        xLabels.map((label, index) => ({
          center: xFor(index),
          width: label ? (labelWidths[index] ?? 0) : 0,
        })),
        chartWidth,
      )
    : [];
  const activeIndex = selectedIndex !== null && selectedIndex < pointCount ? selectedIndex : null;
  const slotWidth = plotW / pointCount;
  const barGroupWidth = Math.min(slotWidth * 0.72, 36);
  const singleBarWidth = Math.max(
    4,
    (barGroupWidth - (props.chart.series.length - 1) * 2) / props.chart.series.length,
  );

  return (
    <View className="gap-1.5">
      <View className="min-h-4 flex-row flex-wrap items-center justify-between gap-2">
        <View className="flex-row flex-wrap items-center gap-3">
          {props.chart.series.length > 1 ? (
            props.chart.series.map((s, idx) => (
              <View key={`${s.label}-${idx}`} className="flex-row items-center gap-1.5">
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 3.5,
                    backgroundColor: colors[idx % colors.length],
                  }}
                />
                <Text className="text-[12px] text-foreground-muted">{s.label}</Text>
              </View>
            ))
          ) : (
            <Text className="text-[12px] text-foreground-muted">
              {props.chart.series[0]?.label}
            </Text>
          )}
        </View>
        {activeIndex !== null ? (
          <View className="flex-row items-center gap-2">
            {props.chart.xLabels?.[activeIndex] ? (
              <Text className="text-[12px] text-foreground-muted">
                {props.chart.xLabels[activeIndex]}
              </Text>
            ) : null}
            {props.chart.series.map((s, idx) => {
              const v = s.points[activeIndex];
              if (v === undefined) return null;
              return (
                <View key={`${s.label}-v-${idx}`} className="flex-row items-center gap-1">
                  {props.chart.series.length > 1 ? (
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: colors[idx % colors.length],
                      }}
                    />
                  ) : null}
                  <Text className="text-[12px] font-t3-medium text-foreground">
                    {formatChartNumber(v)}
                  </Text>
                </View>
              );
            })}
          </View>
        ) : null}
      </View>

      <View
        className="h-[120px] w-full"
        onLayout={(event) => {
          const w = Math.floor(event.nativeEvent.layout.width);
          if (w > 0 && w !== chartWidth) setChartWidth(w);
        }}
      >
        <View className="relative h-[98px] w-full">
          <Svg width={chartWidth} height={svgHeight}>
            <Line
              x1={padX}
              y1={baselineY}
              x2={chartWidth - padX}
              y2={baselineY}
              stroke={props.baselineColor}
              strokeWidth={1}
            />
            {activeIndex !== null ? (
              <Line
                x1={xFor(activeIndex)}
                y1={padTop}
                x2={xFor(activeIndex)}
                y2={bottomY}
                stroke={props.baselineColor}
                strokeWidth={1}
                strokeDasharray="2,2"
              />
            ) : null}
            {props.chart.kind === "bar"
              ? props.chart.series.map((s, sIdx) => {
                  const color = colors[sIdx % colors.length]!;
                  return s.points.map((val, i) => {
                    const cx = xFor(i);
                    const offset = -barGroupWidth / 2 + sIdx * (singleBarWidth + 2);
                    const bar = cardChartBar(val, yFor);
                    const dimmed = activeIndex !== null && activeIndex !== i;
                    return (
                      <Rect
                        key={`${sIdx}-${i}`}
                        x={cx + offset}
                        y={bar.y}
                        width={singleBarWidth}
                        height={bar.height}
                        rx={3}
                        fill={color}
                        fillOpacity={dimmed ? 0.45 : 0.92}
                      />
                    );
                  });
                })
              : props.chart.series.map((s, sIdx) => {
                  const color = colors[sIdx % colors.length]!;
                  const d = s.points
                    .map(
                      (val, i) =>
                        `${i === 0 ? "M" : "L"}${xFor(i).toFixed(1)},${yFor(val).toFixed(1)}`,
                    )
                    .join(" ");
                  return (
                    <G key={sIdx}>
                      <Path
                        d={d}
                        fill="none"
                        stroke={color}
                        strokeWidth={2}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      {/* A one-point line has no segment to stroke: show the point. */}
                      {s.points.length === 1 && activeIndex === null ? (
                        <Circle cx={xFor(0)} cy={yFor(s.points[0]!)} r={3} fill={color} />
                      ) : null}
                      {activeIndex !== null && s.points[activeIndex] !== undefined ? (
                        <Circle
                          cx={xFor(activeIndex)}
                          cy={yFor(s.points[activeIndex]!)}
                          r={3.5}
                          fill={color}
                        />
                      ) : null}
                    </G>
                  );
                })}
          </Svg>
          {/* Tap columns for native touch inspection */}
          <View className="absolute inset-0 flex-row" style={{ paddingHorizontal: padX }}>
            {Array.from({ length: pointCount }, (_, i) => (
              <Pressable
                key={`tap-${i}`}
                accessibilityRole="button"
                accessibilityLabel={props.chart.xLabels?.[i] ?? `Point ${i + 1}`}
                className="flex-1"
                onPress={() => {
                  lightHaptic();
                  setSelectedIndex((current) => (current === i ? null : i));
                }}
              />
            ))}
          </View>
        </View>

        {xLabels && xLabels.length > 0 ? (
          <View className="relative h-5 justify-center">
            {Array.from(xLabels.entries(), ([index, label]) => {
              if (!label) return null;
              const left = labelPositions[index];
              return (
                <Text
                  key={index}
                  className="absolute left-0 text-[11px] text-foreground-muted"
                  style={{
                    maxWidth: xLabels.length === 1 ? chartWidth : Math.max(0, chartWidth / 2 - 2),
                    opacity: left === undefined ? 0 : 1,
                    transform: [{ translateX: left ?? 0 }],
                  }}
                  aria-hidden={left === undefined}
                  numberOfLines={1}
                  onLayout={(event) => {
                    const width = event.nativeEvent.layout.width;
                    setLabelWidths((current) => {
                      if (current[index] === width) return current;
                      const next = current.slice();
                      next[index] = width;
                      return next;
                    });
                  }}
                >
                  {label}
                </Text>
              );
            })}
          </View>
        ) : null}
      </View>
    </View>
  );
}

function CardImageBlock(props: {
  readonly image: CardImage;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null | undefined;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const viewed = useMemo(
    () =>
      resolveViewedImageAsset(props.image.path, {
        threadId: props.threadId,
        workspaceRoot: props.workspaceRoot,
      }),
    [props.image.path, props.threadId, props.workspaceRoot],
  );
  const assetState = useAssetUrlState(props.environmentId, viewed?.resource ?? null);
  const uri = assetState._tag === "Success" ? assetState.url : null;

  if (!uri || !viewed) {
    return (
      <View className="min-h-20 items-center justify-center rounded-[10px] border border-border-subtle bg-subtle px-3 py-4">
        <Text className="text-center text-xs text-foreground-muted">{props.image.alt}</Text>
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Open ${props.image.alt}`}
      className="overflow-hidden rounded-[10px] border border-border-subtle bg-subtle active:opacity-85"
      onPress={() => {
        lightHaptic();
        props.onPressPreview({
          kind: "image",
          name: props.image.alt,
          uri,
        });
      }}
    >
      <ExpoImage
        source={assetImageSource(props.environmentId, viewed.resource, uri)}
        contentFit="contain"
        style={{ width: "100%", height: 196 }}
      />
    </Pressable>
  );
}

const SLIDER_THUMB = 24;
const SLIDER_TRACK = 4;
const SLIDER_STOP = 6;
const SLIDER_SNAP = { duration: 110, reduceMotion: ReduceMotion.System } as const;

/** Stepped slider matching Settings > Agents (`AgentLevelSliderRow`). */
function CardSteppedSlider(props: {
  readonly field: CardInput;
  readonly value: number;
  readonly disabled: boolean;
  readonly onChange: (next: number) => void;
}) {
  const min = props.field.min ?? 0;
  const max = props.field.max ?? 100;
  const step = props.field.step ?? 1;
  const totalSteps = Math.max(1, Math.round((max - min) / step));
  const currentStep = Math.min(totalSteps, Math.max(0, Math.round((props.value - min) / step)));
  const showDots = totalSteps <= 10;
  const defaultStep =
    typeof props.field.default === "number"
      ? Math.min(
          totalSteps,
          Math.max(
            0,
            Math.round((snapSliderValue(props.field.default, min, max, step) - min) / step),
          ),
        )
      : -1;

  const onChangeRef = useRef(props.onChange);
  useLayoutEffect(() => {
    onChangeRef.current = props.onChange;
  });

  const progress = useSharedValue(currentStep / totalSteps);
  const trackWidth = useSharedValue(0);
  const dragging = useSharedValue(false);
  const dragStep = useSharedValue(currentStep);

  useEffect(() => {
    if (!dragging.value) {
      progress.value = withTiming(currentStep / totalSteps, SLIDER_SNAP);
    }
  }, [currentStep, dragging, progress, totalSteps]);

  const commitStep = useCallback(
    (nextStep: number) => {
      const nextVal = snapSliderValue(min + nextStep * step, min, max, step);
      onChangeRef.current(nextVal);
    },
    [max, min, step],
  );

  const gesture = useMemo(() => {
    const stepAt = (x: number): number => {
      "worklet";
      const w = trackWidth.value;
      if (w <= 0) return 0;
      const edge = SLIDER_THUMB / 2;
      const frac = (x - edge) / Math.max(1, w - SLIDER_THUMB);
      return Math.min(totalSteps, Math.max(0, Math.round(frac * totalSteps)));
    };
    const pan = Gesture.Pan()
      .enabled(!props.disabled)
      .activeOffsetX([-6, 6])
      .failOffsetY([-12, 12])
      .onStart((event) => {
        dragging.value = true;
        dragStep.value = stepAt(event.x);
        progress.value = withTiming(dragStep.value / totalSteps, SLIDER_SNAP);
      })
      .onUpdate((event) => {
        const next = stepAt(event.x);
        if (next === dragStep.value) return;
        dragStep.value = next;
        progress.value = withTiming(next / totalSteps, SLIDER_SNAP);
        runOnJS(lightHaptic)();
      })
      .onFinalize((_event, success) => {
        if (!dragging.value) return;
        dragging.value = false;
        if (!success) {
          progress.value = withTiming(currentStep / totalSteps, SLIDER_SNAP);
          return;
        }
        if (dragStep.value !== currentStep) runOnJS(commitStep)(dragStep.value);
      });
    const tap = Gesture.Tap()
      .enabled(!props.disabled)
      .onEnd((event) => {
        const next = stepAt(event.x);
        if (next === currentStep) return;
        progress.value = withTiming(next / totalSteps, SLIDER_SNAP);
        runOnJS(lightHaptic)();
        runOnJS(commitStep)(next);
      });
    return Gesture.Race(pan, tap);
  }, [
    commitStep,
    currentStep,
    dragStep,
    dragging,
    progress,
    props.disabled,
    totalSteps,
    trackWidth,
  ]);

  const fillStyle = useAnimatedStyle(() => ({
    width: Math.max(0, (trackWidth.value - SLIDER_THUMB) * progress.value),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: (trackWidth.value - SLIDER_THUMB) * progress.value }],
  }));

  return (
    <View className={cn("gap-1", props.disabled && "opacity-60")}>
      <View className="flex-row items-center justify-between gap-2">
        <Text className="flex-1 text-[13px] font-t3-medium text-foreground">
          {props.field.label}
        </Text>
        <Text className="text-[13px] text-foreground-muted">
          {formatSliderValue(props.value, props.field.unit)}
        </Text>
      </View>
      <GestureDetector gesture={gesture}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel={props.field.label}
          accessibilityValue={{
            min,
            max,
            now: props.value,
            text: formatSliderValue(props.value, props.field.unit),
          }}
          className="h-10 justify-center"
          onLayout={(event) => {
            trackWidth.value = event.nativeEvent.layout.width;
          }}
        >
          <View
            pointerEvents="none"
            className="absolute"
            style={{
              left: SLIDER_THUMB / 2,
              right: SLIDER_THUMB / 2,
              top: 0,
              bottom: 0,
            }}
          >
            {defaultStep >= 0 ? (
              <View
                className="absolute top-0.5 h-1 w-1 rounded-full bg-foreground-muted"
                style={{
                  left: `${(defaultStep / totalSteps) * 100}%`,
                  marginLeft: -2,
                }}
              />
            ) : null}
            <View
              className="absolute inset-x-0 rounded-full bg-foreground/15"
              style={{
                height: SLIDER_TRACK,
                top: "50%",
                marginTop: -SLIDER_TRACK / 2,
              }}
            >
              <Animated.View
                className="absolute inset-y-0 left-0 rounded-full bg-primary"
                style={fillStyle}
              />
            </View>
            {showDots
              ? Array.from({ length: totalSteps + 1 }, (_, i) => (
                  <View
                    key={i}
                    className={
                      i <= currentStep
                        ? "absolute rounded-full bg-primary"
                        : "absolute rounded-full bg-foreground-muted"
                    }
                    style={{
                      left: `${(i / totalSteps) * 100}%`,
                      top: "50%",
                      width: SLIDER_STOP,
                      height: SLIDER_STOP,
                      marginTop: -SLIDER_STOP / 2,
                      marginLeft: -SLIDER_STOP / 2,
                      opacity: i <= currentStep ? 1 : 0.45,
                    }}
                  />
                ))
              : null}
          </View>
          <Animated.View
            pointerEvents="none"
            className="absolute left-0 rounded-full border border-border-subtle bg-primary-foreground"
            style={[
              {
                height: SLIDER_THUMB,
                width: SLIDER_THUMB,
                top: "50%",
                marginTop: -SLIDER_THUMB / 2,
                shadowColor: "#000000",
                shadowOffset: { width: 0, height: 2 },
                shadowOpacity: 0.16,
                shadowRadius: 3,
              },
              thumbStyle,
            ]}
          />
        </View>
      </GestureDetector>
    </View>
  );
}

function CardInputField(props: {
  readonly field: CardInput;
  readonly value: string | number | boolean | undefined;
  readonly disabled: boolean;
  readonly iconSubtleColor: string;
  readonly onChange: (next: string | number | boolean) => void;
}) {
  switch (props.field.kind) {
    case "choice": {
      const options = props.field.options ?? [];
      const current = typeof props.value === "string" ? props.value : (options[0] ?? "");
      if (options.length <= 3) {
        return (
          <View className="gap-1.5">
            <Text className="text-[13px] font-t3-medium text-foreground">{props.field.label}</Text>
            <View className="flex-row gap-1 rounded-[10px] border border-border-subtle bg-subtle p-0.5">
              {options.map((option) => {
                const selected = option === current;
                return (
                  <Pressable
                    key={option}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: selected, disabled: props.disabled }}
                    disabled={props.disabled}
                    onPress={() => {
                      lightHaptic();
                      props.onChange(option);
                    }}
                    className={cn(
                      "min-h-[34px] flex-1 items-center justify-center rounded-[8px] px-2 py-1.5",
                      selected && "bg-grouped-card shadow-xs",
                      props.disabled && !selected && "opacity-45",
                    )}
                  >
                    <Text
                      className={cn(
                        "text-[13px]",
                        selected ? "font-t3-semibold text-foreground" : "text-foreground-muted",
                      )}
                      numberOfLines={1}
                    >
                      {option}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        );
      }
      return (
        <View className="gap-1.5">
          <Text className="text-[13px] font-t3-medium text-foreground">{props.field.label}</Text>
          {props.disabled ? (
            <View className="min-h-[40px] flex-row items-center justify-between rounded-[10px] border border-input-border bg-input px-3 py-2 opacity-65">
              <Text className="text-[14px] text-foreground">{current}</Text>
            </View>
          ) : (
            <ControlPillMenu
              title={props.field.label}
              actions={options.map((option) => ({
                id: option,
                title: option,
                state: option === current ? "on" : "off",
              }))}
              onPressAction={({ nativeEvent }) => {
                lightHaptic();
                props.onChange(nativeEvent.event);
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${props.field.label}: ${current}`}
                className="min-h-[40px] flex-row items-center justify-between rounded-[10px] border border-input-border bg-input px-3 py-2 active:opacity-75"
              >
                <Text className="flex-1 text-[14px] text-foreground" numberOfLines={1}>
                  {current}
                </Text>
                <SymbolView
                  name="chevron.down"
                  size={13}
                  tintColor={props.iconSubtleColor}
                  type="monochrome"
                />
              </Pressable>
            </ControlPillMenu>
          )}
        </View>
      );
    }
    case "slider":
      return (
        <CardSteppedSlider
          field={props.field}
          value={typeof props.value === "number" ? props.value : (props.field.min ?? 0)}
          disabled={props.disabled}
          onChange={props.onChange}
        />
      );
    case "toggle":
      return (
        <View className="min-h-[40px] flex-row items-center justify-between gap-3">
          <Text className="flex-1 text-[13px] font-t3-medium text-foreground">
            {props.field.label}
          </Text>
          <Switch
            accessibilityLabel={props.field.label}
            disabled={props.disabled}
            value={props.value === true}
            onValueChange={(next) => {
              lightHaptic();
              props.onChange(next);
            }}
          />
        </View>
      );
    case "text":
      return (
        <View className="gap-1.5">
          <Text className="text-[13px] font-t3-medium text-foreground">{props.field.label}</Text>
          <TextInput
            accessibilityLabel={props.field.label}
            editable={!props.disabled}
            value={typeof props.value === "string" ? props.value : ""}
            onChangeText={props.onChange}
            placeholder={props.field.label}
            placeholderTextColorClassName="accent-placeholder"
            returnKeyType="done"
            className={cn(
              "min-h-[40px] rounded-[10px] border border-input-border bg-input px-3 py-2 text-[14px] text-foreground",
              props.disabled && "opacity-65",
            )}
          />
        </View>
      );
  }
}

function CardBlockView(props: {
  readonly block: CardBlock;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null | undefined;
  readonly appearance: "light" | "dark";
  readonly primaryColor: string;
  readonly mutedColor: string;
  readonly chevronColor: string;
  readonly baselineColor: string;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  if ("text" in props.block) {
    return <CardTextBlock text={props.block.text} />;
  }
  if ("rows" in props.block) {
    const rows = props.block.rows;
    return (
      <View>
        {rows.map((row, index) => (
          <CardRow
            key={`${row.title}-${index}`}
            row={row}
            environmentId={props.environmentId}
            appearance={props.appearance}
            primaryColor={props.primaryColor}
            mutedColor={props.mutedColor}
            chevronColor={props.chevronColor}
            showDivider={index < rows.length - 1}
          />
        ))}
      </View>
    );
  }
  if ("stats" in props.block) {
    return <CardStatsBlock stats={props.block.stats} appearance={props.appearance} />;
  }
  if ("progress" in props.block) {
    return <CardProgressBlock progress={props.block.progress} />;
  }
  if ("chart" in props.block) {
    return (
      <CardChartBlock
        chart={props.block.chart}
        appearance={props.appearance}
        primaryColor={props.primaryColor}
        baselineColor={props.baselineColor}
      />
    );
  }
  return (
    <CardImageBlock
      image={props.block.image}
      environmentId={props.environmentId}
      threadId={props.threadId}
      workspaceRoot={props.workspaceRoot}
      onPressPreview={props.onPressPreview}
    />
  );
}

/** Skeleton card shown while a `show_card` tool call is pending/streaming. */
export function AgentCardSkeleton(props: { readonly title?: string | undefined }) {
  return (
    <View
      testID="agent-card-streaming"
      className="my-1.5 w-full rounded-2xl border border-border-subtle bg-grouped-card px-4 py-3.5"
    >
      <View className="flex-row items-center gap-2.5">
        <View className="h-[18px] w-[18px] rounded-full bg-subtle-strong" />
        {props.title ? (
          <Text className="flex-1 text-[15px] font-t3-semibold text-foreground" numberOfLines={1}>
            {props.title}
          </Text>
        ) : (
          <View className="h-4 w-36 rounded bg-subtle-strong" />
        )}
      </View>
      <View className="mt-3 gap-2">
        <View className="h-3 w-4/5 rounded bg-subtle-strong opacity-80" />
        <View className="h-3 w-3/5 rounded bg-subtle-strong opacity-60" />
      </View>
    </View>
  );
}

export interface MobileAgentCardProps {
  readonly itemId: string;
  readonly card: CardSpec;
  readonly lockedState: CardLockedState;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly conversationThreadId: ThreadId;
  readonly workspaceRoot: string | null | undefined;
  readonly themeAppearance: "light" | "dark";
  readonly messageRunActive: boolean;
  readonly canOperateMessage: boolean;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  /** Optional test override; defaults to enqueueThreadOutboxMessage. */
  readonly onSendReply?: (payload: {
    readonly text: string;
    readonly context: OrchestrationMessageContext;
    readonly dispatchMode: "steer" | "auto";
  }) => Promise<void>;
}

export function AgentCard(props: MobileAgentCardProps) {
  const theme = useUniwindTheme();
  const primaryColor = theme["--color-primary"];
  const primaryForegroundColor = theme["--color-primary-foreground"];
  const mutedColor = theme["--color-icon-subtle"];
  const chevronColor = theme["--color-chevron"];
  const baselineColor = theme["--color-border-subtle"];
  const dangerTextColor = theme["--color-danger-foreground"];
  const foregroundColor = theme["--color-foreground"];

  const defaultValues = useMemo(
    () => (props.card.inputs ? initialCardInputValues(props.card.inputs) : {}),
    [props.card.inputs],
  );
  const [draftValues, setDraftValues] = useState<Record<string, string | number | boolean>>(
    () => defaultValues,
  );
  const [localReply, setLocalReply] = useState<{
    readonly selectedActionIndex?: number;
    readonly submittedValues?: CardInputValues;
  } | null>(null);
  const [sending, setSending] = useState(false);

  const isLocked =
    props.lockedState.locked || localReply !== null || sending || !props.canOperateMessage;
  const selectedActionIndex =
    props.lockedState.selectedActionIndex ?? localReply?.selectedActionIndex;
  const shownValues: CardInputValues =
    props.lockedState.submittedValues ?? localReply?.submittedValues ?? draftValues;

  const toneBarColor = TONE_HEX[props.card.tone]?.[props.themeAppearance] ?? null;

  const dispatchReply = async (text: string, context: OrchestrationMessageContext) => {
    const dispatchMode = props.messageRunActive ? "steer" : "auto";
    if (props.onSendReply) {
      await props.onSendReply({ text, context, dispatchMode });
      return;
    }
    await enqueueThreadOutboxMessage({
      environmentId: props.environmentId,
      threadId: props.conversationThreadId,
      messageId: MessageId.make(uuidv4()),
      commandId: CommandId.make(uuidv4()),
      text,
      context,
      attachments: [],
      dispatchMode,
      createdAt: new Date().toISOString(),
    });
  };

  const handleActionPress = async (action: CardAction, index: number) => {
    if (isLocked) return;
    lightHaptic();
    setSending(true);
    setLocalReply({ selectedActionIndex: index });
    try {
      await dispatchReply(
        action.reply,
        buildCardReplyContext({
          itemId: props.itemId,
          kind: "action",
          actionIndex: index,
          label: action.label,
        }),
      );
    } catch {
      setLocalReply(null);
    } finally {
      setSending(false);
    }
  };

  const handleInputsSubmit = async () => {
    if (isLocked || !props.card.inputs) return;
    lightHaptic();
    const snapshot: Record<string, string | number | boolean> = {
      ...defaultValues,
      ...draftValues,
    };
    const text = formatCardInputsReply(props.card.inputs, snapshot);
    setSending(true);
    setLocalReply({ submittedValues: snapshot });
    try {
      await dispatchReply(
        text,
        buildCardReplyContext({
          itemId: props.itemId,
          kind: "inputs",
          values: snapshot,
        }),
      );
    } catch {
      setLocalReply(null);
    } finally {
      setSending(false);
    }
  };

  const stackActions = (props.card.actions?.length ?? 0) > 2;

  return (
    <View
      testID={isLocked ? "agent-card-locked" : "agent-card-active"}
      className={cn(
        "relative my-1.5 w-full overflow-hidden rounded-2xl border border-border-subtle bg-grouped-card py-3.5 pr-4",
        toneBarColor ? "pl-[19px]" : "pl-4",
      )}
    >
      {toneBarColor ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            top: 0,
            bottom: 0,
            width: 3,
            backgroundColor: toneBarColor,
          }}
        />
      ) : null}

      {/* Header */}
      <View className="flex-row items-start gap-2.5">
        {props.card.icon ? (
          <View className="mt-0.5">
            <CardHeaderIcon
              icon={props.card.icon}
              tone={props.card.tone}
              appearance={props.themeAppearance}
              mutedColor={mutedColor}
            />
          </View>
        ) : null}
        <View className="min-w-0 flex-1">
          <Text className="text-[15px] font-t3-semibold leading-snug text-foreground">
            {props.card.title}
          </Text>
          {props.card.subtitle ? (
            <Text className="mt-0.5 text-[13px] leading-snug text-foreground-muted">
              {props.card.subtitle}
            </Text>
          ) : null}
        </View>
      </View>

      {/* Blocks */}
      {props.card.blocks && props.card.blocks.length > 0 ? (
        <View className="mt-3 gap-3">
          {props.card.blocks.map((block, index) => (
            <CardBlockView
              key={index}
              block={block}
              environmentId={props.environmentId}
              threadId={props.threadId}
              workspaceRoot={props.workspaceRoot}
              appearance={props.themeAppearance}
              primaryColor={primaryColor}
              mutedColor={mutedColor}
              chevronColor={chevronColor}
              baselineColor={baselineColor}
              onPressPreview={props.onPressPreview}
            />
          ))}
        </View>
      ) : null}

      {/* Inputs + submit */}
      {props.card.inputs && props.card.inputs.length > 0 ? (
        <View className="mt-3.5 gap-3 border-t border-border-subtle pt-3">
          {props.card.inputs.map((field) => (
            <CardInputField
              key={field.id}
              field={field}
              value={shownValues[field.id]}
              disabled={isLocked}
              iconSubtleColor={mutedColor}
              onChange={(next) => setDraftValues((prev) => ({ ...prev, [field.id]: next }))}
            />
          ))}
          <View className="flex-row justify-end pt-0.5">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: isLocked }}
              disabled={isLocked}
              onPress={() => void handleInputsSubmit()}
              className={cn(
                "min-h-[38px] flex-row items-center justify-center gap-1.5 rounded-full px-5 py-2",
                isLocked ? "bg-subtle-strong" : "bg-primary active:opacity-80",
              )}
            >
              {props.lockedState.submittedValues || localReply?.submittedValues ? (
                <>
                  <SymbolView name="checkmark" size={13} tintColor={mutedColor} type="monochrome" />
                  <Text className="text-[14px] font-t3-semibold text-foreground-muted">Sent</Text>
                </>
              ) : (
                <Text
                  className={cn(
                    "text-[14px] font-t3-semibold",
                    isLocked ? "text-foreground-muted" : "text-primary-foreground",
                  )}
                >
                  {props.card.submit ?? "Send"}
                </Text>
              )}
            </Pressable>
          </View>
        </View>
      ) : null}

      {/* Actions: right-aligned row for <=2, full-width stack for >2 */}
      {props.card.actions && props.card.actions.length > 0 ? (
        <View
          className={cn(
            "mt-3.5 gap-2",
            stackActions ? "flex-col" : "flex-row flex-wrap items-center justify-end",
          )}
        >
          {props.card.actions.map((action, index) => {
            const isPicked = selectedActionIndex === index;
            const isDimmed = isLocked && !isPicked;
            const checkTint =
              action.style === "primary"
                ? primaryForegroundColor
                : action.style === "danger"
                  ? dangerTextColor
                  : foregroundColor;
            return (
              <Pressable
                key={`${action.label}-${index}`}
                accessibilityRole="button"
                accessibilityState={{ disabled: isLocked, selected: isPicked }}
                disabled={isLocked}
                onPress={() => void handleActionPress(action, index)}
                className={cn(
                  "min-h-[38px] flex-row items-center justify-center gap-1.5 rounded-full px-4 py-2",
                  stackActions && "w-full",
                  action.style === "primary"
                    ? "bg-primary"
                    : action.style === "danger"
                      ? "border border-danger-border bg-danger"
                      : "border border-secondary-border bg-secondary",
                  !isLocked && "active:opacity-75",
                  isDimmed && "opacity-40",
                )}
              >
                {isPicked ? (
                  <SymbolView name="checkmark" size={13} tintColor={checkTint} type="monochrome" />
                ) : null}
                <Text
                  className={cn(
                    "text-[14px] font-t3-semibold",
                    action.style === "primary"
                      ? "text-primary-foreground"
                      : action.style === "danger"
                        ? "text-danger-foreground"
                        : "text-secondary-foreground",
                  )}
                >
                  {action.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}
