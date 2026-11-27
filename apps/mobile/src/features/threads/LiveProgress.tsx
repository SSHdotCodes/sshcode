import { useIsFocused } from "@react-navigation/native";
import type { OrchestrationV2LiveProgress } from "@t3tools/contracts";
import {
  type LiveProgressCard as LiveProgressCardModel,
  type LiveProgressCardStage,
  liveProgressCard,
} from "@t3tools/shared/liveProgress";
import * as Haptics from "expo-haptics";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";
import { useVisibleSecondClock } from "./use-visible-second-clock";

/** Minutes are the finest unit time-left labels show. */
const TICK_MS = 15_000;
const FILL_TIMING = {
  duration: 600,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
};

/** The card's model, re-read every 15 seconds while the screen is on and focused. */
export function useLiveProgressCard(
  progress: OrchestrationV2LiveProgress | undefined,
): LiveProgressCardModel | null {
  const nowMs = useVisibleSecondClock(progress !== undefined, TICK_MS);
  return progress === undefined
    ? null
    : liveProgressCard(progress, Math.max(nowMs, progress.reportedAt));
}

/**
 * Thin rounded bar. Its fill eases to each new width; without an estimate a soft segment sweeps
 * the track instead, only while the screen is focused and never under Reduce Motion.
 */
export function LiveProgressBar(props: {
  readonly fraction: number | null;
  readonly size?: "card" | "mini";
  readonly className?: string;
}) {
  const [width, setWidth] = useState(0);
  const fill = useSharedValue(props.fraction ?? 0);
  const sweep = useSharedValue(0);
  const reduced = useReducedMotion();
  const focused = useIsFocused();
  const indeterminate = props.fraction === null;
  useEffect(() => {
    if (props.fraction !== null) fill.value = withTiming(props.fraction, FILL_TIMING);
  }, [fill, props.fraction]);
  const sweeping = indeterminate && focused && !reduced && width > 0;
  useEffect(() => {
    if (!sweeping) {
      cancelAnimation(sweep);
      return;
    }
    sweep.value = 0;
    sweep.value = withRepeat(
      withTiming(1, { duration: 1800, easing: Easing.inOut(Easing.quad) }),
      -1,
      false,
    );
    return () => cancelAnimation(sweep);
  }, [sweep, sweeping]);
  const fillStyle = useAnimatedStyle(
    () => ({ width: Math.max(fill.value, 0.02) * width }),
    [width],
  );
  const sweepStyle = useAnimatedStyle(
    () => ({ transform: [{ translateX: width * 1.4 * sweep.value - width * 0.4 }] }),
    [width],
  );
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={
        props.fraction === null
          ? undefined
          : { min: 0, max: 100, now: Math.round(props.fraction * 100) }
      }
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      className={cn(
        "overflow-hidden rounded-full bg-subtle-strong",
        props.size === "mini" ? "h-[3px]" : "h-1",
        props.className,
      )}
    >
      {indeterminate ? (
        <Animated.View
          className="h-full rounded-full bg-primary/40"
          style={
            reduced || !focused ? { width: width * 0.5 } : [{ width: width * 0.4 }, sweepStyle]
          }
        />
      ) : (
        <Animated.View className="h-full rounded-full bg-primary" style={fillStyle} />
      )}
    </View>
  );
}

/** Time left; press and hold shows the expected finish in ET instead. */
function TimeLabel(props: {
  readonly children: string;
  readonly finish: string | null;
  readonly className?: string;
}) {
  const [showFinish, setShowFinish] = useState(false);
  const text = (
    <Text numberOfLines={1} className={cn("tabular-nums", props.className)}>
      {showFinish && props.finish !== null ? props.finish : props.children}
    </Text>
  );
  if (props.finish === null) return text;
  return (
    <Pressable
      accessibilityRole="text"
      accessibilityLabel={`${props.children}, ${props.finish}`}
      delayLongPress={250}
      hitSlop={8}
      onLongPress={() => {
        void Promise.resolve(Haptics.selectionAsync()).catch(() => undefined);
        setShowFinish(true);
      }}
      onPressOut={() => setShowFinish(false)}
    >
      {text}
    </Pressable>
  );
}

function StageMark({ status }: { readonly status: LiveProgressCardStage["status"] }) {
  if (status === "done")
    return (
      <SymbolView
        name="checkmark"
        size={10}
        weight="semibold"
        tintColorClassName="accent-adaptive-emerald-600-400"
      />
    );
  return (
    <View className="size-[10px] items-center justify-center">
      <View
        className={cn(
          "size-[6px] rounded-full",
          status === "active" ? "bg-primary" : "border border-foreground-tertiary",
        )}
      />
    </View>
  );
}

function StageRow({ stage }: { readonly stage: LiveProgressCardStage }) {
  return (
    <View className="min-h-[26px] flex-row items-center gap-2.5">
      <StageMark status={stage.status} />
      <Text
        numberOfLines={1}
        className={cn(
          "min-w-0 flex-1 text-sm",
          stage.status === "active"
            ? "font-t3-medium text-foreground"
            : stage.status === "done"
              ? "text-foreground-muted"
              : "text-foreground-tertiary",
        )}
      >
        {stage.title}
      </Text>
      {stage.status === "active" && stage.fraction !== null ? (
        <LiveProgressBar fraction={stage.fraction} size="mini" className="w-12" />
      ) : null}
      {stage.label ? (
        <TimeLabel finish={stage.finishLabel} className="text-xs text-foreground-muted">
          {stage.label}
        </TimeLabel>
      ) : null}
    </View>
  );
}

/**
 * The full card: what the agent is on and the time left, the bar, its stages around the current
 * one (all of them on request) and its newest updates.
 */
export function LiveProgressCardBody(props: {
  readonly progress: OrchestrationV2LiveProgress;
  /** Shown when the agent sent updates but no stages. */
  readonly fallbackTitle: string;
}) {
  const card = useLiveProgressCard(props.progress);
  const [expanded, setExpanded] = useState(false);
  if (card === null) return null;
  const [start, end] = card.collapsedRange;
  const hidden = card.stages.length - (end - start);
  const shown = expanded ? card.stages : card.stages.slice(start, end);
  const title = card.title ?? props.fallbackTitle;
  return (
    <View accessibilityLabel="Live progress" className="gap-3">
      <View className="gap-2">
        <View className="min-w-0 flex-row items-baseline gap-3">
          <Text
            numberOfLines={2}
            className="min-w-0 flex-1 font-t3-medium text-base text-foreground"
          >
            {title}
          </Text>
          {card.timeLeft ? (
            <TimeLabel finish={card.finishLabel} className="text-sm text-foreground-muted">
              {card.timeLeft}
            </TimeLabel>
          ) : null}
        </View>
        <LiveProgressBar fraction={card.fraction} />
      </View>
      {card.stages.length > 0 ? (
        <View>
          {shown.map((stage, index) => (
            <StageRow key={`${expanded ? index : start + index}:${stage.title}`} stage={stage} />
          ))}
          {hidden > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded }}
              onPress={() => {
                void Promise.resolve(Haptics.selectionAsync()).catch(() => undefined);
                setExpanded((value) => !value);
              }}
              hitSlop={6}
              className="min-h-[32px] flex-row items-center gap-2 active:opacity-60"
            >
              <SymbolView
                name={expanded ? "chevron.up" : "chevron.down"}
                size={10}
                tintColorClassName="accent-icon-subtle"
              />
              <Text className="text-xs text-foreground-muted">
                {expanded ? "Fewer stages" : `All ${card.stages.length} stages`}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {card.updates.length > 0 ? (
        <View className="gap-1.5 border-t border-border-subtle pt-3">
          {card.updates.map((update, index) => (
            <View key={update.at} className="flex-row items-baseline gap-3">
              <Text
                numberOfLines={2}
                className={cn(
                  "min-w-0 flex-1 text-sm leading-5",
                  index === 0 ? "text-foreground" : "text-foreground-muted",
                )}
              >
                {update.text}
              </Text>
              <Text className="text-xs text-foreground-tertiary">{update.age}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

/** Inside a subagent's row: the bar, time left and its latest update on one line. */
export function LiveProgressCompact(props: { readonly progress: OrchestrationV2LiveProgress }) {
  const card = useLiveProgressCard(props.progress);
  if (card === null) return null;
  return (
    <View className="gap-1 pt-1">
      <View className="flex-row items-center gap-2">
        <LiveProgressBar fraction={card.fraction} size="mini" className="min-w-0 flex-1" />
        {card.compactTimeLeft ? (
          <Text className="text-xs text-foreground-muted">{card.compactTimeLeft}</Text>
        ) : null}
      </View>
      {card.latestUpdate ? (
        <Text numberOfLines={1} className="text-xs text-foreground-muted">
          {card.latestUpdate}
        </Text>
      ) : null}
    </View>
  );
}
