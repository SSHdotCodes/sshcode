import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from "react";
import { Pressable, View, type AccessibilityActionEvent } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { AppText as Text } from "../../../components/AppText";

// The Text size slider's look (FontSizeSliderRow): thin track, primary fill, round thumb.
const THUMB_SIZE = 26;
const TRACK_HEIGHT = 4;
const STOP_SIZE = 6;
const SNAP = { duration: 120 } as const;

function lightTick() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
}

/** Where stop `index` of `count` sits, as a fraction of the row: the center of its column. */
function stopCenter(index: number, count: number): number {
  "worklet";
  return (2 * index + 1) / (2 * count);
}

/**
 * Settings > Agents on the phone: one slider per level set. The thumb snaps from stop to
 * stop with a light haptic, the level names under the stops are tappable, and a small dot
 * above Default's stop marks today's behavior.
 */
export function AgentLevelSliderRow(props: {
  readonly label: string;
  readonly options: ReadonlyArray<string>;
  readonly index: number;
  readonly defaultIndex: number;
  readonly copy: string;
  readonly footnote?: ReactNode;
  readonly disabled?: boolean;
  /** Locked against stray taps: readable, but the slider and names don't move. */
  readonly locked?: boolean;
  /** A tap on a locked slider, so the screen can point at the lock. */
  readonly onLockedPress?: () => void;
  readonly onChange: (index: number) => void;
}) {
  const { options, index, defaultIndex } = props;
  const disabled = props.disabled === true || props.locked === true;
  const locked = props.locked === true && props.disabled !== true;
  const count = options.length;
  const last = count - 1;
  const onChange = useRef(props.onChange);
  const onLockedPress = useRef(props.onLockedPress);
  useLayoutEffect(() => {
    onChange.current = props.onChange;
    onLockedPress.current = props.onLockedPress;
  });

  const progress = useSharedValue(index / last);
  const trackWidth = useSharedValue(0);
  const dragging = useSharedValue(false);
  const dragStop = useSharedValue(index);

  useEffect(() => {
    if (!dragging.value) progress.value = withTiming(index / last, SNAP);
  }, [dragging, index, last, progress]);

  const commit = useCallback((stop: number) => {
    onChange.current(stop);
  }, []);
  const lockedTap = useCallback(() => {
    onLockedPress.current?.();
  }, []);

  const gesture = useMemo(() => {
    const stopAt = (x: number): number => {
      "worklet";
      const width = trackWidth.value;
      if (width <= 0) return 0;
      const edge = width / (2 * count);
      const fraction = (x - edge) / Math.max(1, width - 2 * edge);
      return Math.min(last, Math.max(0, Math.round(fraction * last)));
    };
    const pan = Gesture.Pan()
      .enabled(!disabled)
      .activeOffsetX([-6, 6])
      .failOffsetY([-12, 12])
      .onStart((event) => {
        dragging.value = true;
        dragStop.value = stopAt(event.x);
        progress.value = withTiming(dragStop.value / last, SNAP);
      })
      .onUpdate((event) => {
        const stop = stopAt(event.x);
        if (stop === dragStop.value) return;
        dragStop.value = stop;
        progress.value = withTiming(stop / last, SNAP);
        runOnJS(lightTick)();
      })
      .onFinalize((_event, success) => {
        if (!dragging.value) return;
        dragging.value = false;
        if (!success) {
          progress.value = withTiming(index / last, SNAP);
          return;
        }
        if (dragStop.value !== index) runOnJS(commit)(dragStop.value);
      });
    // Locked, a tap only points at the lock; drags fall through to scrolling.
    const tap = Gesture.Tap()
      .enabled(!disabled || locked)
      .onEnd((event) => {
        if (locked) {
          runOnJS(lockedTap)();
          return;
        }
        const stop = stopAt(event.x);
        if (stop === index) return;
        progress.value = withTiming(stop / last, SNAP);
        runOnJS(lightTick)();
        runOnJS(commit)(stop);
      });
    return Gesture.Race(pan, tap);
  }, [
    commit,
    count,
    disabled,
    dragStop,
    dragging,
    index,
    last,
    locked,
    lockedTap,
    progress,
    trackWidth,
  ]);

  // The fill runs from the first stop to the thumb; the thumb rides between the outer stops.
  const fillStyle = useAnimatedStyle(() => ({
    width: (progress.value * trackWidth.value * last) / count,
  }));
  const thumbStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX:
          trackWidth.value * stopCenter(0, count) +
          (progress.value * trackWidth.value * last) / count -
          THUMB_SIZE / 2,
      },
    ],
  }));

  const select = (stop: number) => {
    if (disabled || stop === index) return;
    lightTick();
    commit(stop);
  };
  const handleAccessibilityAction = (event: AccessibilityActionEvent) => {
    if (event.nativeEvent.actionName === "increment") select(Math.min(last, index + 1));
    else if (event.nativeEvent.actionName === "decrement") select(Math.max(0, index - 1));
  };
  const inset = `${stopCenter(0, count) * 100}%` as const;

  return (
    <View
      className={props.disabled ? "gap-2 px-4 pt-4 pb-3 opacity-[0.45]" : "gap-2 px-4 pt-4 pb-3"}
    >
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 text-base text-foreground">{props.label}</Text>
        <Text className="text-base font-t3-medium text-foreground-muted">{options[index]}</Text>
      </View>
      <GestureDetector gesture={gesture}>
        <View
          accessible
          accessibilityActions={[
            { name: "increment", label: `More ${props.label}` },
            { name: "decrement", label: `Less ${props.label}` },
          ]}
          accessibilityLabel={props.label}
          accessibilityRole="adjustable"
          accessibilityState={{ disabled: Boolean(disabled) }}
          accessibilityValue={{ min: 0, max: last, now: index, text: options[index] }}
          className="h-11 justify-center"
          style={props.locked ? { opacity: 0.5 } : undefined}
          onAccessibilityAction={handleAccessibilityAction}
          onLayout={(event) => {
            trackWidth.value = event.nativeEvent.layout.width;
          }}
        >
          {defaultIndex >= 0 ? (
            <View
              pointerEvents="none"
              className="absolute top-0 size-1 rounded-full bg-foreground-muted"
              style={{ left: `${stopCenter(defaultIndex, count) * 100}%`, marginLeft: -2 }}
            />
          ) : null}
          <View
            pointerEvents="none"
            className="absolute rounded-full bg-foreground/15"
            style={{ left: inset, right: inset, height: TRACK_HEIGHT, top: "50%", marginTop: -2 }}
          >
            <Animated.View
              className="absolute inset-y-0 left-0 rounded-full bg-primary"
              style={fillStyle}
            />
          </View>
          {options.map((option, stop) => (
            <View
              key={option}
              pointerEvents="none"
              className={
                stop <= index
                  ? "absolute rounded-full bg-primary"
                  : "absolute rounded-full bg-foreground-muted"
              }
              style={{
                left: `${stopCenter(stop, count) * 100}%`,
                top: "50%",
                width: STOP_SIZE,
                height: STOP_SIZE,
                marginLeft: -STOP_SIZE / 2,
                marginTop: -STOP_SIZE / 2,
                opacity: stop <= index ? 1 : 0.45,
              }}
            />
          ))}
          <Animated.View
            pointerEvents="none"
            className="absolute left-0 rounded-full border-border bg-primary-foreground"
            style={[
              {
                borderWidth: 1,
                height: THUMB_SIZE,
                marginTop: -THUMB_SIZE / 2,
                shadowColor: "#000000",
                shadowOffset: { height: 2, width: 0 },
                shadowOpacity: 0.18,
                shadowRadius: 3,
                top: "50%",
                width: THUMB_SIZE,
              },
              thumbStyle,
            ]}
          />
        </View>
      </GestureDetector>
      <View
        className="flex-row"
        importantForAccessibility="no-hide-descendants"
        // Names stay readable while locked (muted text at 0.5 was too faint in dark mode).
        style={props.locked ? { opacity: 0.75 } : undefined}
      >
        {options.map((option, stop) => (
          <Pressable
            key={option}
            accessibilityElementsHidden
            className="flex-1 items-center py-1 active:opacity-60"
            disabled={props.disabled}
            hitSlop={{ top: 6, bottom: 6 }}
            onPress={() => (locked ? lockedTap() : select(stop))}
          >
            <Text
              className={
                stop === index
                  ? "text-sm font-t3-medium text-foreground"
                  : "text-sm text-foreground-muted"
              }
            >
              {option}
            </Text>
          </Pressable>
        ))}
      </View>
      <Text className="text-sm text-foreground-muted">{props.copy}</Text>
      {props.footnote}
    </View>
  );
}
