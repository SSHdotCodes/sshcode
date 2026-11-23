/**
 * The home screen's sky: light from a sun past the top right corner, in arcs of the
 * harnesses you are using, cut into the app's chunky ordered dither and pinned behind the
 * top of the chat list. It dissolves in once the list is up, ripples outward while an
 * agent works, and flares when one needs you. Atmosphere only: the chats stay the
 * brightest thing on screen.
 */
import { useIsFocused } from "@react-navigation/native";
import { chatBackdropPalette } from "@t3tools/client-runtime/new-chat-dashboard";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { AppState, PixelRatio, StyleSheet, useWindowDimensions, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withRepeat,
  withSequence,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";

import { useThreadShells } from "../../state/entities";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { mosaicGap, snapToDots, type DitherLayer } from "./dither";
import { RIPPLE_STEPS, SKY_SLICES as SLICES, skyLayers, type SkyTone } from "./skyField";
import { useHarnessResolver, useHomeInsights } from "./HomeInsights";

export const SKY_HEIGHT = 200;
/** How long the light takes to dissolve in, sparse dots first. */
const ARRIVE_MS = 1400;
/** Half a breath while an agent works. */
const BREATH_MS = 1600;
/** One ripple's trip from the sun to the light's edge, and the rest before the next. */
const RIPPLE_MS = 2600;
const RIPPLE_REST_MS = 900;
/** How long one sky fades into the next when the harnesses at work change. */
const CROSSFADE_MS = 900;

/* ─── Mood ──────────────────────────────────────────────────────────── */

type SkyMood = "idle" | "working" | "needsYou";

/** At most this many harnesses share the sky; the rest are too small to see. */
const MAX_TONES = 4;

/**
 * What the agents are doing right now, and the harnesses the sky is made of: every
 * harness with an agent working (subagents too), in equal parts, so the sky changes only
 * when a harness starts or stops; with none working, the last 30 days' mix of the
 * harnesses that started at least a tenth of the chats.
 */
function useSkyMood() {
  const threads = useThreadShells();
  const resolver = useHarnessResolver();
  const { insights, harnesses } = useHomeInsights();
  let mood: SkyMood = "idle";
  const working = new Map<string, number>();
  for (const thread of threads) {
    if (thread.deletedAt !== null || thread.archivedAt !== null) continue;
    const subagent = thread.lineage.relationshipToParent === "subagent";
    if (!subagent && (thread.hasPendingApprovals || thread.hasPendingUserInput)) mood = "needsYou";
    if (threadRuntimeIsActive(thread.runtime)) {
      if (mood === "idle") mood = "working";
      const key = resolver.keyOf(thread);
      working.set(key, 1);
    }
  }
  let mix: { key: string; count: number }[] = [];
  for (const [key, count] of working) mix.push({ key, count });
  if (mix.length === 0) {
    const recent = insights.harnesses.reduce((sum, entry) => sum + entry.count, 0);
    mix = insights.harnesses.filter((entry, index) => index === 0 || entry.count >= recent * 0.1);
  }
  // A fresh array: sorting it in place is safe on Hermes.
  mix = [...mix].sort((left, right) => right.count - left.count || (left.key < right.key ? -1 : 1));
  const entries = mix.slice(0, MAX_TONES).map((entry) => {
    const harness = harnesses.get(entry.key) ?? resolver.harnesses.get(entry.key);
    return {
      key: entry.key,
      count: entry.count,
      driver: harness?.driver ?? "claudeAgent",
      agentId: harness?.agentId ?? null,
    };
  });
  if (entries.length === 0)
    entries.push({ key: "claude", count: 1, driver: "claudeAgent", agentId: null });
  return { mood, mix: entries };
}

/* ─── Drawing ───────────────────────────────────────────────────────── */

function SkySlice({
  layers,
  slice,
  arrival,
  width,
}: {
  layers: DitherLayer[];
  slice: number;
  arrival: SharedValue<number>;
  width: number;
}) {
  const style = useAnimatedStyle(() => ({
    opacity: Math.min(1, Math.max(0, (arrival.get() * SLICES - slice) * 1.4)),
  }));
  const sliceLayers = layers.filter((layer) => layer.slice === slice);
  if (sliceLayers.length === 0) return null;
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      <Svg width={width} height={SKY_HEIGHT}>
        {sliceLayers.map((layer) => (
          <Path
            key={`${layer.color}:${layer.opacity}`}
            d={layer.d}
            fill={layer.color}
            fillOpacity={layer.opacity}
          />
        ))}
      </Svg>
    </Animated.View>
  );
}

function SkyLayer({
  layers,
  arrival,
  width,
}: {
  layers: DitherLayer[];
  arrival: SharedValue<number>;
  width: number;
}) {
  return Array.from({ length: SLICES }, (_, slice) => (
    <SkySlice key={slice} layers={layers} slice={slice} arrival={arrival} width={width} />
  ));
}

/** One ring of the ripple: bright while the wave passes it, dark otherwise. */
function RippleRing({
  layers,
  step,
  wave,
  width,
}: {
  layers: DitherLayer[];
  step: number;
  wave: SharedValue<number>;
  width: number;
}) {
  const style = useAnimatedStyle(() => {
    const distance = Math.abs(wave.get() * (RIPPLE_STEPS + 1) - 0.5 - step);
    // Fainter as it travels out, like a ring of water spreading.
    return { opacity: Math.max(0, 1 - distance * 1.1) * (1 - step / (RIPPLE_STEPS * 1.6)) };
  });
  const ring = layers.filter((layer) => layer.slice === step);
  if (ring.length === 0) return null;
  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]}>
      <Svg width={width} height={SKY_HEIGHT}>
        {ring.map((layer) => (
          <Path
            key={`${layer.color}:${layer.opacity}`}
            d={layer.d}
            fill={layer.color}
            fillOpacity={layer.opacity}
          />
        ))}
      </Svg>
    </Animated.View>
  );
}

export const HomeSky = memo(function HomeSky({ top = 0 }: { top?: number }) {
  const { width: screenWidth } = useWindowDimensions();
  const width = snapToDots(screenWidth);
  const { themeAppearance } = useAppearancePreferences();
  const dark = themeAppearance === "dark";
  const { mood, mix } = useSkyMood();
  const tones = mix.map((entry): SkyTone => {
    const palette = chatBackdropPalette(entry.driver, entry.agentId);
    return {
      glow: palette.glow,
      rim: dark ? palette.rimDark : palette.rimLight,
      share: entry.count,
    };
  });
  // Redrawn only when the harnesses or their counts change, not on every chat update.
  const toneKey = tones.map((tone) => `${tone.glow}/${tone.rim}/${tone.share}`).join("|");
  // Drawn after the list's first frames: the cloud is never what opening the app waits on.
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setReady(true), 350);
    return () => clearTimeout(timer);
  }, []);
  const gap = mosaicGap(PixelRatio.get());
  const layers = useMemo(
    () => (ready && width > 0 ? skyLayers(width, SKY_HEIGHT, tones, 0, gap) : null),
    // toneKey stands for tones.
    [gap, ready, toneKey, width],
  );
  // The first cloud dissolves in; later ones cross-fade as agents start and stop.
  const firstKey = useRef<string | null>(null);
  if (layers && firstKey.current === null) firstKey.current = toneKey;

  const reducedMotion = useReducedMotion();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(() => AppState.currentState === "active");
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) =>
      setForeground(state === "active"),
    );
    return () => subscription.remove();
  }, []);
  const alive = focused && foreground && !reducedMotion;

  const arrival = useSharedValue(reducedMotion ? 1 : 0);
  const arrived = useRef(false);
  useEffect(() => {
    if (!layers || arrived.current) return;
    arrived.current = true;
    arrival.set(
      withTiming(1, {
        duration: ARRIVE_MS,
        easing: Easing.out(Easing.quad),
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [arrival, layers]);

  // Rings roll outward from the sun while an agent works; the hot core flares once when
  // one needs you.
  const breath = useSharedValue(1);
  const wave = useSharedValue(0);
  const previousMood = useRef<SkyMood>(mood);
  useEffect(() => {
    const from = previousMood.current;
    previousMood.current = mood;
    if (!alive) {
      cancelAnimation(breath);
      cancelAnimation(wave);
      breath.set(withTiming(1, { duration: 400 }));
      wave.set(0);
      return;
    }
    const half = { duration: BREATH_MS, easing: Easing.inOut(Easing.sin) };
    if (mood === "working") {
      breath.set(withRepeat(withSequence(withTiming(0.7, half), withTiming(1, half)), -1));
      wave.set(0);
      wave.set(
        withRepeat(
          withSequence(
            withTiming(1, { duration: RIPPLE_MS, easing: Easing.out(Easing.sin) }),
            withDelay(RIPPLE_REST_MS, withTiming(0, { duration: 0 })),
          ),
          -1,
        ),
      );
    } else if (mood === "needsYou" && from !== "needsYou") {
      breath.set(
        withSequence(withTiming(1.6, { duration: 260 }), withTiming(1.2, { duration: 1100 })),
      );
      wave.set(withTiming(0, { duration: 300 }));
    } else {
      breath.set(withTiming(mood === "needsYou" ? 1.2 : 1, { duration: 600 }));
      wave.set(withTiming(0, { duration: 300 }));
    }
    return () => {
      cancelAnimation(breath);
      cancelAnimation(wave);
    };
  }, [alive, breath, mood, wave]);

  // Tiles carry their own shades, so the layers sit stronger than the old solid dots did.
  const rest = dark ? { glow: 0.6, rim: 0.7 } : { glow: 0.52, rim: 0.56 };
  const glowStyle = useAnimatedStyle(() => ({ opacity: rest.glow }));
  const rimStyle = useAnimatedStyle(() => ({
    opacity: Math.min(1, rest.rim * breath.get()),
  }));
  const rippleStyle = useAnimatedStyle(() => ({ opacity: rest.rim * 1.5 }));

  if (!layers) return null;
  return (
    <View
      pointerEvents="none"
      accessible={false}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.sky, { width, top }]}
      testID="home-sky"
    >
      <Animated.View
        key={toneKey}
        style={StyleSheet.absoluteFill}
        entering={
          toneKey === firstKey.current
            ? undefined
            : FadeIn.duration(CROSSFADE_MS).reduceMotion(ReduceMotion.System)
        }
        exiting={FadeOut.duration(CROSSFADE_MS).reduceMotion(ReduceMotion.System)}
      >
        <Animated.View style={[StyleSheet.absoluteFill, glowStyle]}>
          <SkyLayer layers={layers.glow} arrival={arrival} width={width} />
        </Animated.View>
        <Animated.View style={[StyleSheet.absoluteFill, rimStyle]}>
          <SkyLayer layers={layers.rim} arrival={arrival} width={width} />
        </Animated.View>
        {mood === "working" && alive ? (
          <Animated.View style={[StyleSheet.absoluteFill, rippleStyle]}>
            {Array.from({ length: RIPPLE_STEPS }, (_, step) => (
              <RippleRing key={step} layers={layers.ripple} step={step} wave={wave} width={width} />
            ))}
          </Animated.View>
        ) : null}
      </Animated.View>
    </View>
  );
});

const styles = StyleSheet.create({
  sky: { position: "absolute", right: 0, height: SKY_HEIGHT, overflow: "hidden" },
});
