import { useIsFocused } from "@react-navigation/native";
import { use, useEffect, useState } from "react";
import { AccessibilityInfo, AppState, StyleSheet, View } from "react-native";
import Svg, { G, Path } from "react-native-svg";
import { useResolveClassNames } from "uniwind";
import {
  sampleWorkingDash,
  WORKING_CYCLE_MS,
  WORKING_DASH_PATH,
  WORKING_DASH_TRACKS,
  WORKING_VARIATIONS,
} from "@t3tools/client-runtime/working-indicator-motion";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { NativeWorkspaceTabActivityContext } from "../../native/v5-workspace-context";

const AnimatedG = Animated.createAnimatedComponent(G);

function WorkingDash({
  frames,
  phase,
}: {
  readonly frames: (typeof WORKING_DASH_TRACKS)[number];
  readonly phase: ReturnType<typeof useSharedValue<number>>;
}) {
  const animatedProps = useAnimatedProps(() => {
    const pose = sampleWorkingDash(frames, phase.get());
    const radians = (pose.rotation * Math.PI) / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    return {
      matrix: [cosine, sine, -sine, cosine, pose.x, pose.y],
      opacity: pose.opacity,
    };
  });
  return (
    <AnimatedG
      transform={`translate(${frames[0]!.x} ${frames[0]!.y}) rotate(${frames[0]!.rotation})`}
      animatedProps={animatedProps}
    >
      <Path d={WORKING_DASH_PATH} />
    </AnimatedG>
  );
}

/** One UI-thread clock, stopped whenever the row cannot be seen. */
export function WorkingStatusIndicator(props: {
  readonly active: boolean;
  readonly tintColorClassName: string;
}) {
  const focused = useIsFocused();
  const tabActive = use(NativeWorkspaceTabActivityContext)?.active ?? true;
  const initialReducedMotion = useReducedMotion();
  const [reducedMotion, setReducedMotion] = useState(initialReducedMotion);
  const phase = useSharedValue(0);
  const { accentColor: color } = useResolveClassNames(props.tintColorClassName);
  useEffect(() => {
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReducedMotion,
    );
    return () => subscription.remove();
  }, []);
  const [foreground, setForeground] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  useEffect(() => {
    cancelAnimation(phase);
    phase.set(0);
    if (props.active && focused && tabActive && foreground && !reducedMotion) {
      phase.set(
        withRepeat(
          withTiming(WORKING_VARIATIONS, {
            duration: WORKING_CYCLE_MS * WORKING_VARIATIONS,
            easing: Easing.linear,
            reduceMotion: ReduceMotion.System,
          }),
          -1,
          false,
          undefined,
          ReduceMotion.System,
        ),
      );
    }
    return () => cancelAnimation(phase);
  }, [props.active, focused, tabActive, foreground, reducedMotion, phase]);
  return (
    <View style={styles.container} pointerEvents="none" accessible={false}>
      <Svg
        width={13}
        height={13}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <G transform="translate(12 12)">
          {WORKING_DASH_TRACKS.map((frames) => (
            <WorkingDash key={frames[0]!.rotation} frames={frames} phase={phase} />
          ))}
        </G>
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { width: 13, height: 13, overflow: "hidden" },
});
