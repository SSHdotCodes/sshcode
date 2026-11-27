import { useNavigation } from "@react-navigation/native";
import {
  BOT_NEEDS_YOU_COLOR,
  BOT_STARTERS,
  BOTS_OFF_SETTINGS_LABEL,
  botGreeting,
  botsOffNote,
  type BotStatusKind,
} from "@t3tools/client-runtime/state/bots";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { Pressable, View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { SymbolView } from "../../components/AppSymbol";
import { environmentThreadDetails } from "../../state/threads";
import { AppText as Text } from "../../components/AppText";
import { BotAvatar } from "./BotAvatar";
import { botInboundLines, type BotInboundLine } from "./botInboundNotes";
import type { BotEntry } from "./botVisibility";

/**
 * A note SSHCode posted into the bot chat: a centered muted pill naming the chat it came
 * from (tap opens that chat), with its text below in a soft bubble.
 */
export function BotInboundNote(props: {
  readonly lines: ReadonlyArray<BotInboundLine>;
  readonly environmentId: EnvironmentId;
}) {
  const navigation = useNavigation();
  return (
    <View className="items-center gap-2 py-2">
      {props.lines.map((line) => {
        const threadId = line.threadId;
        const pill = (
          <View className="max-w-[88%] flex-row items-center gap-1 rounded-full bg-subtle px-3 py-1">
            <Text
              className="shrink text-[12px] font-t3-medium text-foreground-muted"
              numberOfLines={1}
            >
              {line.pill}
            </Text>
            {threadId !== null ? (
              <SymbolView
                name="chevron.right"
                size={9}
                weight="semibold"
                tintColorClassName="accent-foreground-muted"
              />
            ) : null}
          </View>
        );
        return (
          <View key={line.key} className="w-full items-center gap-1.5">
            {threadId !== null ? (
              <Pressable
                accessibilityRole="link"
                accessibilityHint="Opens that chat"
                hitSlop={6}
                className="max-w-full items-center active:opacity-60"
                onPress={() => {
                  void Haptics.selectionAsync();
                  navigation.navigate("Thread", {
                    environmentId: String(props.environmentId),
                    threadId,
                  });
                }}
              >
                {pill}
              </Pressable>
            ) : (
              pill
            )}
            {line.text ? (
              <View className="max-w-[88%] rounded-2xl border-continuous bg-subtle px-3.5 py-2.5">
                <Text className="text-[15px] leading-[21px] text-foreground" selectable>
                  {line.text}
                </Text>
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/**
 * A wake note (watched chats, other chats' messages, held routines). Its row carries only a
 * summary; the lines with their chat links come from the message it was posted as.
 */
export function BotWakeNote(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: string;
  readonly summary: string;
}) {
  const text = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(props.environmentId, props.threadId)),
    (detail) =>
      detail?.projection.messages.find((message) => message.id === props.messageId)?.text ?? null,
  );
  const lines = (text === null ? null : botInboundLines(text)) ?? [
    { key: props.messageId, pill: props.summary, threadId: null, text: null },
  ];
  return <BotInboundNote lines={lines} environmentId={props.environmentId} />;
}

/** A new bot chat: the bot's face, its hello and three things to ask it. */
export function BotEmptyState(props: {
  readonly entry: BotEntry;
  /** Null while Bots are off: the chat takes no messages, so no starters show. */
  readonly onStarter: ((text: string) => void) | null;
  readonly disabled?: boolean;
}) {
  const { bot } = props.entry;
  return (
    <View className="w-full max-w-[340px] items-center gap-3 self-center px-6">
      <BotAvatar
        color={bot.color}
        size={88}
        seed={bot.id}
        status={bot.paused ? "paused" : "idle"}
      />
      <Text className="mt-1 text-center text-xl font-t3-semibold text-foreground">
        {botGreeting(bot.name)}
      </Text>
      {props.onStarter === null ? null : (
        <View className="mt-2 w-full gap-2">
          {BOT_STARTERS.map((starter) => (
            <Pressable
              key={starter}
              accessibilityRole="button"
              disabled={props.disabled}
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                props.onStarter?.(starter);
              }}
              className="min-h-11 justify-center rounded-2xl border-continuous border border-border bg-card px-4 py-2.5 active:opacity-60 disabled:opacity-50"
            >
              <Text className="text-[15px] text-foreground">{starter}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </View>
  );
}

/** The bot chat's header title: its face, name and one muted status line. Opens the info sheet. */
export function BotHeaderTitle(props: {
  readonly entry: BotEntry;
  readonly status: { readonly kind: BotStatusKind; readonly label: string };
  readonly maxWidth: number;
  readonly onPress: () => void;
}) {
  const { bot } = props.entry;
  const { color: headerColor } = useResolveClassNames("text-header-foreground");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${bot.name}, ${props.status.label}`}
      accessibilityHint="Shows the bot's memory, routines and settings"
      onPress={props.onPress}
      hitSlop={6}
      className="flex-row items-center gap-2 active:opacity-60"
      style={{ maxWidth: props.maxWidth }}
    >
      <BotAvatar color={bot.color} size={30} seed={bot.id} status={props.status.kind} />
      <View className="shrink">
        <Text
          className="text-[16px] font-t3-semibold leading-5"
          style={{ color: typeof headerColor === "string" ? headerColor : undefined }}
          numberOfLines={1}
        >
          {bot.name}
        </Text>
        <Text
          className="text-[12px] leading-4 text-foreground-muted"
          style={props.status.kind === "needsYou" ? { color: BOT_NEEDS_YOU_COLOR } : undefined}
          numberOfLines={1}
        >
          {props.status.label}
        </Text>
      </View>
    </Pressable>
  );
}

/** The title of a bot's chat while Bots are off: its face and name only. */
export function BotParkedHeaderTitle(props: {
  readonly entry: BotEntry;
  readonly maxWidth: number;
}) {
  const { bot } = props.entry;
  const { color: headerColor } = useResolveClassNames("text-header-foreground");
  return (
    <View
      accessible
      accessibilityLabel={bot.name}
      className="flex-row items-center gap-2"
      style={{ maxWidth: props.maxWidth }}
    >
      <BotAvatar color={bot.color} size={30} seed={bot.id} status="paused" />
      <Text
        className="shrink text-[16px] font-t3-semibold leading-5"
        style={{ color: typeof headerColor === "string" ? headerColor : undefined }}
        numberOfLines={1}
      >
        {bot.name}
      </Text>
    </View>
  );
}

/** Stands in for the composer of a bot's chat while Bots are off. */
export function BotsOffBar(props: {
  readonly entry: BotEntry;
  readonly onOpenSettings: () => void;
}) {
  return (
    <View className="min-h-12 flex-row items-center gap-3 rounded-[20px] border border-border-subtle bg-card-alt py-2 pe-2 ps-4">
      <Text className="min-w-0 flex-1 font-sans text-sm text-foreground-secondary">
        {botsOffNote(props.entry.bot.name)}
      </Text>
      <Pressable
        accessibilityRole="button"
        onPress={props.onOpenSettings}
        hitSlop={6}
        className="min-h-9 justify-center rounded-full px-3 active:opacity-60"
      >
        <Text className="font-t3-medium text-sm text-primary">{BOTS_OFF_SETTINGS_LABEL}</Text>
      </Pressable>
    </View>
  );
}
