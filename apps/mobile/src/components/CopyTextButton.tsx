import { SymbolView } from "../components/AppSymbol";
import { memo, useEffect, useRef, useState } from "react";
import { Alert, Pressable, View, type ColorValue, type PressableProps } from "react-native";
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { tryCopyTextWithHaptic } from "../lib/copyTextWithHaptic";

const COPY_FEEDBACK_DURATION_MS = 1200;
const AnimatedPath = Animated.createAnimatedComponent(Path);
// The check "M5 12.5l5 5 9-10" is 7.1 + 13.5 long in its 24-unit box.
const CHECK_LENGTH = 21;

/**
 * The copy icon, and the check that is drawn over it once the text is on the clipboard: the
 * icon steps back, the stroke runs from the short leg to the long one and lands with a small
 * bounce, then it all unwinds. With Reduce Motion the two simply swap.
 */
function CopyGlyph(props: {
  readonly copied: boolean;
  readonly size: number;
  readonly tintColor?: ColorValue | undefined;
  readonly copiedTintColor?: ColorValue | undefined;
}) {
  const reduced = useReducedMotion();
  const fallback = useResolveClassNames("accent-foreground").accentColor;
  const tint = props.tintColor ?? fallback;
  const { copied } = props;
  // 0 shows the copy icon, 1 the finished check.
  const drawn = useSharedValue(0);
  const pop = useSharedValue(1);
  useEffect(() => {
    cancelAnimation(drawn);
    cancelAnimation(pop);
    if (reduced) {
      drawn.set(copied ? 1 : 0);
      pop.set(1);
    } else if (copied) {
      drawn.set(withTiming(1, { duration: 320, easing: Easing.out(Easing.cubic) }));
      pop.set(
        withSequence(
          withTiming(0.8, { duration: 90 }),
          withSpring(1, { damping: 9, stiffness: 260, mass: 0.6 }),
        ),
      );
    } else {
      drawn.set(withTiming(0, { duration: 160 }));
    }
    return () => {
      cancelAnimation(drawn);
      cancelAnimation(pop);
    };
  }, [copied, drawn, pop, reduced]);
  const copyStyle = useAnimatedStyle(() => {
    const away = Math.min(1, drawn.get() * 3);
    return { opacity: 1 - away, transform: [{ scale: 1 - 0.4 * away }] };
  });
  const checkStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, drawn.get() * 4),
    transform: [{ scale: pop.get() }],
  }));
  // The stroke starts once the copy icon has begun to step back.
  const checkProps = useAnimatedProps(() => ({
    strokeDashoffset: CHECK_LENGTH * (1 - Math.max(0, (drawn.get() - 0.15) / 0.85)),
  }));
  const box = props.size + 4;
  return (
    <View style={{ width: box, height: box, alignItems: "center", justifyContent: "center" }}>
      <Animated.View style={copyStyle}>
        <SymbolView
          name={{ ios: "doc.on.doc", android: "content_copy" }}
          size={props.size}
          tintColor={props.tintColor}
          tintColorClassName={props.tintColor ? undefined : "accent-foreground"}
          type="monochrome"
        />
      </Animated.View>
      <Animated.View pointerEvents="none" style={[{ position: "absolute" }, checkStyle]}>
        <Svg width={box} height={box} viewBox="0 0 24 24">
          <AnimatedPath
            animatedProps={checkProps}
            d="M5 12.5l5 5 9-10"
            fill="none"
            stroke={props.copiedTintColor ?? tint}
            strokeDasharray={CHECK_LENGTH}
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2.6}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}

export const CopyTextButton = memo(function CopyTextButton(
  props: Pick<
    PressableProps,
    "accessibilityHint" | "accessibilityActions" | "onAccessibilityAction"
  > & {
    readonly accessibilityLabel: string;
    readonly text: string;
    readonly onCopy?: () => Promise<void>;
    /** Lets a long-press menu wrap the button (`ControlPillMenu` injects it on Android). */
    readonly onLongPress?: () => void;
    readonly tintColor?: ColorValue;
    readonly copiedTintColor?: ColorValue;
    readonly backgroundColor?: ColorValue;
    readonly borderColor?: ColorValue;
    readonly iconSize?: number;
    readonly buttonSize?: number;
  },
) {
  const [copied, setCopied] = useState(false);
  const resetTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (resetTimeoutRef.current) {
        clearTimeout(resetTimeoutRef.current);
      }
    },
    [],
  );

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={copied ? "Copied" : props.accessibilityLabel}
      accessibilityHint={props.accessibilityHint}
      accessibilityActions={props.accessibilityActions}
      onAccessibilityAction={props.onAccessibilityAction}
      disabled={props.text.length === 0}
      hitSlop={8}
      onLongPress={props.onLongPress}
      onPress={async () => {
        try {
          if (props.onCopy) await props.onCopy();
          else if (!(await tryCopyTextWithHaptic(props.text))) {
            // A refused clipboard write is the common failure, and silence reads as success.
            Alert.alert("Could not copy", "Try again.");
            return;
          }
        } catch {
          Alert.alert("Could not copy", "Try again.");
          return;
        }
        setCopied(true);
        if (resetTimeoutRef.current) {
          clearTimeout(resetTimeoutRef.current);
        }
        resetTimeoutRef.current = setTimeout(() => {
          setCopied(false);
          resetTimeoutRef.current = null;
        }, COPY_FEEDBACK_DURATION_MS);
      }}
      style={({ pressed }) => ({
        width: props.buttonSize ?? 30,
        height: props.buttonSize ?? 30,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: 9,
        borderWidth: props.borderColor ? 1 : 0,
        borderColor: props.borderColor,
        backgroundColor: props.backgroundColor,
        opacity: pressed ? 0.52 : 1,
      })}
    >
      <CopyGlyph
        copied={copied}
        size={props.iconSize ?? 13}
        tintColor={props.tintColor}
        copiedTintColor={props.copiedTintColor}
      />
    </Pressable>
  );
});
