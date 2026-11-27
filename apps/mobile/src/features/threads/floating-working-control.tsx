import {
  HarnessMascot,
  HarnessMascotDriver,
  HarnessMascotAgentId,
  useHarnessMascotReady,
} from "../../components/HarnessMascot";
import { harnessMascotForDriver, type HarnessMascotState } from "@t3tools/shared/harnessMascots";
import type { SubagentPillSegment } from "@t3tools/client-runtime/state/thread-subagents";
import type { MascotMoment } from "@t3tools/client-runtime/mascot-moments";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatGenerationRate } from "@t3tools/shared/generationRate";
import { GlassContainer, GlassView } from "expo-glass-effect";
import { type ReactNode, use, useEffect, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  Pressable,
  Text as SystemText,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { withUniwind } from "uniwind";

import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ControlPill } from "../../components/ControlPill";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { BrowserPreviewButton } from "../browser/browser-preview-button";
import { DevicePreviewButton } from "../devices/device-preview-button";
import { HeldBackgroundWorkActions } from "./HeldBackgroundWork";
import type { FloatingWorkingStatus } from "./floating-working-status";
import { ShimmeringWorkContent } from "./thread-work-log";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import { LiveProgressBar, useLiveProgressCard } from "./LiveProgress";

const CONTROL_HEIGHT = 38.5; // h-11 with the mobile 14px rem
// The capsule keeps its height at every text size, so its labels stop growing where one line
// still fits; past that they truncate instead of clipping mid-glyph.
const CAPSULE_MAX_FONT_SCALE = 1.6;
// The working row's padding (px-4), mascot and gap, around its text.
const WORKING_LABEL_CHROME = 62;
// The collapsed composer capsule starts 6 below its overlay's top edge, so
// the pill sits at (gap - 6) above the overlay to leave the same gap to the
// capsule as the feed's end inset leaves between it and the last row.
const CONTROL_GAP = 8;
const COMPOSER_CAPSULE_INSET = 6;
const GLASS_MERGE_SPACING = 12;
const CONTROL_ENTERING = FadeIn.duration(180).reduceMotion(ReduceMotion.System);
const CONTROL_EXITING = FadeOut.duration(120).reduceMotion(ReduceMotion.System);
const CONTROL_TIMING = {
  duration: 240,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.System,
} as const;
const CONTROL_ROW_GAP = 14;
const CONTROL_SEPARATION = (CONTROL_ROW_GAP + CONTROL_HEIGHT) / 2;
// Both rows share the same centered anchor, so the outgoing one clears fast and
// the incoming one waits for it to be mostly gone before it starts to show.
const LABEL_ENTERING = FadeIn.duration(160).delay(80).reduceMotion(ReduceMotion.System);
const LABEL_EXITING = FadeOut.duration(100).reduceMotion(ReduceMotion.System);

// Expo reapplies glass after native layout and window reattachment, when UIKit
// can otherwise leave the label visible but lose the material behind it.
const UniwindGlassView = withUniwind(GlassView, {
  style: { fromClassName: "className" },
});
const UniwindGlassContainer = withUniwind(GlassContainer, {
  style: { fromClassName: "className" },
});
const AnimatedGlassView = Animated.createAnimatedComponent(UniwindGlassView);

const CONTROL_OVERLAY_OFFSET = CONTROL_HEIGHT + CONTROL_GAP - COMPOSER_CAPSULE_INSET;
export const FLOATING_WORKING_CONTROL_COVERAGE = CONTROL_OVERLAY_OFFSET + CONTROL_GAP;

export function FloatingWorkingControl(props: {
  readonly mascotState?: HarnessMascotState;
  readonly mascotMoment?: MascotMoment | null;
  readonly colorScheme: "light" | "dark";
  readonly status: FloatingWorkingStatus | null;
  readonly devicePreview: { readonly count: number; readonly onPress: () => void } | null;
  readonly browserPreview: { readonly count: number; readonly onPress: () => void } | null;
  readonly showScrollToEnd: boolean;
  readonly onScrollToEnd: () => void;
  readonly agents: SubagentPillSegment | null;
  readonly onOpenAgents: () => void;
  readonly queuedCount: number;
  readonly queueHeld?: boolean;
  readonly onOpenQueue: () => void;
  /** The lead's team board; it follows the working status (live progress included). */
  readonly teamBoard?: {
    readonly postCount: number;
    readonly overlapCount: number;
    readonly unread: boolean;
    readonly onPress: () => void;
  } | null;
  /** Extra distance to rise above the anchor, e.g. an overlay card's coverage. */
  readonly lift?: SharedValue<number>;
}) {
  const mascotDriver = use(HarnessMascotDriver);
  const mascotAgentId = use(HarnessMascotAgentId);
  const mascot = harnessMascotForDriver(mascotDriver, mascotAgentId);
  const { width: windowWidth } = useWindowDimensions();
  const [overlayWidth, setOverlayWidth] = useState(windowWidth);
  const [queueWidth, setQueueWidth] = useState(0);
  const [agentsWidth, setAgentsWidth] = useState(0);
  const [boardWidth, setBoardWidth] = useState(0);
  const teamBoard = props.teamBoard ?? null;
  const hasBoard = teamBoard !== null;
  const hasQueue = props.queuedCount > 0;
  const hasPreview = props.devicePreview !== null || props.browserPreview !== null;
  const [previewWidth, setPreviewWidth] = useState(0);
  const agents = props.agents;
  const hasAgents = agents !== null;
  // Segments keep their measured width; only the status label absorbs the
  // remainder, so a long "Working 12m 04s" truncates before a count does.
  const labelWidth = Math.max(
    0,
    Math.min(overlayWidth, windowWidth) -
      CONTROL_HEIGHT -
      32 -
      (hasQueue ? queueWidth : 0) -
      (hasAgents ? agentsWidth : 0) -
      (hasBoard ? boardWidth : 0) -
      (hasPreview ? previewWidth : 0),
  );
  const separationProgress = useSharedValue(props.showScrollToEnd ? 1 : 0);

  useEffect(() => {
    separationProgress.value = withTiming(props.showScrollToEnd ? 1 : 0, CONTROL_TIMING);
  }, [props.showScrollToEnd, separationProgress]);

  const lift = props.lift;
  const liftStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -(lift?.value ?? 0) }],
  }));
  const arrowTransformStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: -CONTROL_SEPARATION * (1 - separationProgress.value) }],
  }));
  const arrowContentStyle = useAnimatedStyle(() => ({
    opacity: separationProgress.value,
  }));

  // Animate an in-flow sizer so native glass receives real layout updates.
  // Measure labels in a separate, fixed-width host: measuring against the
  // animated capsule constrains the incoming text to each intermediate width
  // and repeatedly retargets the animation as it grows.
  const capsuleWidth = useSharedValue<number | null>(null);
  const measuredWidthRef = useRef<number | null>(null);
  const handleLabelLayout = (event: LayoutChangeEvent) => {
    const width = event.nativeEvent.layout.width;
    if (width === measuredWidthRef.current) {
      return;
    }
    const first = measuredWidthRef.current === null;
    measuredWidthRef.current = width;
    capsuleWidth.value = first ? width : withTiming(width, CONTROL_TIMING);
  };
  // Forget the width while no label is shown so the next one appears at its
  // own size instead of animating from the previous label's.
  const moment = props.mascotMoment?.kind !== "waiting" ? props.mascotMoment : null;
  const result = props.mascotState === "done" || props.mascotState === "failed";
  const mascotReady = useHarnessMascotReady(moment != null || result ? (mascot?.id ?? null) : null);
  const reacting = (mascotReady && result) || moment != null;
  const hasStatus = props.status !== null || reacting;
  const hasCapsule = hasStatus || hasQueue || hasAgents || hasPreview || hasBoard;
  useEffect(() => {
    if (!hasStatus) {
      measuredWidthRef.current = null;
      capsuleWidth.value = null;
    }
  }, [capsuleWidth, hasStatus]);
  const capsuleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: CONTROL_SEPARATION * (1 - separationProgress.value) }],
  }));
  // Zero until the first measurement lands, so the capsule never paints around
  // a label it has not sized to yet.
  const capsuleSizerStyle = useAnimatedStyle(() => ({
    width: capsuleWidth.value ?? 0,
  }));

  if (!hasCapsule && !props.showScrollToEnd) {
    return null;
  }

  // Both preview buttons fit beside each other only as icons.
  const previewCompact =
    hasStatus ||
    hasAgents ||
    hasQueue ||
    hasBoard ||
    (props.devicePreview !== null && props.browserPreview !== null);
  // The queue, agents, questions, and reconnect labels have separate tap targets.
  const statusInteractive =
    props.status?.kind === "connection" ||
    props.status?.kind === "child-input" ||
    (props.status?.kind === "working" && props.status.progress !== undefined) ||
    (props.status?.kind === "background" &&
      (props.status.onPress !== undefined || props.status.held !== undefined));
  const capsuleInteractive = statusInteractive || hasQueue || hasAgents || hasPreview || hasBoard;
  // The host stays centered on the capsule, but its measurement constraint
  // comes from the overlay, independent of the capsule's current width.
  const statusContent =
    reacting && props.status === null ? (
      <View className="h-11 flex-row items-center gap-1.5 px-3">
        {mascotReady ? (
          <HarnessMascot
            state={moment?.kind === "returned" ? "done" : props.mascotState}
            size={28}
          />
        ) : null}
        <Text
          maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
          className="text-xs text-foreground"
          numberOfLines={1}
          style={{ maxWidth: Math.max(0, labelWidth - 48) }}
        >
          {moment?.text ?? (props.mascotState === "done" ? "Done" : "Stopped")}
        </Text>
      </View>
    ) : props.status !== null ? (
      <View
        pointerEvents={statusInteractive ? "box-none" : "none"}
        className="h-11 items-center justify-center"
      >
        <Animated.View className="h-11" style={capsuleSizerStyle} />
        <View
          pointerEvents={statusInteractive ? "box-none" : "none"}
          className="absolute h-11 items-center justify-center"
          style={{ width: labelWidth }}
        >
          <FloatingStatusLabel
            key={
              props.status.kind === "working" || props.status.kind === "compacting"
                ? props.status.kind
                : `${props.status.kind}:${props.status.label}`
            }
            status={props.status}
            onLayout={handleLabelLayout}
            {...(hasBoard ? { compactWidth: labelWidth - WORKING_LABEL_CHROME } : {})}
          />
        </View>
      </View>
    ) : null;

  // The board gives way: its name goes beside other segments, and beside the working status
  // (live progress included) it keeps only the counts, so both stay readable on a phone.
  const boardLabel = teamBoardCapsuleLabel(teamBoard, {
    beside: hasStatus ? "status" : hasAgents || hasQueue || hasPreview ? "segments" : null,
  });
  const capsuleContent = (
    <View className="flex-row items-center">
      {statusContent}
      {teamBoard !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={[
            "Open team board",
            `${teamBoard.postCount} ${teamBoard.postCount === 1 ? "post" : "posts"}`,
            teamBoard.overlapCount > 0
              ? `${teamBoard.overlapCount} ${teamBoard.overlapCount === 1 ? "overlap" : "overlaps"}`
              : null,
            teamBoard.unread ? "new posts" : null,
          ]
            .filter(Boolean)
            .join(", ")}
          onPress={teamBoard.onPress}
          onLayout={(event) => setBoardWidth(event.nativeEvent.layout.width)}
          // Never wider than the capsule; past that the overlaps, then the posts, truncate.
          style={{
            maxWidth: Math.max(0, Math.min(overlayWidth, windowWidth) - CONTROL_HEIGHT - 32),
          }}
          className="h-11 flex-row items-center gap-1.5 px-3 active:opacity-70"
        >
          {hasStatus ? <View className="mr-1 h-4 w-px bg-border" /> : null}
          <View>
            <SymbolView
              name={{ ios: "bubble.left.and.text.bubble.right", android: "chat" }}
              size={13}
              tintColorClassName="accent-foreground-muted"
            />
            {teamBoard.unread ? (
              <View className="absolute -top-0.5 -right-1 size-[7px] rounded-full bg-primary" />
            ) : null}
          </View>
          <Text
            maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
            className="font-t3-medium text-xs tabular-nums"
            numberOfLines={1}
            style={{ flexShrink: 1 }}
          >
            {boardLabel.lead}
            {boardLabel.overlaps ? (
              <Text
                maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
                className="font-t3-medium text-xs text-adaptive-amber-700-400"
              >
                {boardLabel.overlaps}
              </Text>
            ) : null}
          </Text>
        </Pressable>
      ) : null}
      {hasPreview ? (
        <View
          className="h-11 flex-row items-center"
          onLayout={(event) => setPreviewWidth(event.nativeEvent.layout.width)}
        >
          {hasStatus || hasBoard ? <View className="h-4 w-px bg-border" /> : null}
          {props.devicePreview !== null ? (
            <DevicePreviewButton {...props.devicePreview} compact={previewCompact} />
          ) : null}
          {props.browserPreview !== null ? (
            <BrowserPreviewButton {...props.browserPreview} compact={previewCompact} />
          ) : null}
        </View>
      ) : null}
      {agents !== null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open agents, ${agents.accessibilityLabel}`}
          accessibilityHint="Opens this turn's subagents"
          onPress={props.onOpenAgents}
          onLayout={(event) => setAgentsWidth(event.nativeEvent.layout.width)}
          className="h-11 flex-row items-center gap-1.5 px-3 active:opacity-70"
        >
          {hasStatus || hasPreview || hasBoard ? (
            <View className="mr-1 h-4 w-px bg-border" />
          ) : null}
          <SymbolView name="person.2" size={13} tintColorClassName="accent-foreground-muted" />
          <Text
            maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
            className="font-t3-medium text-xs tabular-nums"
            numberOfLines={1}
          >
            {agents.label}
          </Text>
        </Pressable>
      ) : null}
      {hasQueue ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${props.queueHeld ? "held " : ""}queue, ${props.queuedCount} messages`}
          accessibilityHint="Opens queued message actions"
          onPress={props.onOpenQueue}
          onLayout={(event) => setQueueWidth(event.nativeEvent.layout.width)}
          style={{ maxWidth: Math.min(overlayWidth, windowWidth) * 0.45 }}
          className="h-11 flex-row items-center gap-2 px-3 active:opacity-70"
        >
          {hasStatus || hasPreview || hasAgents || hasBoard ? (
            <View className="mr-1 h-4 w-px bg-border" />
          ) : null}
          <SymbolView name="list.number" size={13} tintColorClassName="accent-foreground-muted" />
          <Text
            maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
            className="shrink font-t3-medium text-xs tabular-nums"
            numberOfLines={1}
          >
            {props.queuedCount} {props.queueHeld ? "held" : "queued"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );

  return (
    <Animated.View
      pointerEvents="box-none"
      className="absolute left-0 right-0 z-20 items-center"
      style={[{ top: -CONTROL_OVERLAY_OFFSET }, liftStyle]}
      onLayout={(event) => setOverlayWidth(event.nativeEvent.layout.width)}
      entering={NATIVE_LIQUID_GLASS_SUPPORTED ? undefined : CONTROL_ENTERING}
      exiting={NATIVE_LIQUID_GLASS_SUPPORTED ? undefined : CONTROL_EXITING}
    >
      {hasCapsule && NATIVE_LIQUID_GLASS_SUPPORTED ? (
        <UniwindGlassContainer
          spacing={GLASS_MERGE_SPACING}
          pointerEvents="box-none"
          className="flex-row items-center gap-4"
        >
          <AnimatedGlassView
            colorScheme={props.colorScheme}
            glassEffectStyle="regular"
            isInteractive={capsuleInteractive}
            pointerEvents={capsuleInteractive ? "box-none" : "none"}
            className="h-11 items-center justify-center overflow-hidden rounded-full"
            style={capsuleStyle}
          >
            {capsuleContent}
          </AnimatedGlassView>

          <AnimatedGlassView
            colorScheme={props.colorScheme}
            glassEffectStyle={{ style: props.showScrollToEnd ? "regular" : "none", animate: true }}
            isInteractive
            pointerEvents={props.showScrollToEnd ? "auto" : "none"}
            accessibilityElementsHidden={!props.showScrollToEnd}
            importantForAccessibility={props.showScrollToEnd ? "auto" : "no-hide-descendants"}
            className="h-11 w-11 items-center justify-center overflow-hidden rounded-full"
            style={arrowTransformStyle}
          >
            <Animated.View style={arrowContentStyle}>
              <ScrollToEndButton disabled={!props.showScrollToEnd} onPress={props.onScrollToEnd} />
            </Animated.View>
          </AnimatedGlassView>
        </UniwindGlassContainer>
      ) : hasCapsule ? (
        <View pointerEvents="box-none" className="flex-row items-center gap-4">
          <Animated.View
            pointerEvents={capsuleInteractive ? "box-none" : "none"}
            className="h-11 items-center justify-center overflow-hidden rounded-full border border-border bg-glass-fallback shadow-md shadow-black/10"
            style={capsuleStyle}
          >
            {capsuleContent}
          </Animated.View>

          <Animated.View
            pointerEvents={props.showScrollToEnd ? "auto" : "none"}
            accessibilityElementsHidden={!props.showScrollToEnd}
            importantForAccessibility={props.showScrollToEnd ? "auto" : "no-hide-descendants"}
            style={[arrowTransformStyle, arrowContentStyle]}
          >
            <ControlPill
              accessibilityLabel="Scroll to end"
              activateOnPressIn
              className="h-11 w-11 border border-border bg-glass-fallback shadow-md shadow-black/10"
              disabled={!props.showScrollToEnd}
              icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
              onPress={props.onScrollToEnd}
            />
          </Animated.View>
        </View>
      ) : NATIVE_LIQUID_GLASS_SUPPORTED ? (
        <UniwindGlassView
          colorScheme={props.colorScheme}
          glassEffectStyle="regular"
          isInteractive
          className="h-11 w-11 items-center justify-center overflow-hidden rounded-full"
        >
          <ScrollToEndButton onPress={props.onScrollToEnd} />
        </UniwindGlassView>
      ) : (
        <ControlPill
          accessibilityLabel="Scroll to end"
          activateOnPressIn
          className="h-11 w-11 border border-border bg-glass-fallback shadow-md shadow-black/10"
          icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
          onPress={props.onScrollToEnd}
        />
      )}
    </Animated.View>
  );
}

export function teamBoardCapsuleLabel(
  board: { readonly postCount: number; readonly overlapCount: number } | null,
  options: { readonly beside: "status" | "segments" | null },
): { readonly lead: string; readonly overlaps: string | null } {
  if (board === null) return { lead: "", overlaps: null };
  const posts = `${board.postCount} ${board.postCount === 1 ? "post" : "posts"}`;
  const overlaps = `${board.overlapCount} ${board.overlapCount === 1 ? "overlap" : "overlaps"}`;
  const hasOverlaps = board.overlapCount > 0;
  if (options.beside === "status") {
    return {
      lead: String(board.postCount),
      overlaps: hasOverlaps ? ` · ${board.overlapCount}` : null,
    };
  }
  return {
    lead: options.beside === "segments" ? posts : `Team board · ${posts}`,
    overlaps: hasOverlaps ? ` · ${overlaps}` : null,
  };
}

function CompactingLabel(props: { readonly onLayout: (event: LayoutChangeEvent) => void }) {
  return (
    <StatusLabelRow accessibilityLabel="Compacting" className="gap-1.5" onLayout={props.onLayout}>
      <SymbolView
        name="arrow.down.right.and.arrow.up.left"
        size={13}
        tintColorClassName="accent-foreground"
        type="monochrome"
      />
      <Text
        maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
        className="font-t3-medium text-xs text-foreground"
      >
        Compacting…
      </Text>
    </StatusLabelRow>
  );
}

function FloatingStatusLabel(props: {
  readonly status: FloatingWorkingStatus;
  readonly onLayout: (event: LayoutChangeEvent) => void;
  /** Set beside the team board's counts: the working text's room for its compact form. */
  readonly compactWidth?: number;
}) {
  // Keyed by kind so a swap mounts a fresh row and the two cross-fade while
  // the capsule animates to the new row's measured width.
  if (props.status.kind === "syncing") {
    return (
      <StatusLabelRow
        key="syncing"
        accessibilityLabel={props.status.label}
        className="gap-2"
        onLayout={props.onLayout}
      >
        {props.status.showSpinner ? (
          <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
        ) : null}
        <Text
          maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
          className="shrink font-t3-medium text-xs text-foreground"
          numberOfLines={1}
        >
          {props.status.label}
        </Text>
      </StatusLabelRow>
    );
  }
  if (props.status.kind === "compacting") {
    return <CompactingLabel key="compacting" onLayout={props.onLayout} />;
  }
  if (props.status.kind === "child-input") {
    return (
      <StatusLabelRow
        key="child-input"
        accessibilityLabel={props.status.accessibilityLabel}
        accessibilityRole="button"
        className="gap-2"
        onLayout={props.onLayout}
        onPress={props.status.onPress}
      >
        <SymbolView name="text.bubble" size={13} tintColorClassName="accent-foreground" />
        <Text
          maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
          className="shrink font-t3-medium text-xs text-foreground"
          numberOfLines={1}
        >
          {props.status.label}
        </Text>
      </StatusLabelRow>
    );
  }
  if (props.status.kind === "connection") {
    return (
      <StatusLabelRow
        key="connection"
        accessibilityLabel={props.status.label}
        accessibilityRole="button"
        className="gap-2"
        onLayout={props.onLayout}
        onPress={props.status.onPress}
      >
        {props.status.tone === "reconnecting" ? (
          <AppActivityIndicator size="small" colorClassName="accent-icon-muted" />
        ) : (
          <View className="h-2 w-2 rounded-full bg-red-500" />
        )}
        <Text
          maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
          className="max-w-[260px] shrink font-t3-medium text-xs text-foreground"
          numberOfLines={1}
        >
          {props.status.label}
        </Text>
      </StatusLabelRow>
    );
  }
  if (props.status.kind === "background") {
    return (
      <StatusLabelRow
        key="background"
        accessibilityLabel={props.status.accessibilityLabel}
        className="gap-2"
        onLayout={props.onLayout}
        accessible={props.status.held === undefined}
        {...(props.status.onPress && props.status.held === undefined
          ? { accessibilityRole: "button" as const, onPress: props.status.onPress }
          : {})}
      >
        {/* A dev server can run for hours after the agent is done, so only work
            that will wake the agent gets the bolt. */}
        <SymbolView
          name={
            props.status.running === false || props.status.held
              ? "clock"
              : props.status.waiting
                ? { ios: "bolt", android: "bolt" }
                : "terminal"
          }
          size={13}
          tintColorClassName="accent-foreground"
          type="monochrome"
        />
        {props.status.held ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={props.status.accessibilityLabel}
            className="shrink active:opacity-70"
            onPress={props.status.onPress}
          >
            <Text
              maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
              className="font-t3-medium text-xs text-foreground"
              numberOfLines={1}
            >
              {props.status.label}
            </Text>
          </Pressable>
        ) : (
          <Text
            maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
            className="shrink font-t3-medium text-xs text-foreground"
            numberOfLines={1}
          >
            {props.status.label}
          </Text>
        )}
        {props.status.held ? <HeldBackgroundWorkActions {...props.status.held} /> : null}
      </StatusLabelRow>
    );
  }
  if (props.status.kind === "goal") {
    return (
      <StatusLabelRow
        key="goal"
        accessibilityLabel={props.status.accessibilityLabel}
        className="gap-2"
        onLayout={props.onLayout}
      >
        <SymbolView
          name="target"
          size={13}
          tintColorClassName="accent-foreground"
          type="monochrome"
        />
        <Text
          maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
          className="shrink font-t3-medium text-xs text-foreground"
          numberOfLines={1}
        >
          {props.status.label}
        </Text>
      </StatusLabelRow>
    );
  }
  if (props.status.kind === "preparing") {
    return (
      <StatusLabelRow
        key="preparing"
        accessibilityLabel={props.status.label}
        className="gap-1.5"
        onLayout={props.onLayout}
      >
        <SymbolView
          name="arrow.triangle.branch"
          size={13}
          tintColorClassName="accent-foreground"
          type="monochrome"
        />
        <ShimmeringWorkContent
          className="flex-none"
          textClassName="font-t3-medium"
          compact
          icon="arrow.triangle.branch"
          iconSubtleColor="transparent"
          label={props.status.label}
          showIcon={false}
        />
      </StatusLabelRow>
    );
  }
  return (
    <WorkingDuration
      key="working"
      startedAt={props.status.startedAt}
      rate={formatGenerationRate(props.status.generation)}
      progress={props.status.progress}
      onLayout={props.onLayout}
      compactWidth={props.compactWidth}
    />
  );
}

// Absolute rows cross-fade around the same center without affecting each other.
function StatusLabelRow(props: {
  readonly accessible?: boolean;
  readonly accessibilityLabel?: string;
  readonly accessibilityRole?: "button";
  readonly className?: string;
  readonly children: ReactNode;
  readonly onLayout: (event: LayoutChangeEvent) => void;
  readonly onPress?: () => void;
}) {
  const rowClassName = `h-11 flex-row items-center px-4 ${props.className ?? ""}`;
  return (
    <Animated.View
      className="absolute max-w-full"
      entering={LABEL_ENTERING}
      exiting={LABEL_EXITING}
      onLayout={props.onLayout}
    >
      {props.onPress ? (
        <Pressable
          accessibilityLabel={props.accessibilityLabel}
          accessibilityRole={props.accessibilityRole}
          className={`${rowClassName} active:opacity-70`}
          onPress={props.onPress}
        >
          {props.children}
        </Pressable>
      ) : (
        <View
          accessible={props.accessible ?? true}
          accessibilityLabel={props.accessibilityLabel}
          className={rowClassName}
        >
          {props.children}
        </View>
      )}
    </Animated.View>
  );
}

function WorkingDuration(props: {
  readonly startedAt: string;
  readonly rate: string | undefined;
  readonly progress: Extract<FloatingWorkingStatus, { kind: "working" }>["progress"];
  readonly onLayout: (event: LayoutChangeEvent) => void;
  readonly compactWidth: number | undefined;
}) {
  // Token use High: time left replaces the rate, and a thin bar runs along the bottom edge.
  const card = useLiveProgressCard(props.progress?.value);
  const timeLeft = card?.pillTimeLeft ?? undefined;
  return (
    <StatusLabelRow
      onLayout={props.onLayout}
      className="gap-1.5"
      {...(props.progress === undefined
        ? {}
        : {
            accessibilityRole: "button" as const,
            accessibilityLabel: `Working${timeLeft ? `, ${timeLeft}` : ""}. Shows progress.`,
            onPress: props.progress.onPress,
          })}
    >
      <HarnessMascot state="working" size={28} />
      {props.compactWidth === undefined ? (
        <WorkingTimer startedAt={props.startedAt} rate={timeLeft ?? props.rate} />
      ) : (
        <CompactWorkingTimer
          startedAt={props.startedAt}
          detail={timeLeft ?? props.rate}
          width={props.compactWidth}
        />
      )}
      {card !== null ? (
        <View pointerEvents="none" className="absolute right-5 bottom-[5px] left-5">
          <LiveProgressBar fraction={card.fraction} size="mini" />
        </View>
      ) : null}
    </StatusLabelRow>
  );
}

/**
 * `Working 4m 12s`, then ` · 84 tok/s` in muted text once the turn has a timed reply, or
 * ` · 8 min left` when its live progress has an estimate.
 */
export function WorkingTimer(props: { readonly startedAt: string; readonly rate?: string }) {
  const nowMs = useVisibleSecondClock(true);
  return (
    <SystemText
      maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
      className="shrink text-xs text-foreground"
      numberOfLines={1}
      style={{ fontVariant: ["tabular-nums"], fontWeight: "500" }}
    >
      Working {formatWorkingDuration(props.startedAt, nowMs)}
      {props.rate === undefined ? null : (
        <SystemText className="text-foreground-muted">{` · ${props.rate}`}</SystemText>
      )}
    </SystemText>
  );
}

/**
 * Beside the team board's counts the working text drops "Working": "57s · 3 min left" while all
 * of it fits, otherwise the elapsed time alone. A word is never cut; until the full text has been
 * measured, only the elapsed time shows.
 */
export function compactWorkingLabel(input: {
  readonly elapsed: string;
  readonly detail: string | undefined;
  readonly width: number;
  readonly fullWidth: number | null;
}): string {
  if (input.detail === undefined) return input.elapsed;
  return input.fullWidth !== null && input.fullWidth <= input.width
    ? `${input.elapsed} · ${input.detail}`
    : input.elapsed;
}

function CompactWorkingTimer(props: {
  readonly startedAt: string;
  readonly detail: string | undefined;
  readonly width: number;
}) {
  const nowMs = useVisibleSecondClock(true);
  const [fullWidth, setFullWidth] = useState<number | null>(null);
  const elapsed = formatWorkingDuration(props.startedAt, nowMs);
  const label = compactWorkingLabel({
    elapsed,
    detail: props.detail,
    width: props.width,
    fullWidth,
  });
  const textStyle = { fontVariant: ["tabular-nums" as const], fontWeight: "500" as const };
  return (
    <>
      <SystemText
        maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
        className="text-xs text-foreground"
        numberOfLines={1}
        style={textStyle}
      >
        {elapsed}
        {label === elapsed ? null : (
          <SystemText className="text-foreground-muted">{` · ${props.detail}`}</SystemText>
        )}
      </SystemText>
      {props.detail === undefined ? null : (
        // Unconstrained twin of the full text, measured to decide whether it fits.
        <View
          testID="working-label-measure"
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{ position: "absolute", left: 0, top: 0, width: 1000, opacity: 0 }}
        >
          <SystemText
            maxFontSizeMultiplier={CAPSULE_MAX_FONT_SCALE}
            className="text-xs"
            style={[textStyle, { alignSelf: "flex-start" }]}
            onLayout={(event) => setFullWidth(event.nativeEvent.layout.width)}
          >
            {`${elapsed} · ${props.detail}`}
          </SystemText>
        </View>
      )}
    </>
  );
}

function formatWorkingDuration(startedAt: string, nowMs: number): string {
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs) || nowMs <= startedAtMs) {
    return "0s";
  }

  const totalSeconds = Math.floor((nowMs - startedAtMs) / 1_000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  if (totalSeconds >= 3_600) {
    return formatDuration(totalSeconds * 1_000);
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}m ${seconds}s`;
}

function ScrollToEndButton(props: { readonly disabled?: boolean; readonly onPress: () => void }) {
  return (
    <ControlPill
      accessibilityLabel="Scroll to end"
      activateOnPressIn
      className="h-11 w-11 bg-transparent"
      disabled={props.disabled}
      icon={{ ios: "chevron.down", android: "keyboard_arrow_down" }}
      onPress={props.onPress}
    />
  );
}
