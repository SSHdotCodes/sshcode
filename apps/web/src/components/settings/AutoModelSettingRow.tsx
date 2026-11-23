import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** The same switch as the small Auto chip in the composer's model picker. */
export function AutoModelSettingRow() {
  const enabled = useClientSettings((settings) => settings.autoModelEnabled);
  const updateClientSettings = useUpdateClientSettings();
  return (
    <>
      <SettingsRow
        {...searchableSetting("auto-model")}
        description="On a new chat's first message, offer a faster model for a simple task or a stronger one for a hard task. One click applies it; the model never changes by itself. Also the Auto chip in the model picker."
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => {
              void updateClientSettings({ autoModelEnabled: Boolean(checked) }).catch(
                () => undefined,
              );
            }}
            aria-label="Auto model suggestions"
          />
        }
      />
      {enabled ? <AutoModelDecisionRow /> : null}
    </>
  );
}

/** Whether the server may ask an outside decision model about a first message. */
function AutoModelDecisionRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      {...searchableSetting("auto-model-decision")}
      description="Auto also asks a decision model on OpenRouter about the first message you type, with zero data retention, and weighs its answer with the model on this Mac. Needs an OpenRouter key saved for all sessions. Off: nothing you type leaves this Mac for Auto."
      settingKeys={["autoModelDecision"]}
      control={
        <ScopedSwitch
          settingKeys={["autoModelDecision"]}
          checked={settings.autoModelDecision}
          onCheckedChange={(checked) => updateSettings({ autoModelDecision: Boolean(checked) })}
          aria-label="Ask a decision model"
        />
      }
    />
  );
}
