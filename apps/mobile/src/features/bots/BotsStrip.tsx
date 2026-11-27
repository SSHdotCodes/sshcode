import type { MenuAction } from "@react-native-menu/menu";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { BOTS_TITLE, type BotStatusKind } from "@t3tools/client-runtime/state/bots";
import * as Haptics from "expo-haptics";
import { useEffect, type ReactNode } from "react";
import { Pressable, ScrollView, View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/AppText";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { BotAvatar } from "./BotAvatar";
import type { BotEntry } from "./botVisibility";
import { useBotEntries, useBotRuntime, useBotStatus } from "./state";
import { useAmbientMotion } from "./useAmbientMotion";
import { useBotActions } from "./useBotActions";

const AVATAR = 52;
const RING = AVATAR + 8;
const RING_STROKE = 2;
const RING_RADIUS = (RING - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
const RING_TURN_MS = 2_800;

/** Working: a short accent arc slowly circling the avatar. Still under Reduce Motion. */
function BotStatusRing(props: { readonly status: BotStatusKind; readonly children: ReactNode }) {
  const working = props.status === "working";
  const moving = useAmbientMotion() && working;
  const turn = useSharedValue(0);
  const { accentColor } = useResolveClassNames("accent-primary");
  useEffect(() => {
    cancelAnimation(turn);
    turn.set(0);
    if (moving)
      turn.set(withRepeat(withTiming(360, { duration: RING_TURN_MS, easing: Easing.linear }), -1));
    return () => cancelAnimation(turn);
  }, [moving, turn]);
  const spin = useAnimatedStyle(() => ({ transform: [{ rotate: `${turn.get()}deg` }] }));
  return (
    <View style={{ width: RING, height: RING }} className="items-center justify-center">
      {working ? (
        <Animated.View
          pointerEvents="none"
          style={[{ position: "absolute", width: RING, height: RING }, spin]}
        >
          <Svg width={RING} height={RING}>
            <Circle
              cx={RING / 2}
              cy={RING / 2}
              r={RING_RADIUS}
              fill="none"
              stroke={accentColor}
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={`${RING_CIRCUMFERENCE * 0.3} ${RING_CIRCUMFERENCE}`}
            />
          </Svg>
        </Animated.View>
      ) : null}
      {props.children}
    </View>
  );
}

function BotStripItem(props: {
  readonly entry: BotEntry;
  readonly backdropColor: string | undefined;
  readonly onOpen: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;
}) {
  const { entry } = props;
  const { bot } = entry;
  const runtime = useBotRuntime(entry);
  const status = useBotStatus(entry, runtime);
  const actions = useBotActions();
  const menu: MenuAction[] = [
    { id: "edit", title: "Edit", image: "pencil" },
    bot.paused
      ? { id: "resume", title: "Resume", image: "play" }
      : { id: "pause", title: "Pause", image: "pause" },
    { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
  ];
  return (
    <ControlPillMenu
      actions={menu}
      shouldOpenOnLongPress
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "edit") actions.edit(entry);
        if (nativeEvent.event === "pause") actions.setPaused(entry, true);
        if (nativeEvent.event === "resume") actions.setPaused(entry, false);
        if (nativeEvent.event === "delete") actions.remove(entry);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${bot.name}, ${status.label}`}
        accessibilityHint="Opens the bot's chat. Touch and hold for more."
        onPress={() => {
          void Haptics.selectionAsync();
          props.onOpen({ environmentId: entry.environmentId, id: bot.threadId });
        }}
        className="w-[68px] items-center gap-1 active:opacity-70"
      >
        <BotStatusRing status={status.kind}>
          <BotAvatar
            color={bot.color}
            size={AVATAR}
            status={status.kind}
            seed={bot.id}
            backdropColor={props.backdropColor}
          />
        </BotStatusRing>
        <Text
          className="max-w-full text-[12px] leading-4 text-foreground"
          numberOfLines={1}
          style={{ opacity: bot.paused ? 0.6 : 1 }}
        >
          {bot.name}
        </Text>
      </Pressable>
    </ControlPillMenu>
  );
}

/**
 * The chat list's Bots row: each bot as an avatar with its name, a ring while it works, an
 * amber dot when it needs you, dimmed while paused. Tap opens its chat; hold for Edit, Pause
 * and Delete. Nothing shows while Bots are off or no bot exists.
 */
export function BotsStrip(props: {
  readonly onOpen: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;
  readonly backgroundClassName?: string;
}) {
  const entries = useBotEntries();
  const { backgroundColor } = useResolveClassNames(props.backgroundClassName ?? "bg-screen");
  if (entries.length === 0) return null;
  return (
    <View className="pb-2">
      <Text className="px-5 pb-1 text-[13px] font-t3-medium text-foreground-muted">
        {BOTS_TITLE}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-1 px-3"
      >
        {entries.map((entry) => (
          <BotStripItem
            key={`${entry.environmentId}:${entry.bot.id}`}
            entry={entry}
            backdropColor={typeof backgroundColor === "string" ? backgroundColor : undefined}
            onOpen={props.onOpen}
          />
        ))}
      </ScrollView>
    </View>
  );
}
