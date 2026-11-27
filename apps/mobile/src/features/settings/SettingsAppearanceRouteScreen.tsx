import {
  useChatBackdropEnabled,
  useNewChatDashboardEnabled,
  useWebsiteIconsEnabled,
} from "../threads/useNewChatDashboard";
import { DiscordProfileSetting } from "../discord/DiscordProfileSetting";
import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SettingsScreen } from "./components/SettingsScreen";
import { CodeAppearanceSection } from "./appearance/sections/CodeAppearanceSection";
import { TerminalAppearanceSection } from "./appearance/sections/TerminalAppearanceSection";
import { TextAppearanceSection } from "./appearance/sections/TextAppearanceSection";
import { HarnessThemeSection } from "./appearance/sections/HarnessThemeSection";
import { ThemeAppearanceSection } from "./appearance/sections/ThemeAppearanceSection";
import { ChatHeaderAppearanceSection } from "./appearance/sections/ChatHeaderAppearanceSection";

import { useCasualVoiceSetting, useUiMode } from "../discord/useUiMode";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsDisclosureSection } from "./components/SettingsDisclosureSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { usePrivacySetting } from "../../state/use-privacy-mode";
import { useState } from "react";
import { BedsideScreen } from "../bedside/BedsideScreen";
import { useBedsideScreenEnabled } from "../bedside/useBedsideScreen";
import { SettingsActionRow } from "./components/SettingsActionRow";

export function SettingsAppearanceRouteScreen() {
  const insets = useSafeAreaInsets();
  const [uiMode, setUiMode] = useUiMode();
  const [casualVoice, setCasualVoice] = useCasualVoiceSetting();
  const privacy = usePrivacySetting();
  const [newChatDashboardEnabled, setNewChatDashboardEnabled] = useNewChatDashboardEnabled();
  const [chatBackdropEnabled, setChatBackdropEnabled] = useChatBackdropEnabled();
  const [websiteIconsEnabled, setWebsiteIconsEnabled] = useWebsiteIconsEnabled();
  const [bedsideEnabled, setBedsideEnabled] = useBedsideScreenEnabled();
  const [bedsidePreview, setBedsidePreview] = useState(false);

  return (
    <SettingsScreen title="Appearance">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <ThemeAppearanceSection />
        <SettingsSection title="Interface">
          <SettingsSwitchRow
            icon="square.grid.2x2"
            label="New chat dashboard"
            subtitle="Activity and usage cards over the horizon on an empty new chat."
            value={newChatDashboardEnabled}
            onValueChange={setNewChatDashboardEnabled}
          />
          <SettingsSwitchRow
            icon="sun.horizon"
            label="Chat backdrop"
            subtitle="Keep the dimmed horizon behind conversations on this device. It glows while the agent works and holds brighter while it waits on you."
            value={chatBackdropEnabled}
            onValueChange={setChatBackdropEnabled}
          />
          <SettingsSwitchRow
            icon="globe"
            label="Website icons"
            subtitle="Real site icons instead of letter tiles. Fetching them tells Google's icon service, or the site itself, which sites appear in your chats."
            value={websiteIconsEnabled}
            onValueChange={setWebsiteIconsEnabled}
          />
          <SettingsSwitchRow
            icon="moon"
            label="Bedside screen"
            subtitle="While charging, the chat list turns into a dark clock with live chat status after a minute without touches. Tap to return."
            value={bedsideEnabled}
            onValueChange={setBedsideEnabled}
          />
          <SettingsActionRow icon="play" label="Preview" onPress={() => setBedsidePreview(true)} />
          <SettingsSwitchRow
            icon="eye.slash"
            label="Screen recording privacy"
            subtitle="Mask names and paths in navigation on this device. Messages, file contents, and previews stay visible."
            value={privacy.enabled}
            disabled={!privacy.ready}
            onValueChange={privacy.setEnabled}
          />
        </SettingsSection>
        <ChatHeaderAppearanceSection />
        <TextAppearanceSection />
        <CodeAppearanceSection />
        <TerminalAppearanceSection />
        <HarnessThemeSection />
        <SettingsDisclosureSection
          title="Advanced"
          description="Experimental layouts and reply styling."
        >
          <SettingsSection title="Experimental features">
            <SettingsSwitchRow
              icon="bubble.left.and.bubble.right"
              label="Discord mode (experimental preview)"
              subtitle="Use a Discord-style layout on this device."
              value={uiMode === "discord"}
              onValueChange={(enabled) => setUiMode(enabled ? "discord" : "default")}
            />
            <DiscordProfileSetting inline />
            <SettingsSwitchRow
              icon="text.bubble"
              label="Casual voice (experimental preview)"
              subtitle="Rewrite replies in a casual style in either layout."
              value={casualVoice}
              onValueChange={setCasualVoice}
            />
          </SettingsSection>
        </SettingsDisclosureSection>
      </ScrollView>
      <BedsideScreen visible={bedsidePreview} onExit={() => setBedsidePreview(false)} />
    </SettingsScreen>
  );
}
