import {
  effortChoiceLabel,
  effortChoices,
  type ReasoningDescriptor,
} from "@t3tools/client-runtime/composer-model-display";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withSpring,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";
import { useResolveClassNames } from "uniwind";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { ChoiceRow } from "./ThreadSettingsRows";

const THUMB = 26;
const TRACK = 6;
// The thumb row; the stop labels sit under it.
const RAIL_HEIGHT = 34;
const RAIL_CENTER = RAIL_HEIGHT / 2;
const SHIMMER = 56;
const SPRING = { damping: 17, stiffness: 260, mass: 0.7, reduceMotion: ReduceMotion.System };

// Glow strength per effects tier (see effortChoices): calm at Low, blazing at Ultracode.
const GLOW = [0.18, 0.4, 0.55, 0.7, 0.85] as const;
// Shimmer sweep and rest, in ms, from XHigh up; each tier sweeps faster.
const SHIMMER_TIMING = { 2: [2200, 700], 3: [1500, 450], 4: [1100, 250] } as const;
const EMBERS = [
  { delay: 0, drift: -7, color: "#FFC864" },
  { delay: 260, drift: 5, color: "#F28C4A" },
  { delay: 540, drift: -2, color: "#FFE3A3" },
  { delay: 800, drift: 8, color: "#E07A50" },
  { delay: 1060, drift: -9, color: "#FFC864" },
] as const;

/**
 * Reasoning effort as a slider in the theme colour. The fill deepens as the effort rises and the
 * effects build with it: High glows, XHigh shimmers, Max breathes, and Ultracode turns warm and
 * throws embers off the thumb. The thumb springs to each stop and ticks once per stop it passes.
 * Reduce Motion keeps the colours and drops the motion.
 */
export function ThreadSettingsEffort(props: {
  readonly label: string;
  readonly options: ReasoningDescriptor["options"];
  readonly value: string | boolean | undefined;
  readonly disabled?: boolean;
  readonly isLast: boolean;
  readonly onPick: (id: string) => void;
}) {
  const { options, value, disabled, onPick } = props;
  const { levels, otherChoices } = useMemo(() => effortChoices(options), [options]);
  const reduced = useReducedMotion();
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  // A released stop holds until the pick comes back as the value, so the thumb never springs
  // back to the old stop for a frame.
  const [pendingIndex, setPendingIndex] = useState<number | null>(null);
  const [width, setWidth] = useState(0);
  const selectedIndex = levels.findIndex((level) => level.id === value);
  if (pendingIndex !== null && pendingIndex === selectedIndex) setPendingIndex(null);
  const restingIndex = pendingIndex ?? selectedIndex;
  const activeIndex = dragIndex ?? restingIndex;
  const active = levels[activeIndex];
  const currentChoice = active ?? options.find((option) => option.id === value);
  const currentLabel = currentChoice ? effortChoiceLabel(currentChoice) : null;
  const count = levels.length;
  // Each stop sits at the centre of its label's cell.
  const cell = count > 0 ? width / count : 0;
  const start = cell / 2;
  const end = width - cell / 2;
  const stopX = useCallback((index: number) => start + cell * index, [cell, start]);
  const indexAt = useCallback(
    (x: number) =>
      cell > 0 ? Math.max(0, Math.min(count - 1, Math.round((x - start) / cell))) : -1,
    [cell, count, start],
  );

  const thumbX = useSharedValue(0);
  const pressed = useSharedValue(0);
  const shimmer = useSharedValue(0);
  const pulse = useSharedValue(0);
  const placed = useRef(false);
  // The last stop the finger ticked, so a release on it does not tick again.
  const ticked = useRef<number | null>(null);

  useEffect(() => {
    if (width === 0 || restingIndex < 0 || dragIndex !== null) return;
    const target = stopX(restingIndex);
    if (!placed.current) {
      placed.current = true;
      thumbX.set(target);
    } else {
      thumbX.set(withSpring(target, SPRING));
    }
  }, [dragIndex, restingIndex, stopX, thumbX, width]);

  const fx = active?.fx ?? 0;
  useEffect(() => {
    cancelAnimation(shimmer);
    cancelAnimation(pulse);
    shimmer.set(0);
    pulse.set(0);
    if (reduced) return;
    if (fx >= 2) {
      const [sweep, rest] = SHIMMER_TIMING[fx >= 4 ? 4 : fx >= 3 ? 3 : 2];
      shimmer.set(
        withRepeat(
          withSequence(
            withTiming(1, { duration: sweep, easing: Easing.inOut(Easing.quad) }),
            withTiming(1, { duration: rest }),
            withTiming(0, { duration: 0 }),
          ),
          -1,
        ),
      );
    }
    if (fx >= 3) {
      pulse.set(
        withRepeat(
          withTiming(1, { duration: fx >= 4 ? 800 : 1100, easing: Easing.inOut(Easing.sin) }),
          -1,
          true,
        ),
      );
    }
  }, [fx, pulse, reduced, shimmer]);

  const select = useCallback(
    (id: string) => {
      if (disabled || id === value) return;
      // Landing on Ultracode lands with a thump.
      if (levels.find((level) => level.id === id)?.fx === 4) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
      }
      onPick(id);
    },
    [disabled, levels, onPick, value],
  );

  const tick = useCallback((index: number) => {
    if (ticked.current === index) return;
    ticked.current = index;
    Haptics.selectionAsync().catch(() => undefined);
  }, []);

  const gesture = useMemo(() => {
    const clamp = (x: number) => Math.max(start, Math.min(end, x));
    const release = (x: number) => {
      const index = indexAt(x);
      const choice = levels[index];
      if (index >= 0) thumbX.set(withSpring(stopX(index), SPRING));
      if (choice && choice.id !== value) {
        tick(index);
        setPendingIndex(index);
        select(choice.id);
      }
    };
    return Gesture.Race(
      Gesture.Pan()
        .enabled(!disabled && count > 1)
        .runOnJS(true)
        .activeOffsetX([-6, 6])
        .failOffsetY([-14, 14])
        .onBegin(() => {
          ticked.current = selectedIndex;
          pressed.set(withTiming(1, { duration: 120 }));
        })
        .onUpdate((event) => {
          thumbX.set(clamp(event.x));
          const index = indexAt(event.x);
          if (index !== dragIndex) setDragIndex(index);
          tick(index);
        })
        .onEnd((event) => release(event.x))
        .onFinalize(() => {
          pressed.set(withTiming(0, { duration: 160 }));
          setDragIndex(null);
        }),
      Gesture.Tap()
        .enabled(!disabled)
        .runOnJS(true)
        .onEnd((event, success) => {
          if (!success) return;
          ticked.current = selectedIndex;
          release(event.x);
        }),
    );
  }, [
    count,
    disabled,
    dragIndex,
    end,
    indexAt,
    levels,
    pressed,
    select,
    selectedIndex,
    start,
    stopX,
    thumbX,
    tick,
    value,
  ]);

  // The text-weight accent, as the composer's dial uses.
  const primary = StyleSheet.flatten(useResolveClassNames("text-primary-text"))?.color;
  // The theme colour, or Ultracode's own warm accent.
  const tone = active?.accent ?? (typeof primary === "string" ? primary : "#346BF1");
  const glow = GLOW[fx] ?? GLOW[0];
  const fillStyle = useAnimatedStyle(() => ({
    width: Math.max(0, thumbX.value - start),
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: thumbX.value - THUMB / 2 }, { scale: 1 + 0.14 * pressed.value }],
  }));
  const fillGlowStyle = useAnimatedStyle(() => ({
    width: Math.max(0, thumbX.value - start),
    shadowOpacity: 0.45 + 0.4 * pulse.value,
    shadowRadius: 4 + 4 * pulse.value,
  }));
  const emberStyle = useAnimatedStyle(() => ({ transform: [{ translateX: thumbX.value }] }));
  const glowStyle = useAnimatedStyle(() => ({
    shadowOpacity: Math.min(1, glow + 0.2 * pulse.value),
    shadowRadius: 4 + 10 * glow + 6 * pulse.value,
    transform: [{ translateX: thumbX.value - THUMB / 2 }, { scale: 1 + 0.14 * pressed.value }],
  }));
  const shimmerStyle = useAnimatedStyle(() => ({
    opacity: shimmer.value > 0 && shimmer.value < 1 ? 1 : 0,
    transform: [{ translateX: -SHIMMER + shimmer.value * (end - start + SHIMMER) }],
  }));

  return (
    <View className={cn(!props.isLast && "border-b border-border-subtle")}>
      <View className={cn("px-4 pt-2 pb-1", disabled && "opacity-50")}>
        <View className="flex-row items-center justify-between gap-2">
          <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
          {currentLabel ? (
            <Text className="text-sm text-foreground-muted">{currentLabel}</Text>
          ) : null}
        </View>
        {count > 0 ? (
          <GestureDetector gesture={gesture}>
            <View
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel={props.label}
              accessibilityState={{ disabled }}
              accessibilityValue={{
                min: 0,
                max: count - 1,
                ...(selectedIndex >= 0 ? { now: selectedIndex } : {}),
                ...(currentLabel ? { text: currentLabel } : {}),
              }}
              accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
              onAccessibilityAction={(event) => {
                const direction = event.nativeEvent.actionName === "increment" ? 1 : -1;
                const next = levels[Math.max(0, Math.min(count - 1, selectedIndex + direction))];
                if (next) select(next.id);
              }}
              className="pt-1"
              onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
            >
              <View style={{ height: RAIL_HEIGHT }}>
                {count > 1 && width > 0 ? (
                  <>
                    <View
                      className="absolute rounded-full bg-subtle-strong"
                      style={{
                        left: start,
                        width: end - start,
                        top: RAIL_CENTER - TRACK / 2,
                        height: TRACK,
                      }}
                    />
                    {fx >= 3 ? (
                      <Animated.View
                        pointerEvents="none"
                        className="absolute rounded-full"
                        style={[
                          {
                            left: start,
                            top: RAIL_CENTER - TRACK / 2,
                            height: TRACK,
                            backgroundColor: tone,
                            shadowColor: tone,
                            shadowOffset: { width: 0, height: 0 },
                          },
                          fillGlowStyle,
                        ]}
                      />
                    ) : null}
                    <Animated.View
                      className="absolute overflow-hidden rounded-full"
                      style={[
                        { left: start, top: RAIL_CENTER - TRACK / 2, height: TRACK },
                        fillStyle,
                      ]}
                    >
                      <Svg width={end - start} height={TRACK}>
                        <Defs>
                          {/* Paler at Low, full strength at the top: deeper thinking reads deeper. */}
                          <LinearGradient id="effort-fill" x1="0" y1="0" x2="1" y2="0">
                            <Stop offset={0} stopColor={tone} stopOpacity={0.4} />
                            <Stop offset={fx >= 4 ? 0.7 : 1} stopColor={tone} stopOpacity={1} />
                            {/* Ultracode burns hottest at the tip. */}
                            <Stop
                              offset={1}
                              stopColor={fx >= 4 ? "#FFC864" : tone}
                              stopOpacity={1}
                            />
                          </LinearGradient>
                          <LinearGradient id="effort-shine" x1="0" y1="0" x2="1" y2="0">
                            <Stop offset={0} stopColor="#FFFFFF" stopOpacity={0} />
                            <Stop offset={0.5} stopColor="#FFFFFF" stopOpacity={0.75} />
                            <Stop offset={1} stopColor="#FFFFFF" stopOpacity={0} />
                          </LinearGradient>
                        </Defs>
                        <Rect width={end - start} height={TRACK} fill="url(#effort-fill)" />
                      </Svg>
                      <Animated.View
                        pointerEvents="none"
                        className="absolute inset-y-0 left-0"
                        style={[{ width: SHIMMER }, shimmerStyle]}
                      >
                        <Svg width={SHIMMER} height={TRACK}>
                          <Rect width={SHIMMER} height={TRACK} fill="url(#effort-shine)" />
                        </Svg>
                      </Animated.View>
                    </Animated.View>
                  </>
                ) : null}
                {width > 0
                  ? levels.map((level, index) => (
                      <View
                        key={level.id}
                        pointerEvents="none"
                        className={cn(
                          "absolute size-1 rounded-full",
                          index <= activeIndex ? "bg-white/80" : "bg-foreground-tertiary",
                        )}
                        style={{ left: stopX(index) - 2, top: RAIL_CENTER - 2 }}
                      />
                    ))
                  : null}
                {width > 0 && activeIndex >= 0 ? (
                  <>
                    <Animated.View
                      pointerEvents="none"
                      className="absolute rounded-full"
                      style={[
                        {
                          left: 0,
                          top: RAIL_CENTER - THUMB / 2,
                          width: THUMB,
                          height: THUMB,
                          // The thumb covers this disc; only its blurred shadow shows, as a glow.
                          backgroundColor: tone,
                          shadowColor: tone,
                          shadowOffset: { width: 0, height: 0 },
                        },
                        glowStyle,
                      ]}
                    />
                    <Animated.View
                      pointerEvents="none"
                      className="absolute rounded-full bg-white"
                      style={[
                        {
                          left: 0,
                          top: RAIL_CENTER - THUMB / 2,
                          width: THUMB,
                          height: THUMB,
                          borderWidth: 3,
                          borderColor: tone,
                          shadowColor: "#000000",
                          shadowOpacity: 0.25,
                          shadowRadius: 3,
                          shadowOffset: { width: 0, height: 1 },
                        },
                        thumbStyle,
                      ]}
                    />
                    {fx >= 4 && !reduced ? (
                      <Animated.View
                        pointerEvents="none"
                        className="absolute"
                        style={[{ left: 0, top: RAIL_CENTER - THUMB / 2 }, emberStyle]}
                      >
                        {EMBERS.map((ember) => (
                          <Ember key={ember.delay} {...ember} />
                        ))}
                      </Animated.View>
                    ) : null}
                  </>
                ) : null}
              </View>
              <View className="flex-row">
                {levels.map((level, index) => (
                  <View key={level.id} className="flex-1 items-center">
                    <Text
                      className={cn(
                        "text-xs",
                        index === activeIndex
                          ? "font-t3-medium text-foreground"
                          : "text-foreground-muted",
                      )}
                      numberOfLines={1}
                    >
                      {level.shortLabel}
                    </Text>
                  </View>
                ))}
              </View>
            </View>
          </GestureDetector>
        ) : null}
      </View>
      {otherChoices.map((choice, index) => (
        <ChoiceRow
          key={choice.id}
          label={effortChoiceLabel(choice)}
          selected={choice.id === value}
          isLast={index === otherChoices.length - 1}
          onPress={() => select(choice.id)}
        />
      ))}
    </View>
  );
}

/** A spark that rises off the thumb, drifts and fades, then starts again. */
function Ember(props: { readonly delay: number; readonly drift: number; readonly color: string }) {
  const rise = useSharedValue(0);
  useEffect(() => {
    rise.set(
      withDelay(
        props.delay,
        withRepeat(withTiming(1, { duration: 1300, easing: Easing.out(Easing.quad) }), -1),
      ),
    );
    return () => cancelAnimation(rise);
  }, [props.delay, rise]);
  const style = useAnimatedStyle(() => {
    const t = rise.value;
    return {
      opacity: t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85,
      transform: [
        { translateX: props.drift * t - 2 },
        { translateY: -19 * t },
        { scale: 1 - 0.6 * t },
      ],
    };
  });
  return (
    <Animated.View
      className="absolute rounded-full"
      style={[
        {
          width: 4,
          height: 4,
          backgroundColor: props.color,
          shadowColor: props.color,
          shadowOpacity: 1,
          shadowRadius: 3,
          shadowOffset: { width: 0, height: 0 },
        },
        style,
      ]}
    />
  );
}
