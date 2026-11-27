import type { MenuAction } from "@react-native-menu/menu";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  BOT_INFO_SECTIONS,
  BOT_MEMORY_EMPTY,
  BOT_PERMISSION_ROWS,
  BOT_ROUTINES_EMPTY,
  BOT_WATCHING_EMPTY,
  botMemoryDayLabel,
  botWaitingLabel,
} from "@t3tools/client-runtime/state/bots";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  BOT_MEMORY_ENTRY_MAX,
  type BotMemoryEntry,
  type BotWatch,
  type ModelSelection,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useCallback } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { showTextInputDialog } from "../../components/ConfirmDialogHost";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { ListRowLayout } from "../../components/ListRowLayout";
import { ListSection } from "../../components/ListSection";
import { ListToggleRow } from "../../components/ListToggleRow";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "./BotAvatar";
import { BotModelRow } from "./BotModelRow";
import { BotSheetFrame } from "./BotSheetFrame";
import type { BotEntry } from "./botVisibility";
import { useBotEntry, useBotRuntime, useBotStatus } from "./state";
import { useBotActions, useBotMutation } from "./useBotActions";

type BotInfoParams = { readonly environmentId: string; readonly botId: string };

const MEMORY_MENU: MenuAction[] = [
  { id: "edit", title: "Edit", image: "pencil" },
  { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
];

function Empty(props: { readonly text: string }) {
  return <Text className="px-4 py-3 text-[15px] text-foreground-muted">{props.text}</Text>;
}

function MemoryRow(props: { readonly entry: BotEntry; readonly memory: BotMemoryEntry }) {
  const run = useBotMutation();
  const { entry, memory } = props;
  return (
    <ControlPillMenu
      actions={MEMORY_MENU}
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "delete") {
          void Haptics.selectionAsync();
          void run(
            entry.environmentId,
            { type: "memory", botId: entry.bot.id, remove: memory.id },
            "Could not delete that note",
          );
        }
        if (nativeEvent.event === "edit")
          showTextInputDialog({
            title: "Edit note",
            initialValue: memory.text,
            confirmText: "Save",
            onConfirm: (text) => {
              const next = text.trim().slice(0, BOT_MEMORY_ENTRY_MAX);
              if (next.length === 0 || next === memory.text) return;
              void run(
                entry.environmentId,
                { type: "memory", botId: entry.bot.id, replace: { id: memory.id, text: next } },
                "Could not save that note",
              );
            },
          });
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Edit or delete"
        className="active:opacity-70"
      >
        <ListRowLayout
          label={memory.text}
          description={botMemoryDayLabel(memory.at, new Date().getFullYear())}
        />
      </Pressable>
    </ControlPillMenu>
  );
}

function WatchRow(props: { readonly entry: BotEntry; readonly watch: BotWatch }) {
  const run = useBotMutation();
  const chat = useThreadShell(scopeThreadRef(props.entry.environmentId, props.watch.threadId));
  const title = chat?.title ?? "A chat";
  return (
    <ListRowLayout
      label={title}
      {...(props.watch.events.length > 0 ? { description: props.watch.events.join(", ") } : {})}
      accessory={
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Stop watching ${title}`}
          hitSlop={10}
          className="size-7 items-center justify-center rounded-full bg-subtle active:opacity-60"
          onPress={() => {
            void Haptics.selectionAsync();
            void run(
              props.entry.environmentId,
              { type: "unwatch", botId: props.entry.bot.id, threadIds: [props.watch.threadId] },
              "Could not stop watching",
            );
          }}
        >
          <SymbolView name="xmark" size={11} weight="bold" tintColorClassName="accent-icon-muted" />
        </Pressable>
      }
    />
  );
}

function RoutineRows(props: { readonly entry: BotEntry }) {
  const { environmentId, bot } = props.entry;
  const tasks = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "bot routine enabled",
    reportFailure: false,
  });
  const routines = (tasks.data?.tasks ?? []).filter(
    (task: ScheduledTask) => task.threadId === bot.threadId,
  );
  if (routines.length === 0) return <Empty text={BOT_ROUTINES_EMPTY} />;
  return (
    <>
      {routines.map((task) => (
        <ListToggleRow
          key={task.id}
          label={task.title}
          value={task.enabled}
          onValueChange={(enabled) => {
            void Haptics.selectionAsync();
            void setEnabled({ environmentId, input: { id: task.id, enabled } }).then((result) => {
              if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
                Alert.alert(
                  "Could not change the routine",
                  String(squashAtomCommandFailure(result)),
                );
            });
          }}
        />
      ))}
    </>
  );
}

/** A bot's info, from its chat's header: what it remembers, watches and runs, and its settings. */
export function BotInfoSheet({ route }: StaticScreenProps<BotInfoParams>) {
  const navigation = useNavigation();
  const entry = useBotEntry(route.params.environmentId, route.params.botId);
  if (entry === null)
    return (
      <BotSheetFrame title="Bot">
        <Empty text="This bot is gone or Bots are off." />
      </BotSheetFrame>
    );
  return (
    <BotInfoContent entry={entry} onDeleted={() => navigation.dispatch(StackActions.popToTop())} />
  );
}

function BotInfoContent(props: { readonly entry: BotEntry; readonly onDeleted: () => void }) {
  const { entry } = props;
  const { bot } = entry;
  const runtime = useBotRuntime(entry);
  const status = useBotStatus(entry, runtime);
  const run = useBotMutation();
  const actions = useBotActions();
  const changeModel = useCallback(
    (target: ModelSelection) =>
      void run(
        entry.environmentId,
        { type: "update", botId: bot.id, target },
        `Could not change ${bot.name}'s model`,
      ),
    [bot.id, bot.name, entry.environmentId, run],
  );
  const memory = runtime?.memory ?? [];
  const watching = runtime?.watching ?? [];
  return (
    <BotSheetFrame title={bot.name}>
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-5 px-4 pt-2 pb-8"
      >
        <View className="items-center gap-2 pt-1">
          <BotAvatar color={bot.color} size={64} seed={bot.id} status={status.kind} />
          <Text className="text-[13px] text-foreground-muted">{status.label}</Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => actions.edit(entry)}
            hitSlop={6}
            className="rounded-full bg-subtle px-3.5 py-1.5 active:opacity-60"
          >
            <Text className="text-[13px] font-t3-medium text-foreground">
              Edit name and personality
            </Text>
          </Pressable>
        </View>
        <ListSection title={BOT_INFO_SECTIONS.memory} separated>
          {memory.length === 0 ? (
            <Empty text={BOT_MEMORY_EMPTY} />
          ) : (
            [...memory]
              .reverse()
              .map((item) => <MemoryRow key={item.id} entry={entry} memory={item} />)
          )}
        </ListSection>
        <ListSection title={BOT_INFO_SECTIONS.watching} separated>
          {watching.length === 0 ? (
            <Empty text={BOT_WATCHING_EMPTY} />
          ) : (
            watching.map((watch) => <WatchRow key={watch.threadId} entry={entry} watch={watch} />)
          )}
        </ListSection>
        <ListSection title={BOT_INFO_SECTIONS.routines} separated>
          <RoutineRows entry={entry} />
        </ListSection>
        <ListSection title={BOT_INFO_SECTIONS.permissions} separated>
          {BOT_PERMISSION_ROWS.map((row) => (
            <ListToggleRow
              key={row.key}
              label={row.title}
              description={row.copy}
              value={bot.permissions[row.key]}
              onValueChange={(value) => {
                void Haptics.selectionAsync();
                void run(
                  entry.environmentId,
                  { type: "update", botId: bot.id, permissions: { [row.key]: value } },
                  `Could not change ${row.title}`,
                );
              }}
            />
          ))}
        </ListSection>
        <ListSection title={BOT_INFO_SECTIONS.model}>
          <BotModelRow
            ownerId={`bot-info:${entry.environmentId}:${bot.id}`}
            environmentId={entry.environmentId}
            selection={bot.target}
            onChange={changeModel}
          />
        </ListSection>
        <ListSection
          {...((runtime?.waiting ?? 0) > 0 && bot.paused
            ? { footer: botWaitingLabel(runtime?.waiting ?? 0) }
            : {})}
        >
          <ListToggleRow
            label="Pause"
            description="No updates, messages or routines wake it while paused."
            value={bot.paused === true}
            onValueChange={(paused) => actions.setPaused(entry, paused)}
          />
        </ListSection>
        <ListSection>
          <Pressable
            accessibilityRole="button"
            onPress={() => actions.remove(entry, props.onDeleted)}
            className="active:opacity-60"
          >
            <ListRowLayout
              label={`Delete ${bot.name}`}
              leading={
                <SymbolView name="trash" size={18} tintColorClassName="accent-danger-foreground" />
              }
            />
          </Pressable>
        </ListSection>
      </ScrollView>
    </BotSheetFrame>
  );
}
