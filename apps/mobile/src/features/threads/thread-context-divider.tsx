import { useEffect, type ReactNode } from "react";
import { View, type ColorValue } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { AppText as Text } from "../../components/AppText";
import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { ShimmeringWorkContent } from "./thread-work-log";

/** How long ago a divider's event may be for it to still count as arriving. */
export const DIVIDER_ARRIVAL_MS = 3_000;

export function ThreadContextDivider(props: {
  label: string;
  icon?: AppSymbolName;
  iconColor: ColorValue;
  active?: boolean;
  failed?: boolean;
  /**
   * The event just happened: the rule draws outward from the label, which fades in. Leave it
   * off for history, since the list remounts rows that scroll back into view.
   */
  arriving?: boolean;
  children?: ReactNode;
}) {
  const reduced = useReducedMotion();
  const animate = props.arriving === true && !reduced;
  // Only the first mount decides: a divider that was already on screen never replays.
  const drawn = useSharedValue(animate ? 0 : 1);
  useEffect(() => {
    if (drawn.get() < 1)
      drawn.set(withTiming(1, { duration: 520, easing: Easing.out(Easing.cubic) }));
  }, [drawn]);
  const ruleStyle = useAnimatedStyle(() => ({
    opacity: drawn.get(),
    transform: [{ scaleX: drawn.get() }],
  }));
  const labelStyle = useAnimatedStyle(() => ({ opacity: Math.min(1, drawn.get() * 1.6) }));
  return (
    <View className="mb-3 flex-row items-center gap-3 px-1 py-1">
      <Animated.View
        className="h-px min-w-2 flex-1 bg-separator"
        style={[{ transformOrigin: "right center" }, ruleStyle]}
      />
      <Animated.View
        className="shrink flex-row flex-wrap items-center justify-center gap-1.5"
        style={labelStyle}
      >
        {props.icon ? (
          <SymbolView name={props.icon} size={12} tintColor={props.iconColor} type="monochrome" />
        ) : null}
        {props.active ? (
          <ShimmeringWorkContent
            className="flex-none"
            textClassName="font-t3-medium"
            compact
            icon="brain"
            iconSubtleColor={props.iconColor}
            label={props.label}
            showIcon={false}
          />
        ) : (
          <Text
            className={
              props.failed
                ? "font-t3-medium text-xs text-danger-foreground"
                : "font-t3-medium text-xs text-foreground-muted"
            }
          >
            {props.label}
          </Text>
        )}
        {props.children}
      </Animated.View>
      <Animated.View
        className="h-px min-w-2 flex-1 bg-separator"
        style={[{ transformOrigin: "left center" }, ruleStyle]}
      />
    </View>
  );
}
