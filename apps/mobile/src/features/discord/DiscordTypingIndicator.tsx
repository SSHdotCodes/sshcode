import { useIsFocused } from "@react-navigation/native";
import { useEffect, useState } from "react";
import { AppState, View } from "react-native";
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import { AppText as Text } from "../../components/AppText";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { useVisibleSecondClock } from "../threads/use-visible-second-clock";

function TypingDot(props: { readonly index: number; readonly active: boolean }) {
  const opacity = useSharedValue(1);
  useEffect(() => {
    if (props.active)
      opacity.value = withDelay(
        props.index * 140,
        withRepeat(
          withTiming(0.35, { duration: 600, reduceMotion: ReduceMotion.System }),
          -1,
          true,
          undefined,
          ReduceMotion.System,
        ),
      );
    else cancelAnimation(opacity);
    return () => cancelAnimation(opacity);
  }, [opacity, props.active, props.index]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return <Animated.View className="size-1 rounded-full bg-foreground-muted" style={style} />;
}

export function DiscordTypingIndicator(props: {
  readonly label: string;
  readonly startedAt: string;
}) {
  const focused = useIsFocused();
  const [appActive, setAppActive] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setAppActive(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const now = useVisibleSecondClock(true);
  return (
    <View
      accessibilityLiveRegion="polite"
      className="min-h-7 flex-row items-center gap-2 bg-screen px-4 pb-1"
    >
      <View className="flex-row gap-1" accessibilityElementsHidden>
        {[0, 1, 2].map((index) => (
          <TypingDot key={index} index={index} active={focused && appActive} />
        ))}
      </View>
      <Text numberOfLines={1} style={{ fontSize: 12 }} className="flex-1 text-foreground-muted">
        <Text style={{ fontWeight: "600" }}>{props.label}</Text> is working…
      </Text>
      <Text style={{ fontSize: 11 }} className="text-foreground-muted">
        {formatDuration(Math.max(0, now - Date.parse(props.startedAt)))}
      </Text>
    </View>
  );
}
