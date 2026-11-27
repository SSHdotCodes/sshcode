import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import { BOTS_NOTE, BOTS_TITLE, NEW_BOT_LABEL } from "@t3tools/client-runtime/state/bots";
import * as Haptics from "expo-haptics";
import { Pressable } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPillMenu";
import { ListRowLayout } from "../../components/ListRowLayout";
import { ScreenScrollView } from "../../components/ScreenScrollView";
import { BotAvatar } from "../bots/BotAvatar";
import type { BotEntry } from "../bots/botVisibility";
import { useBotEntries, useBotRuntime, useBotsEnabled, useBotStatus } from "../bots/state";
import { useBotActions } from "../bots/useBotActions";
import { useAdaptiveWorkspaceLayout } from "../layout/AdaptiveWorkspaceLayout";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

function BotListRow(props: { readonly entry: BotEntry }) {
  const { entry } = props;
  const { bot } = entry;
  const runtime = useBotRuntime(entry);
  const status = useBotStatus(entry, runtime);
  const actions = useBotActions();
  const { selectThread } = useAdaptiveWorkspaceLayout();
  const menu: MenuAction[] = [
    { id: "open", title: "Open", image: "bubble.left" },
    { id: "edit", title: "Edit", image: "pencil" },
    bot.paused
      ? { id: "resume", title: "Resume", image: "play" }
      : { id: "pause", title: "Pause", image: "pause" },
    { id: "delete", title: "Delete", image: "trash", attributes: { destructive: true } },
  ];
  const open = () => selectThread({ environmentId: entry.environmentId, id: bot.threadId });
  return (
    <ControlPillMenu
      actions={menu}
      shouldOpenOnLongPress
      onPressAction={({ nativeEvent }) => {
        if (nativeEvent.event === "open") open();
        if (nativeEvent.event === "edit") actions.edit(entry);
        if (nativeEvent.event === "pause") actions.setPaused(entry, true);
        if (nativeEvent.event === "resume") actions.setPaused(entry, false);
        if (nativeEvent.event === "delete") actions.remove(entry);
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityHint="Edits the bot. Touch and hold for more."
        onPress={() => actions.edit(entry)}
        className="active:opacity-70"
      >
        <ListRowLayout
          leading={
            <BotAvatar color={bot.color} size={32} seed={bot.id} status={status.kind} still />
          }
          label={bot.name}
          description={status.label}
          accessory={
            <SymbolView
              name="chevron.right"
              size={14}
              tintColorClassName="accent-chevron"
              type="monochrome"
              weight="semibold"
            />
          }
        />
      </Pressable>
    </ControlPillMenu>
  );
}

/**
 * Settings > Bots: the switch (off by default; every connected machine follows it, like
 * Settings > Agents), and while on, every bot across machines plus New bot.
 */
export function SettingsBotsRouteScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation();
  const { enabled, setEnabled, writable, targets } = useBotsEnabled();
  const entries = useBotEntries();
  const disabled = targets.length === 0 || !writable;
  return (
    <SettingsScreen title={BOTS_TITLE}>
      <ScreenScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection
          footer={
            targets.length === 0 ? "Bots need a machine running the latest SSHCode." : BOTS_NOTE
          }
        >
          <SettingsSwitchRow
            label={BOTS_TITLE}
            value={enabled}
            disabled={disabled}
            onValueChange={(value) => {
              void Haptics.selectionAsync();
              setEnabled(value);
            }}
          />
        </SettingsSection>
        {enabled ? (
          <SettingsSection separated>
            {entries.map((entry) => (
              <BotListRow key={`${entry.environmentId}:${entry.bot.id}`} entry={entry} />
            ))}
            <Pressable
              accessibilityRole="button"
              disabled={disabled}
              onPress={() => {
                void Haptics.selectionAsync();
                navigation.navigate("BotEditor", undefined);
              }}
              className="active:opacity-70 disabled:opacity-50"
            >
              <ListRowLayout
                leading={<SymbolView name="plus" size={20} tintColorClassName="accent-primary" />}
                label={NEW_BOT_LABEL}
              />
            </Pressable>
          </SettingsSection>
        ) : null}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
