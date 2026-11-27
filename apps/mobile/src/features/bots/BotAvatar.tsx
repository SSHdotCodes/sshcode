import {
  BOT_AVATAR_GEOMETRY,
  BOT_AVATAR_MOTION,
  BOT_NEEDS_YOU_COLOR,
  botPalette,
  type BotStatusKind,
} from "@t3tools/client-runtime/state/bots";
import { useEffect, useId } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle, Defs, Ellipse, LinearGradient, Stop } from "react-native-svg";

import { useAmbientMotion } from "./useAmbientMotion";

const G = BOT_AVATAR_GEOMETRY;
const EYE_IN = Easing.out(Easing.quad);
const GLANCE = Easing.inOut(Easing.sin);

/** Spreads blinks so a row of bots never blinks in step. */
function blinkOffset(seed: string): number {
  let hash = 0;
  for (let index = 0; index < seed.length; index++) hash = (hash * 31 + seed.charCodeAt(index)) | 0;
  return Math.abs(hash) % BOT_AVATAR_MOTION.blinkEveryMs;
}

/**
 * A bot's face: a soft vertical gradient of its color, two white rounded eyes, a faint
 * highlight, no mouth. Idle blinks every few seconds, working glances left and right,
 * needs-you looks up with an amber dot. Motion runs on the UI thread and stops while the
 * screen is hidden or Reduce Motion is on; a blink is one short animation every ~6 s.
 */
export function BotAvatar(props: {
  readonly color: string;
  readonly size: number;
  readonly status?: BotStatusKind;
  /** Stable per bot, to spread blinks. */
  readonly seed?: string;
  /** Hold still (previews in lists that move on their own). */
  readonly still?: boolean;
  /** Surface behind the avatar, ringing the needs-you dot so it reads on any fill. */
  readonly backdropColor?: string;
}) {
  const { size } = props;
  const palette = botPalette(props.color);
  const gradientId = `bot-avatar-${useId().replace(/[^a-zA-Z0-9]/gu, "")}`;
  const ambient = useAmbientMotion();
  const moving = ambient && props.still !== true;
  const status = props.status ?? "idle";
  const blink = useSharedValue(1);
  const gazeX = useSharedValue(0);
  const gazeY = useSharedValue(0);

  useEffect(() => {
    if (!moving || status === "paused") return;
    const close = () => {
      blink.set(
        withSequence(
          withTiming(BOT_AVATAR_MOTION.blinkScaleY, {
            duration: BOT_AVATAR_MOTION.blinkMs / 2,
            easing: EYE_IN,
          }),
          withTiming(1, { duration: BOT_AVATAR_MOTION.blinkMs / 2, easing: EYE_IN }),
        ),
      );
    };
    // One timer per blink, never per frame; nothing animates between blinks.
    let interval: ReturnType<typeof setInterval> | undefined;
    const first = setTimeout(
      () => {
        close();
        interval = setInterval(close, BOT_AVATAR_MOTION.blinkEveryMs);
      },
      blinkOffset(props.seed ?? props.color),
    );
    return () => {
      clearTimeout(first);
      if (interval !== undefined) clearInterval(interval);
      cancelAnimation(blink);
      blink.set(1);
    };
  }, [blink, moving, props.color, props.seed, status]);

  useEffect(() => {
    const glance = G.glanceX * size;
    cancelAnimation(gazeX);
    if (status === "working" && moving) {
      const quarter = BOT_AVATAR_MOTION.glanceMs / 4;
      gazeX.set(
        withRepeat(
          withSequence(
            withTiming(glance, { duration: quarter, easing: GLANCE }),
            withTiming(-glance, { duration: quarter * 2, easing: GLANCE }),
            withTiming(0, { duration: quarter, easing: GLANCE }),
          ),
          -1,
        ),
      );
    } else {
      gazeX.set(moving ? withTiming(0, { duration: 180 }) : 0);
    }
    const up = status === "needsYou" ? G.lookUpY * size : 0;
    gazeY.set(moving ? withTiming(up, { duration: 220, easing: EYE_IN }) : up);
    return () => cancelAnimation(gazeX);
  }, [gazeX, gazeY, moving, size, status]);

  const gazeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: gazeX.get() }, { translateY: gazeY.get() }],
  }));
  const eyeStyle = useAnimatedStyle(() => ({ transform: [{ scaleY: blink.get() }] }));

  const eyeWidth = G.eyeWidth * size;
  const eyeHeight = G.eyeHeight * size;
  const dot = G.needsYouDot.size * size;
  const dotRing = Math.max(1, size * 0.04);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, opacity: status === "paused" ? 0.45 : 1 }}
    >
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={palette.top} />
            <Stop offset="1" stopColor={palette.fill} />
          </LinearGradient>
        </Defs>
        <Circle cx={50} cy={50} r={50} fill={`url(#${gradientId})`} />
        <Ellipse
          cx={G.highlight.cx * 100}
          cy={G.highlight.cy * 100}
          rx={G.highlight.rx * 100}
          ry={G.highlight.ry * 100}
          fill="#ffffff"
          opacity={G.highlight.opacity}
        />
      </Svg>
      <Animated.View
        pointerEvents="none"
        style={[{ position: "absolute", left: 0, top: 0, width: size, height: size }, gazeStyle]}
      >
        {G.eyeCentersX.map((centerX) => (
          <Animated.View
            key={centerX}
            style={[
              {
                position: "absolute",
                left: centerX * size - eyeWidth / 2,
                top: G.eyeCenterY * size - eyeHeight / 2,
                width: eyeWidth,
                height: eyeHeight,
                borderRadius: G.eyeRadius * size,
                borderCurve: "continuous",
                backgroundColor: "#ffffff",
              },
              eyeStyle,
            ]}
          />
        ))}
      </Animated.View>
      {status === "needsYou" ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: G.needsYouDot.cx * size - dot / 2 - dotRing,
            top: G.needsYouDot.cy * size - dot / 2 - dotRing,
            width: dot + dotRing * 2,
            height: dot + dotRing * 2,
            borderRadius: dot,
            borderWidth: dotRing,
            borderColor: props.backdropColor ?? "transparent",
            backgroundColor: BOT_NEEDS_YOU_COLOR,
          }}
        />
      ) : null}
    </View>
  );
}
