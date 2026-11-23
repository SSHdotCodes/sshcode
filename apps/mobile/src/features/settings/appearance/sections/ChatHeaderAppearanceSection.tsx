import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

export function ChatHeaderAppearanceSection() {
  const { isReady, threadHeaderItems, setThreadHeaderItemVisible } = useAppearancePreferences();

  return (
    <SettingsSection
      title="Chat header"
      footer="Choose the shortcuts shown above each chat. Merge back appears when available."
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
        icon="point.topleft.down.curvedto.point.bottomright.up"
        label="Git controls"
        onValueChange={(visible) => setThreadHeaderItemVisible("git", visible)}
        value={threadHeaderItems.includes("git")}
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
