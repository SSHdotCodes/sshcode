import { useUiMode } from "../discord/useUiMode";
import type { ComponentProps } from "react";
import { Pressable, type GestureResponderEvent } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const PRESS_IN_TIMING = {
  duration: 70,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.System,
};
const PRESS_OUT_SPRING = {
  damping: 18,
  stiffness: 400,
  mass: 0.7,
  reduceMotion: ReduceMotion.System,
};

/** Primary actions in the cards that replace the thread composer. */
export function RequestActionButton({
  label,
  tone = "primary",
  size = "default",
  disabled,
  onPressIn,
  onPressOut,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children" | "className" | "style"> & {
  label: string;
  tone?: "primary" | "secondary" | "danger" | "success";
  size?: "default" | "large";
}) {
  const [uiMode] = useUiMode();
  const discord = uiMode === "discord";
  const pressScale = useSharedValue(1);
  const pressStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pressScale.value }],
  }));

  const handlePressIn = (event: GestureResponderEvent) => {
    if (!disabled) {
      pressScale.set(withTiming(0.97, PRESS_IN_TIMING));
    }
    onPressIn?.(event);
  };

  const handlePressOut = (event: GestureResponderEvent) => {
    pressScale.set(withSpring(1, PRESS_OUT_SPRING));
    onPressOut?.(event);
  };

  return (
    <AnimatedPressable
      {...props}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      accessibilityRole="button"
      accessibilityState={{ ...props.accessibilityState, disabled: Boolean(disabled) }}
      disabled={disabled}
      style={[
        pressStyle,
        discord
          ? {
              borderRadius: 4,
              backgroundColor:
                tone === "success"
                  ? "#248046"
                  : tone === "danger"
                    ? "#DA373C"
                    : tone === "primary"
                      ? "#5865F2"
                      : "#4E5058",
            }
          : undefined,
      ]}
      className={cn(
        "min-h-[44px] min-w-[44px] items-center justify-center active:opacity-80 disabled:opacity-50",
        size === "large" ? "rounded-2xl px-4 py-3.5" : "rounded-[14px] px-3.5 py-3",
        tone === "primary" || tone === "success"
          ? "bg-primary"
          : tone === "danger"
            ? "bg-danger"
            : "bg-subtle-strong",
      )}
    >
      <Text
        style={discord ? { color: "#FFFFFF", fontWeight: "600" } : undefined}
        className={cn(
          "text-sm",
          tone === "primary"
            ? "font-t3-extrabold text-primary-foreground"
            : tone === "danger"
              ? "font-t3-bold text-danger-foreground"
              : "font-t3-bold text-foreground",
        )}
      >
        {label}
      </Text>
    </AnimatedPressable>
  );
}
