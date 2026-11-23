import { useEffect, useState } from "react";
import { I18nManager, Platform, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { AppText as Text } from "./AppText";
import { cn } from "../lib/cn";
import { MaterialSegmentedControl } from "./MaterialSegmentedControl";
import type { SegmentedControlProps } from "./SegmentedControl.types";

export type { SegmentedControlProps } from "./SegmentedControl.types";

export function SegmentedControl<Value extends number | string>(
  props: SegmentedControlProps<Value>,
) {
  const compact = props.size === "compact";
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    props.options.findIndex((option) => option.value === props.selected),
  );
  const position = useSharedValue(index);
  useEffect(() => {
    position.set(
      withTiming(index, {
        duration: 200,
        easing: Easing.out(Easing.cubic),
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [index, position]);
  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX:
          ((position.value * width) / props.options.length) * (I18nManager.isRTL ? -1 : 1),
      },
    ],
  }));
  if (Platform.OS === "android") {
    return <MaterialSegmentedControl {...props} />;
  }
  return (
    <View
      accessible={false}
      onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      className={cn(
        "flex-row overflow-hidden",
        "rounded-full border-continuous bg-subtle",
        props.className,
      )}
    >
      <Animated.View
        pointerEvents="none"
        className="absolute inset-y-[2px] rounded-full border-border bg-card shadow-sm shadow-adaptive-black-a15-a35"
        style={[
          {
            width: Math.max(0, width / props.options.length - 4),
            start: 2,
            borderWidth: StyleSheet.hairlineWidth,
          },
          indicatorStyle,
        ]}
      />
      {props.options.map((option) => {
        const active = option.value === props.selected;
        return (
          <Pressable
            key={String(option.value)}
            accessibilityRole={Platform.OS === "ios" ? "button" : (props.role ?? "button")}
            accessibilityLabel={option.accessibilityLabel ?? option.label}
            accessibilityState={{ selected: active, disabled: props.disabled ?? false }}
            disabled={props.disabled}
            onPress={() => props.onSelect(option.value)}
            className={cn(
              "flex-1 items-center justify-center rounded-full px-2",
              compact ? "py-1.5" : "py-2",
            )}
            // Compact matches the native 32 pt segmented control. Hit slop can't help here:
            // iOS drops touches outside the pill's bounds before they reach a segment.
            style={{ minHeight: compact ? 32 : 44, minWidth: 44 }}
          >
            <Text
              className={cn(
                compact ? "text-xs" : "text-sm",
                active ? "font-t3-medium text-foreground" : "text-foreground-muted",
              )}
            >
              {option.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
