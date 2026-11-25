import { type ComponentProps, type ReactNode, useRef } from "react";
import { Platform, Pressable, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { cn } from "../lib/cn";
import { SymbolView } from "./AppSymbol";
import { AppText as Text } from "./AppText";
import { MaterialIconButton } from "./MaterialIconButton";
import { MaterialButton } from "./MaterialButton";
import { useAndroidControlSizing } from "./useAndroidControlSizing";

export { ControlPillMenu } from "./ControlPillMenu";

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const PILL_PRESS_IN_TIMING = {
  duration: 70,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.System,
};
const PILL_PRESS_OUT_SPRING = {
  damping: 18,
  stiffness: 380,
  mass: 0.7,
  reduceMotion: ReduceMotion.System,
};
const PILL_PRESS_OUT_OPACITY = {
  duration: 140,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.System,
};

export function ControlPill(props: {
  readonly icon?: ComponentProps<typeof SymbolView>["name"];
  readonly iconNode?: ReactNode;
  readonly label?: string;
  readonly accessibilityLabel?: string;
  readonly onPress?: () => void;
  readonly activateOnPressIn?: boolean;
  readonly variant?: "circle" | "pill" | "primary" | "danger";
  readonly disabled?: boolean;
  readonly className?: string;
}) {
  const variant = props.variant ?? "circle";
  const { smallIconSize } = useAndroidControlSizing();
  const activatedOnPressInRef = useRef(false);
  const pressScale = useSharedValue(1);
  const pressOpacity = useSharedValue(1);

  const pressStyle = useAnimatedStyle(() => ({
    opacity: pressOpacity.value,
    transform: [{ scale: pressScale.value }],
  }));

  const handlePressIn = () => {
    if (!props.disabled) {
      pressScale.set(withTiming(0.93, PILL_PRESS_IN_TIMING));
      pressOpacity.set(withTiming(0.82, PILL_PRESS_IN_TIMING));
    }
    if (props.activateOnPressIn) {
      activatedOnPressInRef.current = true;
      props.onPress?.();
    }
  };
  const handlePressOut = () => {
    pressScale.set(withSpring(1, PILL_PRESS_OUT_SPRING));
    pressOpacity.set(withTiming(1, PILL_PRESS_OUT_OPACITY));
    if (props.activateOnPressIn) {
      // Pressability invokes onPressOut immediately before onPress on release.
      // Defer the reset so onPress can identify the same physical gesture.
      setTimeout(() => {
        activatedOnPressInRef.current = false;
      }, 0);
    }
  };
  const handlePress = () => {
    if (activatedOnPressInRef.current) {
      return;
    }
    props.onPress?.();
  };

  const iconTintClassName =
    variant === "primary"
      ? props.disabled
        ? "accent-icon-subtle"
        : "accent-primary-foreground"
      : variant === "danger"
        ? "accent-danger-foreground"
        : "accent-icon";

  const isCircle =
    variant === "circle" || variant === "danger" || (variant === "primary" && !props.label);
  const containerClassName = cn(
    isCircle
      ? "items-center justify-center rounded-full"
      : variant === "primary"
        ? "flex-row items-center justify-center gap-2 rounded-full px-5 py-2"
        : "flex-row items-center justify-center gap-2 rounded-full px-3.5 py-2",
    variant === "primary"
      ? props.disabled
        ? "bg-subtle-strong"
        : "bg-primary"
      : variant === "danger"
        ? "bg-danger"
        : "bg-subtle",
    props.className,
  );
  const labelClassName = cn(
    "text-center text-xs font-t3-bold",
    variant === "primary"
      ? props.disabled
        ? "text-foreground-muted"
        : "text-primary-foreground"
      : variant === "danger"
        ? "text-danger-foreground"
        : "text-foreground",
  );

  if (
    Platform.OS === "android" &&
    (variant === "pill" || variant === "primary") &&
    props.label &&
    props.onPress &&
    !props.icon &&
    !props.iconNode &&
    !props.className &&
    !props.activateOnPressIn &&
    (!props.accessibilityLabel || props.accessibilityLabel === props.label)
  ) {
    return (
      <MaterialButton
        label={props.label}
        onPress={props.onPress}
        disabled={props.disabled}
        tone={variant === "primary" ? "primary" : "secondary"}
      />
    );
  }

  if (
    Platform.OS === "android" &&
    props.accessibilityLabel &&
    props.icon &&
    !props.iconNode &&
    !props.label &&
    !props.className &&
    !props.activateOnPressIn
  ) {
    return (
      <MaterialIconButton
        accessibilityLabel={props.accessibilityLabel}
        icon={props.icon}
        onPress={props.onPress}
        disabled={props.disabled}
        variant={variant === "primary" ? "primary" : variant === "danger" ? "danger" : "tonal"}
      />
    );
  }

  return (
    <AnimatedPressable
      accessibilityLabel={props.accessibilityLabel ?? props.label}
      accessibilityRole="button"
      onPress={props.activateOnPressIn ? handlePress : props.onPress}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      disabled={props.disabled}
      className={containerClassName}
      style={[{ minHeight: 44, minWidth: 44 }, pressStyle]}
    >
      {props.iconNode ? (
        <View className="h-4 w-4 items-center justify-center">{props.iconNode}</View>
      ) : props.icon ? (
        <SymbolView
          name={props.icon}
          size={smallIconSize}
          tintColorClassName={iconTintClassName}
          type="monochrome"
        />
      ) : null}
      {props.label ? <Text className={labelClassName}>{props.label}</Text> : null}
    </AnimatedPressable>
  );
}
