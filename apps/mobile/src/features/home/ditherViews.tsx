/**
 * The dithered charts Insights and the new chat share: a day heatmap and a month's pace,
 * drawn in the app's 4pt dithered tile mosaic and revealed in dither order, sparse tiles
 * first.
 */
import type { ChatPace } from "@t3tools/client-runtime/new-chat-dashboard";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { PixelRatio, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedProps,
  useAnimatedReaction,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Path } from "react-native-svg";

// oxlint-disable-next-line t3code/no-mobile-uniwind-theme-escape-hatches -- SVG paths take their colours as props.
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  DitherCanvas,
  DOT,
  mosaicGap,
  snapToDots,
  type DitherLayer,
  type DitherShare,
} from "./dither";

const AnimatedPath = Animated.createAnimatedComponent(Path);
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

export const REVEAL_SLICES = 4;
/** How strongly a day's tiles light at each activity level: whole cells, never frayed. */
export const LEVEL_OPACITY = [0, 0.34, 0.56, 0.8, 1] as const;
const CELL_GAP = 2;

/**
 * Dither layers, appearing in dither order (sparse dots first) once `progress` runs, and
 * with `wipe`, swept in from the left edge at the same time.
 */
export function DitherLayers({
  width,
  height,
  layers,
  progress,
  wipe = false,
}: {
  width: number;
  height: number;
  layers: ReadonlyArray<DitherLayer>;
  progress: SharedValue<number>;
  wipe?: boolean;
}) {
  const slices = Array.from({ length: REVEAL_SLICES }, (_, slice) =>
    layers.filter((layer) => layer.slice === slice),
  );
  const wipeStyle = useAnimatedStyle(() =>
    wipe ? { width: width * Math.min(1, progress.get() * 1.35) } : { width },
  );
  return (
    <Animated.View style={[{ height, overflow: "hidden" }, wipeStyle]} pointerEvents="none">
      {slices.map((sliceLayers, slice) =>
        sliceLayers.length === 0 ? null : (
          <RevealSlice key={slice} slice={slice} progress={progress} width={width}>
            <Svg width={width} height={height}>
              {sliceLayers.map((layer) => (
                <Path
                  key={`${layer.color}:${layer.opacity}`}
                  d={layer.d}
                  fill={layer.color}
                  fillOpacity={layer.opacity}
                />
              ))}
            </Svg>
          </RevealSlice>
        ),
      )}
    </Animated.View>
  );
}

function RevealSlice({
  slice,
  progress,
  width,
  children,
}: {
  slice: number;
  progress: SharedValue<number>;
  width: number;
  children: ReactNode;
}) {
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, (progress.get() * REVEAL_SLICES - slice) * 1.6)),
  }));
  return (
    <Animated.View style={[{ position: "absolute", left: 0, top: 0, bottom: 0, width }, style]}>
      {children}
    </Animated.View>
  );
}

/** Runs 0 → 1 once, after `delay`, when `active` first turns on. */
export function useReveal(active: boolean, delay: number, duration = 900) {
  const reduced = useReducedMotion();
  const progress = useSharedValue(reduced ? 1 : 0);
  useEffect(() => {
    if (!active) return;
    progress.set(
      withDelay(
        delay,
        withTiming(1, {
          duration,
          easing: Easing.out(Easing.cubic),
          reduceMotion: ReduceMotion.System,
        }),
      ),
    );
  }, [active, delay, duration, progress]);
  return progress;
}

/** Measures a box's width, snapped to the dot grid. */
export function useWidth() {
  const [width, setWidth] = useState(0);
  return [
    width,
    (event: { nativeEvent: { layout: { width: number } } }) =>
      setWidth(snapToDots(event.nativeEvent.layout.width)),
  ] as const;
}

export interface HeatmapDay {
  readonly level: 0 | 1 | 2 | 3 | 4;
  readonly future: boolean;
  /** Who the day's dots belong to, in bands by share. */
  readonly shares: ReadonlyArray<DitherShare>;
}

/**
 * Weeks of days, Sunday first, in columns: a quiet solid square for a day without chats,
 * dither as full as the day was busy for one with them. Centred at the measured width,
 * with cells no larger than `maxCell`.
 */
export function DitherHeatmap({
  days,
  weeks,
  progress,
  maxCell = 20,
  accessibilityLabel,
}: {
  days: ReadonlyArray<HeatmapDay>;
  weeks: number;
  progress: SharedValue<number>;
  maxCell?: number;
  accessibilityLabel: string;
}) {
  const theme = useUniwindTheme();
  const empty = String(theme["--color-border"]);
  const [width, onLayout] = useWidth();
  const cell = Math.min(maxCell, snapToDots((width + CELL_GAP) / weeks - CELL_GAP));
  const height = Math.max(0, cell * 7 + CELL_GAP * 6);
  const gridWidth = Math.max(0, weeks * (cell + CELL_GAP) - CELL_GAP);
  const gap = mosaicGap(PixelRatio.get());
  const layers = useMemo(() => {
    if (cell <= 0) return [];
    const canvas = new DitherCanvas(REVEAL_SLICES, gap);
    days.forEach((day, index) => {
      if (day.future) return;
      const x = Math.floor(index / 7) * (cell + CELL_GAP);
      const y = (index % 7) * (cell + CELL_GAP);
      if (day.level === 0 || day.shares.length === 0) {
        canvas.solid(x, y, cell, cell, empty);
        return;
      }
      canvas.columns(x, y, cell, cell, LEVEL_OPACITY[day.level], day.shares, true);
    });
    return canvas.layers();
  }, [cell, days, empty, gap]);
  return (
    <View
      onLayout={onLayout}
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      style={{ height, alignItems: "center" }}
    >
      <DitherLayers width={gridWidth} height={height} layers={layers} progress={progress} wipe />
    </View>
  );
}

/**
 * This month's running total as a line over dithered light that thins toward the floor,
 * last month's as a dashed line on the same scale, and a dot on today.
 */
export function DitherPaceChart({
  pace,
  tint,
  height,
  progress,
}: {
  pace: ChatPace;
  tint: string;
  height: number;
  progress: SharedValue<number>;
}) {
  const theme = useUniwindTheme();
  const ink = String(theme["--color-foreground"]);
  const muted = String(theme["--color-foreground-muted"]);
  const [width, onLayout] = useWidth();
  const gap = mosaicGap(PixelRatio.get());
  const chart = useMemo(() => {
    if (width === 0) return null;
    const inset = 4;
    const lastDay = Math.max(pace.daysInMonth - 1, 1);
    const topTotal = Math.max(pace.current.at(-1) ?? 0, pace.previous.at(-1) ?? 0, 1);
    const x = (index: number) => inset + (index / lastDay) * (width - inset * 2);
    const y = (total: number) => height - inset - (total / topTotal) * (height - inset * 2);
    const line = (totals: ReadonlyArray<number>) =>
      totals
        .map(
          (total, index) =>
            `${index === 0 ? "M" : "L"}${x(index).toFixed(1)} ${y(total).toFixed(1)}`,
        )
        .join("");
    let length = 0;
    for (let index = 1; index < pace.current.length; index++)
      length += Math.hypot(
        x(index) - x(index - 1),
        y(pace.current[index] ?? 0) - y(pace.current[index - 1] ?? 0),
      );
    const canvas = new DitherCanvas(REVEAL_SLICES, gap);
    const todayIndex = pace.current.length - 1;
    const end = x(todayIndex);
    for (let column = 0; column * DOT <= end; column++) {
      const px = column * DOT;
      const position = ((px - inset) / (width - inset * 2)) * lastDay;
      const left = Math.max(0, Math.min(todayIndex, Math.floor(position)));
      const right = Math.min(todayIndex, left + 1);
      const mix = Math.max(0, Math.min(1, position - left));
      const total = (pace.current[left] ?? 0) * (1 - mix) + (pace.current[right] ?? 0) * mix;
      const top = snapToDots(y(total));
      const span = height - top;
      if (span <= 0) continue;
      canvas.box(px, top, DOT, span, (_, down) => 0.6 * (1 - down) ** 1.3, [
        { color: tint, share: 1 },
      ]);
    }
    return {
      layers: canvas.layers(),
      current: line(pace.current),
      length: Math.max(1, length),
      previous: line(pace.previous),
      today: { x: end, y: y(pace.current[todayIndex] ?? 0) },
    };
  }, [gap, height, pace, tint, width]);
  // The line draws itself as the light comes in; today's dot lands, then calls twice.
  const lineLength = chart?.length ?? 0;
  const lineProps = useAnimatedProps(() => ({
    strokeDashoffset: lineLength * (1 - Math.min(1, progress.get() * 1.1)),
  }));
  const dotProps = useAnimatedProps(() => ({
    opacity: Math.min(1, Math.max(0, (progress.get() - 0.85) * 8)),
  }));
  const halo = useSharedValue(0);
  const arrived = useDerivedValue(() => progress.get() >= 0.99);
  useAnimatedReaction(
    () => arrived.get(),
    (now, before) => {
      if (now && !before)
        halo.set(withRepeat(withTiming(1, { duration: 1400, easing: Easing.out(Easing.quad) }), 2));
    },
  );
  const haloProps = useAnimatedProps(() => ({
    r: 3 + halo.get() * 9,
    opacity: halo.get() > 0 && halo.get() < 1 ? 0.55 * (1 - halo.get()) : 0,
  }));
  return (
    <View onLayout={onLayout} style={{ height }} accessibilityElementsHidden>
      {chart ? (
        <>
          <DitherLayers
            width={width}
            height={height}
            layers={chart.layers}
            progress={progress}
            wipe
          />
          <Svg width={width} height={height} style={StyleSheet.absoluteFill}>
            <Path
              d={chart.previous}
              fill="none"
              stroke={muted}
              strokeDasharray="3 4"
              strokeOpacity={0.7}
              strokeWidth={1}
            />
            <AnimatedPath
              d={chart.current}
              fill="none"
              stroke={ink}
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={1.5}
              strokeDasharray={[chart.length, chart.length]}
              animatedProps={lineProps}
            />
            <AnimatedCircle
              cx={chart.today.x}
              cy={chart.today.y}
              fill={tint}
              animatedProps={haloProps}
            />
            <AnimatedCircle
              cx={chart.today.x}
              cy={chart.today.y}
              r={3}
              fill={ink}
              animatedProps={dotProps}
            />
          </Svg>
        </>
      ) : null}
    </View>
  );
}
