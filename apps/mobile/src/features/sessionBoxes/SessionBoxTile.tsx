import { usePrivacyLabel, usePrivacyMode } from "../../state/use-privacy-mode";
import type { SessionBoxPresentation } from "@t3tools/client-runtime/state/session-boxes";
import { sessionBoxBaseIconId, type SessionBoxIconId } from "@t3tools/shared/sessionBoxes";
import { Image } from "expo-image";
import { memo, useEffect, useId } from "react";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  ZoomIn,
} from "react-native-reanimated";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

import { AppText as Text } from "../../components/AppText";
import { HarnessMascot } from "../../components/HarnessMascot";
import { SESSION_BOX_FALLBACK_ICONS } from "./sessionBoxFallbackIcons";
import { sessionBoxIconAsset, sessionBoxIconAssets } from "./sessionBoxIconAssets";

/** A box's paint, derived from its hue so a chat keeps one color everywhere. */
export function sessionBoxPalette(hue: number, dark: boolean) {
  return dark
    ? {
        surface: `hsl(${hue}, 20%, 16%)`,
        edge: `hsl(${hue}, 20%, 27%)`,
        ink: `hsl(${hue}, 30%, 93%)`,
        muted: `hsla(${hue}, 20%, 88%, 0.68)`,
        paint: `hsl(${hue}, 58%, 64%)`,
        asking: "hsl(40, 90%, 68%)",
        failed: "hsl(6, 75%, 72%)",
      }
    : {
        surface: `hsl(${hue}, 70%, 97%)`,
        edge: `hsl(${hue}, 42%, 86%)`,
        ink: `hsl(${hue}, 35%, 18%)`,
        muted: `hsla(${hue}, 25%, 22%, 0.68)`,
        paint: `hsl(${hue}, 55%, 50%)`,
        asking: "hsl(32, 85%, 38%)",
        failed: "hsl(4, 70%, 45%)",
      };
}

function PaintedIcon(props: {
  readonly id: SessionBoxIconId;
  readonly size: number;
  readonly color: string;
}) {
  const asset = sessionBoxIconAsset(props.id);
  if (asset !== undefined) {
    return (
      <Image
        source={asset}
        style={{ width: props.size, height: props.size }}
        contentFit="contain"
        transition={200}
        accessible={false}
      />
    );
  }
  const Fallback = SESSION_BOX_FALLBACK_ICONS[sessionBoxBaseIconId(props.id)];
  return (
    <View style={{ width: props.size, height: props.size }} className="items-center justify-center">
      <Fallback size={props.size * 0.7} color={props.color} strokeWidth={2} />
    </View>
  );
}

/**
 * A chat's painting for the start of a list row: its topic face, which never changes, and
 * a badge with what it is doing now. The same art as the boxes, at a size that reads.
 */
export const SessionBoxPainting = memo(function SessionBoxPainting(props: {
  readonly box: SessionBoxPresentation;
  readonly size: number;
}) {
  const dark = useColorScheme() === "dark";
  const palette = sessionBoxPalette(props.box.hue, dark);
  return (
    <View style={{ width: props.size, height: props.size }} accessible={false}>
      <Animated.View key={props.box.face} entering={ZoomIn.duration(380)}>
        <PaintedIcon id={props.box.face} size={props.size} color={palette.paint} />
      </Animated.View>
      {props.box.badge !== null ? (
        <Animated.View
          key={props.box.badge}
          entering={ZoomIn.duration(420)}
          style={[styles.badge, { backgroundColor: palette.surface, borderColor: palette.edge }]}
        >
          <PaintedIcon
            id={props.box.badge}
            size={Math.round(props.size * 0.5)}
            color={palette.paint}
          />
        </Animated.View>
      ) : null}
    </View>
  );
});

/** The wet-paint sweep along the bottom edge while the agent works. */
function PaintLine(props: { readonly color: string; readonly width: number }) {
  const reduceMotion = useReducedMotion();
  const offset = useSharedValue(0);
  useEffect(() => {
    if (reduceMotion) return;
    offset.value = withRepeat(
      withTiming(1, { duration: 2600, easing: Easing.inOut(Easing.quad) }),
      -1,
      false,
    );
  }, [offset, reduceMotion]);
  const sweep = useAnimatedStyle(() => ({
    transform: [{ translateX: (offset.value * 1.6 - 0.6) * props.width }],
  }));
  // The brush stroke fills the middle third of its square image, so draw it three
  // times the track's height and let the track crop the empty top and bottom.
  return (
    <View pointerEvents="none" style={styles.paintTrack}>
      <Animated.View style={[{ width: props.width * 0.5 }, reduceMotion ? null : sweep]}>
        <Image
          source={sessionBoxIconAssets["stroke-2"]}
          tintColor={props.color}
          contentFit="fill"
          style={styles.paintStroke}
          accessible={false}
        />
      </Animated.View>
    </View>
  );
}

/** A soft pulsing halo for chats that need the user. */
function AskingHalo(props: { readonly color: string }) {
  const reduceMotion = useReducedMotion();
  const opacity = useSharedValue(0.6);
  useEffect(() => {
    if (reduceMotion) return;
    opacity.value = withRepeat(
      withSequence(withTiming(1, { duration: 1200 }), withTiming(0.35, { duration: 1200 })),
      -1,
      false,
    );
  }, [opacity, reduceMotion]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.value }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, styles.halo, { borderColor: props.color }, style]}
    />
  );
}

/**
 * One chat as a box, a little wider than tall so more fit on a screen: a painted topic
 * face and a stable hue that never change, plus a badge, status line and motion for what
 * happens now.
 */
export const SessionBoxTile = memo(function SessionBoxTile(props: {
  readonly disabled?: boolean;
  readonly box: SessionBoxPresentation;
  readonly title: string;
  readonly identity?: string;
  readonly machineIdentity?: string;
  readonly driver: string | null;
  readonly agentId?: string | null | undefined;
  readonly size: number;
  readonly selected: boolean;
  readonly pinned: boolean;
  readonly machineLabel: string | null;
  /** While searching: where the chat matched, shown in place of its status. */
  readonly match?: string | null;
  readonly onPress: () => void;
  readonly onPressIn?: () => void;
  readonly onLongPress?: () => void;
}) {
  const privateLabel = usePrivacyLabel();
  const privacy = usePrivacyMode();
  const title = privateLabel("Chat", props.identity ?? props.title, props.title);
  const dark = useColorScheme() === "dark";
  const gradientId = useId().replace(/:/g, "");
  const { box } = props;
  const palette = sessionBoxPalette(box.hue, dark);
  const face = Math.round(props.size * 0.28);
  const badge = Math.round(face * 0.55);
  const statusColor =
    box.tone === "asking" ? palette.asking : box.tone === "failed" ? palette.failed : palette.muted;
  return (
    <Pressable
      disabled={props.disabled}
      accessibilityState={{ disabled: props.disabled }}
      accessibilityRole="button"
      accessibilityLabel={`${title}. ${!privacy && box.now ? `Now: ${box.now}. ` : ""}${privacy ? box.statusShort : (props.match ?? box.status)}`}
      onPressIn={props.onPressIn}
      onPress={props.onPress}
      onLongPress={props.onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.box,
        {
          width: props.size,
          height: Math.round(props.size * 0.84),
          backgroundColor: palette.surface,
          borderColor:
            box.tone === "asking"
              ? palette.asking
              : box.tone === "failed"
                ? palette.failed
                : palette.edge,
          transform: [{ scale: pressed ? 0.97 : 1 }],
        },
        props.selected ? { borderColor: palette.paint, borderWidth: 2 } : null,
      ]}
    >
      <Svg style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs>
          <RadialGradient id={`${gradientId}a`} cx="0%" cy="0%" rx="120%" ry="90%">
            <Stop offset="0" stopColor={palette.paint} stopOpacity={dark ? 0.3 : 0.26} />
            <Stop offset="0.62" stopColor={palette.paint} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={`${gradientId}b`} cx="100%" cy="100%" rx="90%" ry="70%">
            <Stop offset="0" stopColor={palette.paint} stopOpacity={0.14} />
            <Stop offset="0.7" stopColor={palette.paint} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill={`url(#${gradientId}a)`} />
        <Rect width="100%" height="100%" fill={`url(#${gradientId}b)`} />
      </Svg>
      {box.tone === "asking" ? <AskingHalo color={palette.asking} /> : null}
      <View className="flex-row items-start justify-between">
        <View style={{ width: face, height: face }}>
          <Animated.View key={box.face} entering={ZoomIn.duration(380)}>
            <PaintedIcon id={box.face} size={face} color={palette.paint} />
          </Animated.View>
          {box.badge !== null ? (
            <Animated.View
              key={box.badge}
              entering={ZoomIn.duration(420)}
              style={[
                styles.badge,
                { backgroundColor: palette.surface, borderColor: palette.edge },
              ]}
            >
              <PaintedIcon id={box.badge} size={badge} color={palette.paint} />
            </Animated.View>
          ) : null}
        </View>
        <View className="items-end gap-0.5">
          <View className="flex-row items-center gap-1">
            {props.pinned ? (
              <Text style={{ color: palette.muted, fontSize: 9 }} accessible={false}>
                ●
              </Text>
            ) : null}
            {props.driver ? (
              <HarnessMascot
                driver={props.driver}
                agentId={props.agentId}
                size={Math.round(props.size * 0.16)}
                state={box.mascot}
                still={box.mascot === "idle"}
              />
            ) : null}
          </View>
          {props.machineLabel ? (
            <View style={[styles.machine, { backgroundColor: palette.edge }]}>
              <Text style={[styles.machineText, { color: palette.ink }]} numberOfLines={1}>
                {privateLabel(
                  "Computer",
                  props.machineIdentity ?? props.machineLabel,
                  props.machineLabel,
                ).toUpperCase()}
              </Text>
            </View>
          ) : null}
        </View>
      </View>
      <View className="mt-auto">
        <Text
          numberOfLines={box.now ? 1 : 2}
          style={[styles.label, { color: palette.ink, fontSize: props.size >= 130 ? 15 : 13 }]}
        >
          {privacy ? title : box.label}
        </Text>
        {box.now && !privacy ? (
          <Text numberOfLines={1} style={[styles.now, { color: palette.muted }]}>
            ↳ {box.now}
          </Text>
        ) : null}
        <View className="flex-row items-center gap-1">
          <Text
            numberOfLines={1}
            style={[
              styles.status,
              props.match && !box.connectionStatus
                ? { color: palette.ink, fontStyle: "italic" }
                : {
                    color: statusColor,
                    fontWeight: box.tone === "asking" || box.tone === "failed" ? "600" : "400",
                  },
            ]}
            className="flex-1"
          >
            {box.connectionStatus
              ? box.statusShort
              : privacy
                ? box.statusShort
                : (props.match ?? box.statusShort)}
          </Text>
          {box.tone === "unread" ? (
            <View style={[styles.unread, { backgroundColor: palette.paint }]} />
          ) : null}
        </View>
      </View>
      {box.tone === "working" ? <PaintLine color={palette.paint} width={props.size} /> : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  box: {
    borderRadius: 16,
    borderWidth: 1,
    borderCurve: "continuous",
    overflow: "hidden",
    padding: 8,
  },
  badge: {
    position: "absolute",
    right: -7,
    bottom: -5,
    borderRadius: 999,
    borderWidth: 1,
    padding: 1,
  },
  halo: {
    borderRadius: 16,
    borderWidth: 2,
  },
  machine: {
    borderRadius: 4,
    paddingHorizontal: 4,
    maxWidth: 64,
  },
  machineText: {
    fontSize: 8,
    fontWeight: "700",
    letterSpacing: 0.4,
  },
  label: {
    fontWeight: "700",
    lineHeight: 16,
    letterSpacing: -0.2,
  },
  now: {
    fontSize: 11,
    lineHeight: 14,
  },
  status: {
    fontSize: 11,
    marginTop: 1,
  },
  unread: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  paintTrack: {
    position: "absolute",
    left: 6,
    right: 6,
    bottom: 1,
    height: 6,
    overflow: "hidden",
  },
  paintStroke: {
    width: "123%",
    height: 18,
    marginTop: -6,
    marginLeft: "-11.5%",
    opacity: 0.9,
  },
});
