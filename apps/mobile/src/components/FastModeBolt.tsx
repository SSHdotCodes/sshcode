import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import { useResolveClassNames } from "uniwind";

import { SymbolView } from "./AppSymbol";

const SIZE = 14;

/**
 * Fast mode's bolt. Lit, it strikes as soon as it appears and then every few seconds with a
 * double flicker and a flash of glow, like the Mac's. Unlit (a Fast switch that is off) it rests
 * grey. Reduce Motion keeps it lit and still.
 */
export function FastModeBolt(props: { readonly lit?: boolean }) {
  const lit = props.lit ?? true;
  const reduced = useReducedMotion();
  const strike = useSharedValue(0);
  const glowColor = StyleSheet.flatten(
    useResolveClassNames("bg-warning-foreground"),
  )?.backgroundColor;

  useEffect(() => {
    cancelAnimation(strike);
    strike.set(0);
    if (!lit || reduced) return;
    const flash = (to: number, duration: number) =>
      withTiming(to, { duration, easing: Easing.out(Easing.quad) });
    strike.set(
      withRepeat(
        withSequence(
          flash(1, 90),
          flash(0.2, 80),
          flash(0.85, 90),
          flash(0, 280),
          withTiming(0, { duration: 2900 }),
        ),
        -1,
      ),
    );
    return () => cancelAnimation(strike);
  }, [lit, reduced, strike]);

  const boltStyle = useAnimatedStyle(() => ({
    opacity: 0.9 + 0.1 * strike.value,
    transform: [{ scale: 1 + 0.22 * strike.value }, { rotate: `${-8 * strike.value}deg` }],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.45 * strike.value,
    transform: [{ scale: 0.7 + 0.5 * strike.value }],
  }));

  return (
    <View style={{ width: SIZE, height: SIZE }}>
      {lit && typeof glowColor === "string" ? (
        <Animated.View
          pointerEvents="none"
          className="absolute rounded-full"
          style={[
            {
              inset: 0,
              backgroundColor: glowColor,
              shadowColor: glowColor,
              shadowOpacity: 0.9,
              shadowRadius: 6,
              shadowOffset: { width: 0, height: 0 },
            },
            glowStyle,
          ]}
        />
      ) : null}
      <Animated.View style={boltStyle}>
        <SymbolView
          name="bolt.fill"
          size={SIZE}
          tintColorClassName={lit ? "accent-warning-foreground" : "accent-icon-subtle"}
          type="monochrome"
        />
      </Animated.View>
    </View>
  );
}
