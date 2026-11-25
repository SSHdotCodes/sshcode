import { type ComponentProps, type ReactNode, useEffect } from "react";
import { Pressable, type GestureResponderEvent } from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { cn } from "../lib/cn";
import { useHoverGesture } from "../lib/useHoverGesture";

const RELEASE_FADE_TIMING = {
  duration: 150,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.System,
};

/** Pressability clears touch feedback when a parent takes over scrolling. */
export function RowPressable({
  children,
  className,
  interactionClassName = "bg-row-hover",
  interactionOpacity = 1,
  onPressIn,
  onPressOut,
  ...props
}: Omit<ComponentProps<typeof Pressable>, "children"> & {
  readonly children: ReactNode;
  readonly interactionClassName?: string;
  readonly interactionOpacity?: number;
}) {
  const disabled = props.disabled ?? false;
  const { hovered, hoverGesture } = useHoverGesture(disabled);
  const pressOpacity = useSharedValue(0);
  const hoverOpacity = useSharedValue(0);

  useEffect(() => {
    hoverOpacity.set(disabled || !hovered ? 0 : interactionOpacity);
    if (disabled) {
      cancelAnimation(pressOpacity);
      pressOpacity.set(0);
    }
  }, [disabled, hovered, hoverOpacity, interactionOpacity, pressOpacity]);

  const handlePressIn = (event: GestureResponderEvent) => {
    if (!disabled) {
      cancelAnimation(pressOpacity);
      pressOpacity.set(0.6 * interactionOpacity);
    }
    onPressIn?.(event);
  };

  const handlePressOut = (event: GestureResponderEvent) => {
    pressOpacity.set(withTiming(0, RELEASE_FADE_TIMING));
    onPressOut?.(event);
  };

  const overlayStyle = useAnimatedStyle(() => ({
    opacity: Math.max(hoverOpacity.value, pressOpacity.value),
  }));

  return (
    <GestureDetector gesture={hoverGesture}>
      <Pressable
        {...props}
        onPressIn={handlePressIn}
        onPressOut={handlePressOut}
        className={cn("relative overflow-hidden", className)}
      >
        <Animated.View
          pointerEvents="none"
          className={cn("absolute inset-0", interactionClassName)}
          style={overlayStyle}
        />
        {children}
      </Pressable>
    </GestureDetector>
  );
}
