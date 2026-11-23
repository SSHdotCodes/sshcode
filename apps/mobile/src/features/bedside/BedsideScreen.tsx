import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useKeepAwake } from "expo-keep-awake";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AppState, Modal, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import Animated, {
  cancelAnimation,
  runOnJS,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { homeThreadShells } from "../../state/threads";
import { useWorkspaceEnvironments } from "../../state/workspace";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import {
  bedsideOffset,
  bedsideSummaryParts,
  buildBedsideSnapshot,
  formatBedsideClock,
  formatBedsideDate,
  msUntilNextMinute,
  type BedsideRow,
} from "./bedsideModel";
import { deviceUses24Hour } from "./useBedsideScreen";

const FADE_MS = 400;
const white = (opacity: number) => `rgba(255,255,255,${opacity})`;

/**
 * Full-screen black clock with live chat status. Mounts nothing while hidden;
 * fades out before unmounting. A tap anywhere calls `onExit`; a tap on a row
 * also passes its chat to `onOpenThread` when given.
 */
export function BedsideScreen(props: {
  readonly visible: boolean;
  readonly onExit: () => void;
  readonly onOpenThread?: (thread: EnvironmentThreadShell) => void;
}) {
  const [mounted, setMounted] = useState(props.visible);
  const onHidden = useCallback(() => setMounted(false), []);
  if (props.visible && !mounted) setMounted(true);
  if (!mounted) return null;
  return (
    <Modal
      visible
      transparent
      animationType="none"
      statusBarTranslucent
      navigationBarTranslucent
      supportedOrientations={["portrait"]}
      onRequestClose={props.onExit}
    >
      <BedsideContent {...props} onHidden={onHidden} />
    </Modal>
  );
}

function BedsideContent(props: {
  readonly visible: boolean;
  readonly onExit: () => void;
  readonly onOpenThread?: (thread: EnvironmentThreadShell) => void;
  readonly onHidden: () => void;
}) {
  useKeepAwake("bedside-screen");
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const { themeVariablesByAppearance } = useAppearancePreferences();
  const attention = themeVariablesByAppearance.dark["--color-warning-foreground"];
  const danger = themeVariablesByAppearance.dark["--color-danger-foreground"];

  const { onExit, onHidden, visible } = props;
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") onExit();
    });
    return () => subscription.remove();
  }, [onExit]);

  const fade = useSharedValue(0);
  useEffect(() => {
    fade.value = withTiming(visible ? 1 : 0, { duration: FADE_MS }, (finished) => {
      if (finished && !visible) runOnJS(onHidden)();
    });
  }, [fade, onHidden, visible]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: fade.value }));

  const hint = useSharedValue(1);
  useEffect(() => {
    hint.value = withDelay(5_000, withTiming(0, { duration: 600 }));
  }, [hint]);
  const hintStyle = useAnimatedStyle(() => ({ opacity: hint.value }));

  // One tick per minute moves the clock, the elapsed labels and the burn-in offset.
  const [now, setNow] = useState(() => Date.now());
  const [step, setStep] = useState(0);
  useEffect(() => {
    const timeout = setTimeout(() => {
      setNow(Date.now());
      setStep((value) => value + 1);
    }, msUntilNextMinute(now));
    return () => clearTimeout(timeout);
  }, [now]);
  const [uses24Hour] = useState(deviceUses24Hour);

  const offsetX = useSharedValue(0);
  const offsetY = useSharedValue(0);
  useEffect(() => {
    const { x, y } = bedsideOffset(step);
    if (reduceMotion) {
      offsetX.value = x;
      offsetY.value = y;
    } else {
      offsetX.value = withTiming(x, { duration: 2_000 });
      offsetY.value = withTiming(y, { duration: 2_000 });
    }
  }, [offsetX, offsetY, reduceMotion, step]);
  const offsetStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offsetX.value }, { translateY: offsetY.value }],
  }));

  // The same shells Home lists, live for as long as the screen shows.
  const allThreads = useAtomValue(homeThreadShells.threadShellsAtom);
  const environments = useWorkspaceEnvironments();
  const snapshot = useMemo(
    () =>
      buildBedsideSnapshot({
        threads: allThreads,
        now,
        connectionPhases: new Map(
          environments.map((environment) => [
            environment.environmentId,
            environment.connectionState,
          ]),
        ),
      }),
    [allThreads, environments, now],
  );

  const pulse = useSharedValue(1);
  const pulsing = !reduceMotion && snapshot.rows.some((row) => row.state === "working");
  useEffect(() => {
    if (!pulsing) {
      cancelAnimation(pulse);
      pulse.value = 1;
      return;
    }
    pulse.value = 0.4;
    pulse.value = withRepeat(withTiming(1, { duration: 800 }), -1, true);
    return () => cancelAnimation(pulse);
  }, [pulse, pulsing]);

  const date = new Date(now);
  const clock = formatBedsideClock(date, uses24Hour);
  const summary = bedsideSummaryParts(snapshot);

  return (
    <Animated.View style={[StyleSheet.absoluteFill, styles.screen, fadeStyle]}>
      <StatusBar hidden />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Return to chats"
        style={styles.pressable}
        onPress={onExit}
      >
        <Animated.View style={[styles.block, offsetStyle]}>
          <View style={styles.clockRow}>
            <Text
              allowFontScaling={false}
              adjustsFontSizeToFit
              numberOfLines={1}
              style={styles.clock}
            >
              {clock.time}
            </Text>
            {clock.period ? (
              <Text allowFontScaling={false} style={styles.period}>
                {clock.period}
              </Text>
            ) : null}
          </View>
          <Text maxFontSizeMultiplier={1.3} style={styles.date}>
            {formatBedsideDate(date)}
          </Text>
          <Text maxFontSizeMultiplier={1.3} style={styles.summary}>
            {summary.length === 0 ? (
              <Text style={{ color: white(0.45) }}>All quiet</Text>
            ) : (
              summary.map((part, index) => (
                <Text key={part.tone}>
                  {index > 0 ? <Text style={{ color: white(0.45) }}> · </Text> : null}
                  <Text style={{ color: part.tone === "attention" ? attention : white(0.7) }}>
                    {part.text}
                  </Text>
                </Text>
              ))
            )}
          </Text>
          <View style={styles.rows}>
            {snapshot.rows.map((row) => (
              <BedsideRowView
                key={row.key}
                row={row}
                attention={attention}
                danger={danger}
                pulse={pulse}
                onPress={() => {
                  onExit();
                  props.onOpenThread?.(row.thread);
                }}
              />
            ))}
            {snapshot.more > 0 ? (
              <Text maxFontSizeMultiplier={1.3} style={styles.more}>
                +{snapshot.more} more
              </Text>
            ) : null}
          </View>
        </Animated.View>
        <Animated.Text
          maxFontSizeMultiplier={1.3}
          style={[styles.hint, { bottom: insets.bottom + 24 }, hintStyle]}
        >
          Tap to return
        </Animated.Text>
      </Pressable>
    </Animated.View>
  );
}

function BedsideRowView(props: {
  readonly row: BedsideRow;
  readonly attention: string;
  readonly danger: string;
  readonly pulse: SharedValue<number>;
  readonly onPress: () => void;
}) {
  const { row } = props;
  const pulseStyle = useAnimatedStyle(() => ({ opacity: props.pulse.value }));
  const dot =
    row.state === "working" ? (
      <Animated.View style={[styles.dot, { backgroundColor: white(1) }, pulseStyle]} />
    ) : row.state === "finished" ? (
      <View style={[styles.dot, styles.hollowDot]} />
    ) : (
      <View
        style={[
          styles.dot,
          { backgroundColor: row.state === "needsYou" ? props.attention : props.danger },
        ]}
      />
    );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${row.thread.title}, ${row.label || "Working"}`}
      style={styles.row}
      onPress={props.onPress}
    >
      {dot}
      <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.title}>
        {row.thread.title}
      </Text>
      <Text maxFontSizeMultiplier={1.3} style={styles.label}>
        {row.label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { backgroundColor: "#000" },
  pressable: { flex: 1, alignItems: "center", justifyContent: "center", paddingBottom: 72 },
  block: { width: "100%", maxWidth: 420, paddingHorizontal: 28, alignItems: "center" },
  clockRow: { flexDirection: "row", alignItems: "baseline" },
  // Shrinks instead of clipping on narrow phones.
  clock: {
    flexShrink: 1,
    fontSize: 112,
    fontWeight: "200",
    fontVariant: ["tabular-nums"],
    color: white(0.92),
    letterSpacing: -2,
  },
  period: { marginLeft: 8, fontSize: 22, fontWeight: "400", color: white(0.55) },
  date: { fontSize: 17, color: white(0.55) },
  summary: { marginTop: 28, fontSize: 15, fontWeight: "500" },
  rows: { marginTop: 16, alignSelf: "stretch" },
  row: { height: 44, flexDirection: "row", alignItems: "center", gap: 12 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  hollowDot: { borderWidth: 1.5, borderColor: white(0.35) },
  title: { flex: 1, fontSize: 17, color: white(0.85) },
  label: { fontSize: 15, color: white(0.5), fontVariant: ["tabular-nums"] },
  more: { marginTop: 4, fontSize: 13, color: white(0.4) },
  hint: { position: "absolute", alignSelf: "center", fontSize: 12, color: white(0.28) },
});
