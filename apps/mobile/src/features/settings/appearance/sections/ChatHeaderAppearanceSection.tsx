import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

export function ChatHeaderAppearanceSection() {
  const { isReady, threadHeaderItems, setThreadHeaderItemVisible } = useAppearancePreferences();

  return (
    <SettingsSection
      title="Chat header"
      footer="Choose the shortcuts shown above each chat. Merge back and pinned messages appear when a chat has them."
    >
      <SettingsSwitchRow
        disabled={!isReady}
        icon="bubble.left.and.bubble.right"
        label="Side chat"
        onValueChange={(visible) => setThreadHeaderItemVisible("sideChat", visible)}
        value={threadHeaderItems.includes("sideChat")}
      />
      <SettingsSwitchRow
        disabled={!isReady}
        icon="folder"
        label="Files"
        onValueChange={(visible) => setThreadHeaderItemVisible("files", visible)}
        value={threadHeaderItems.includes("files")}
      />
      <SettingsSwitchRow
        disabled={!isReady}
        icon="terminal"
        label="Terminal"
        onValueChange={(visible) => setThreadHeaderItemVisible("terminal", visible)}
        value={threadHeaderItems.includes("terminal")}
      />
    </SettingsSection>
  );
}
