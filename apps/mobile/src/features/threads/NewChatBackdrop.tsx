import { use, useEffect, useRef, useState, type ReactNode } from "react";
import { Image, StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import {
  chatBackdropPalette,
  type ChatBackdropMood,
} from "@t3tools/client-runtime/new-chat-dashboard";
import { HarnessMascotAgentId, HarnessMascotDriver } from "../../components/harnessMascotContext";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

const HorizonImage = Animated.createAnimatedComponent(Image);
// Logical size of the masks. Each 4pt mosaic tile and its hairline gap are baked into whole
// device pixels at 1x, 2x and 3x, and the image is never scaled, so hairlines stay crisp.
const WIDTH = 440;
const HEIGHT = 400;
// The arc's crown sits 280pt below the image's top edge.
const CROWN = 280;
// The new chat's smoke: 4pt mosaic tiles, anchored to the lower right, large enough for any phone.
const SMOKE_WIDTH = 440;
const SMOKE_HEIGHT = 960;

function useTint(color: string) {
  const tint = useSharedValue(color);
  useEffect(() => {
    tint.set(withTiming(color, { duration: 240, reduceMotion: ReduceMotion.System }));
  }, [color, tint]);
  return tint;
}

/**
 * The web scene's palette. A new chat shows a dithered cloud of the harness's light rising
 * from the lower right. A conversation docks the arc on the composer, where it follows the turn:
 * the glow breathes while the agent works, holds brighter while it waits on you, rises once
 * when a turn you watched finishes, and dims after one that failed.
 */
export function NewChatBackdrop({
  docked = false,
  mood = "idle",
  driver,
  agentId,
  crownY,
}: {
  docked?: boolean;
  mood?: ChatBackdropMood;
  driver?: string | null;
  agentId?: string | null;
  /** Where the arc's crown sits in the scene: just above the measured composer. */
  crownY?: number;
}) {
  const inheritedDriver = use(HarnessMascotDriver);
  const inheritedAgent = use(HarnessMascotAgentId);
  const { themeAppearance } = useAppearancePreferences();
  const dark = themeAppearance === "dark";
  const palette = chatBackdropPalette(
    driver === undefined ? inheritedDriver : driver,
    driver === undefined && agentId === undefined ? inheritedAgent : agentId,
  );
  const glowTint = useTint(palette.glow);
  const rimTint = useTint(dark ? palette.rimDark : palette.rimLight);
  const placement = docked
    ? styles.docked
    : crownY === undefined
      ? styles.hero
      : { top: crownY - CROWN };
  const reducedMotion = useReducedMotion();
  const turn = docked ? mood : "idle";
  // One slow pulse drives whichever part is alive: the working glow or the single rise of
  // a finished turn.
  const motion = reducedMotion
    ? "still"
    : turn === "done"
      ? "rise"
      : turn === "working"
        ? "loop"
        : "still";
  const pulse = useSharedValue(0);
  useEffect(() => {
    if (motion === "still") {
      pulse.set(withTiming(0, { duration: 600, reduceMotion: ReduceMotion.System }));
      return;
    }
    pulse.set(
      motion === "rise"
        ? withSequence(
            withTiming(1, { duration: 570, easing: Easing.out(Easing.quad) }),
            withTiming(0, { duration: 2030, easing: Easing.out(Easing.quad) }),
          )
        : withRepeat(
            withTiming(1, { duration: 5500, easing: Easing.inOut(Easing.sin) }),
            -1,
            true,
            undefined,
            ReduceMotion.Never,
          ),
    );
    return () => cancelAnimation(pulse);
  }, [motion, pulse]);
  // Atmosphere, not a second hero: the prompt stays the brightest thing on screen.
  const rest = !docked
    ? { glow: dark ? 0.34 : 0.3, rim: dark ? 0.62 : 0.55 }
    : turn === "waiting"
      ? { glow: 0.2, rim: 0.5 }
      : turn === "failed"
        ? { glow: 0.05, rim: 0.12 }
        : turn === "working"
          ? reducedMotion
            ? { glow: 0.18, rim: 0.36 }
            : { glow: 0.1, rim: 0.24 }
          : { glow: 0.12, rim: 0.24 };
  // How far the pulse lifts each layer above rest.
  const lift =
    turn === "working" ? { glow: 0.1, rim: 0 } : turn === "done" ? { glow: 0.24, rim: 0.48 } : null;
  const glowStyle = useAnimatedStyle(() => ({
    tintColor: glowTint.get(),
    opacity: rest.glow + (lift === null ? 0 : lift.glow * pulse.get()),
  }));
  const rimStyle = useAnimatedStyle(() => ({
    tintColor: rimTint.get(),
    opacity: rest.rim + (lift === null ? 0 : lift.rim * pulse.get()),
  }));
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.scene}
    >
      {docked ? null : (
        <>
          <Image
            source={require("@t3tools/client-runtime/assets/new-chat-smoke-mobile-cloud.png")}
            resizeMode="stretch"
            fadeDuration={0}
            style={[styles.smoke, { tintColor: palette.glow }]}
          />
          <Image
            source={require("@t3tools/client-runtime/assets/new-chat-smoke-mobile-core.png")}
            resizeMode="stretch"
            fadeDuration={0}
            // On a dark screen the pale core at full strength outshines the prompt and frames
            // the dashboard cards in glare; held back, it stays a glow.
            style={[
              styles.smoke,
              { tintColor: dark ? palette.rimDark : palette.rimLight, opacity: dark ? 0.6 : 1 },
            ]}
          />
        </>
      )}
      {docked ? (
        <>
          <HorizonImage
            source={require("@t3tools/client-runtime/assets/new-chat-horizon-mobile-glow.png")}
            resizeMode="stretch"
            fadeDuration={0}
            style={[styles.image, placement, glowStyle]}
          />
          <HorizonImage
            source={require("@t3tools/client-runtime/assets/new-chat-horizon-mobile-rim.png")}
            resizeMode="stretch"
            fadeDuration={0}
            style={[styles.image, placement, rimStyle]}
          />
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  scene: { ...StyleSheet.absoluteFill, overflow: "hidden" },
  image: {
    position: "absolute",
    width: WIDTH,
    height: HEIGHT,
    left: "50%",
    marginLeft: -WIDTH / 2,
  },
  smoke: {
    position: "absolute",
    right: 0,
    bottom: 0,
    width: SMOKE_WIDTH,
    height: SMOKE_HEIGHT,
  },
  strip: { position: "absolute" },
  // Before the composer is measured (and on Android): about where it rests.
  hero: { top: "50%", marginTop: -CROWN - 56 },
  // The crown sits just above the thread composer.
  docked: { bottom: 30 },
});

/**
 * The cloud cut into slices in dissolve order (the far wisps first, the hot core last), each
 * the same share of it, so hiding them one after another dissolves it as dither.
 */
const SETTLE_SLICES = [
  require("@t3tools/client-runtime/assets/new-chat-settle-mobile-0.png"),
  require("@t3tools/client-runtime/assets/new-chat-settle-mobile-1.png"),
  require("@t3tools/client-runtime/assets/new-chat-settle-mobile-2.png"),
  require("@t3tools/client-runtime/assets/new-chat-settle-mobile-3.png"),
  require("@t3tools/client-runtime/assets/new-chat-settle-mobile-4.png"),
  require("@t3tools/client-runtime/assets/new-chat-settle-mobile-5.png"),
  require("@t3tools/client-runtime/assets/new-chat-settle-mobile-6.png"),
  require("@t3tools/client-runtime/assets/new-chat-settle-mobile-7.png"),
] as const;
/** The hot core, in the last three slices. */
const SETTLE_CORE = [
  [5, require("@t3tools/client-runtime/assets/new-chat-settle-mobile-core-5.png")],
  [6, require("@t3tools/client-runtime/assets/new-chat-settle-mobile-core-6.png")],
  [7, require("@t3tools/client-runtime/assets/new-chat-settle-mobile-core-7.png")],
] as const;
const SETTLE_MS = 1000;

let pendingSettle: { threadId: string; at: number } | null = null;
/** The new chat's sheet is leaving for this thread: its screen dissolves the cloud on arrival. */
export function markCloudSettle(threadId: string): void {
  pendingSettle = { threadId, at: Date.now() };
}
function takeCloudSettle(threadId: string): boolean {
  const pending = pendingSettle;
  if (pending === null || pending.threadId !== threadId || Date.now() - pending.at > 5000)
    return false;
  pendingSettle = null;
  return true;
}

function SettleSlice(props: {
  source: number;
  slice: number;
  tint: string;
  progress: SharedValue<number>;
}): ReactNode {
  const { slice, progress } = props;
  // Each slice goes out over the second half of its share of the animation.
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, ((slice + 1) / SETTLE_SLICES.length - progress.get()) * 16)),
  }));
  return (
    <HorizonImage
      source={props.source}
      resizeMode="stretch"
      fadeDuration={0}
      style={[styles.smoke, { tintColor: props.tint }, style]}
    />
  );
}

/**
 * The embers' strip, in points (scripts/generate-new-chat-horizon.ts): along the bottom,
 * holding the lower-right corner's mass, pinned to the lower right like the smoke on the
 * same 4pt mosaic grid. No strip climbs the right edge: on a narrow phone it read as a stray line.
 */
const EMBER_STRIPS = [
  {
    source: require("@t3tools/client-runtime/assets/new-chat-embers-mobile-bottom.png"),
    width: 440,
    height: 376,
  },
] as const;

/** On a light background the strips' tones read as a stain at full strength (emberMixes). */
const EMBER_LIGHT_OPACITY = 0.65;

/** What the chat's agent is doing: the embers breathe while it works and flare when it needs you. */
export type EmberActivity = "idle" | "working" | "needsYou";
/** Half a breath of the working embers, in ms. */
const EMBER_BREATH_MS = 1200;

function EmberStripImages({ tint }: { tint: string }) {
  return EMBER_STRIPS.map((strip, index) => (
    <Image
      key={index}
      source={strip.source}
      resizeMode="stretch"
      fadeDuration={0}
      style={[
        styles.strip,
        { width: strip.width, height: strip.height, right: 0, bottom: 0, tintColor: tint },
      ]}
    />
  ));
}

function EmberStrips({
  tint,
  light,
  activity,
}: {
  tint: string;
  light: boolean;
  activity: EmberActivity;
}) {
  const reducedMotion = useReducedMotion();
  const breath = useSharedValue(1);
  const flare = useSharedValue(0);
  const previous = useRef(activity);
  useEffect(() => {
    const from = previous.current;
    previous.current = activity;
    if (reducedMotion) {
      cancelAnimation(breath);
      breath.set(1);
      return;
    }
    const half = { duration: EMBER_BREATH_MS, easing: Easing.inOut(Easing.sin) };
    breath.set(
      activity === "working"
        ? withRepeat(withSequence(withTiming(0.55, half), withTiming(1, half)), -1)
        : withTiming(1, { duration: 600 }),
    );
    // A second copy of the strips brightens them once: opacity alone can't go past full.
    if (activity === "needsYou" && from !== "needsYou") {
      flare.set(withSequence(withTiming(0.8, { duration: 220 }), withTiming(0, { duration: 900 })));
    }
  }, [activity, reducedMotion, breath, flare]);
  const breathStyle = useAnimatedStyle(() => ({ opacity: breath.get() }));
  const flareStyle = useAnimatedStyle(() => ({ opacity: flare.get() }));
  return (
    <View style={[StyleSheet.absoluteFill, light ? { opacity: EMBER_LIGHT_OPACITY } : null]}>
      <Animated.View style={[StyleSheet.absoluteFill, breathStyle]}>
        <EmberStripImages tint={tint} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, flareStyle]}>
        <EmberStripImages tint={tint} />
      </Animated.View>
    </View>
  );
}

/**
 * An open chat's backdrop: embers of the new chat's cloud settled in the lower right,
 * behind and beside the composer. They breathe while
 * the agent works and flare once when it needs you. Arriving from the new chat, the cloud
 * first dissolves into them, slice by slice.
 */
export function ThreadEmbers({
  threadId,
  activity = "idle",
}: {
  threadId: string;
  activity?: EmberActivity;
}) {
  const driver = use(HarnessMascotDriver);
  const agentId = use(HarnessMascotAgentId);
  const { themeAppearance } = useAppearancePreferences();
  const palette = chatBackdropPalette(driver, agentId);
  const core = themeAppearance === "dark" ? palette.cloudCoreDark : palette.rimLight;
  const reducedMotion = useReducedMotion();
  const [settling, setSettling] = useState(() => !reducedMotion && takeCloudSettle(threadId));
  const progress = useSharedValue(0);
  useEffect(() => {
    if (!settling) return;
    progress.set(withTiming(1, { duration: SETTLE_MS, easing: Easing.out(Easing.quad) }));
    const done = setTimeout(() => setSettling(false), SETTLE_MS + 100);
    return () => {
      clearTimeout(done);
      cancelAnimation(progress);
    };
  }, [progress, settling]);
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={styles.scene}
    >
      <EmberStrips tint={palette.glow} light={themeAppearance !== "dark"} activity={activity} />
      {settling ? (
        <>
          {SETTLE_SLICES.map((source, slice) => (
            <SettleSlice
              key={slice}
              source={source}
              slice={slice}
              tint={palette.glow}
              progress={progress}
            />
          ))}
          {SETTLE_CORE.map(([slice, source]) => (
            <SettleSlice
              key={`core-${slice}`}
              source={source}
              slice={slice}
              tint={core}
              progress={progress}
            />
          ))}
        </>
      ) : null}
    </View>
  );
}
