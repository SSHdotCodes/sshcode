import { HarnessMascot } from "../../../../components/HarnessMascot";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { PROVIDER_DISPLAY_NAMES, isProviderDriverKind } from "@t3tools/contracts";
import {
  DEFAULT_HARNESS_THEME_SETTINGS,
  HARNESS_THEME_PRESETS,
  harnessLibraryThemeChoice,
  harnessPresetChoice,
  harnessThemeChoiceFor,
  harnessThemeIdentity,
} from "@t3tools/shared/harnessThemes";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { ControlPillMenu } from "../../../../components/ControlPill";
import { ListRow } from "../../../../components/ListRow";
import {
  mobileHarnessThemeDrivers,
  resolveMobileHarnessThemeSettings,
} from "../../../../lib/harnessThemes";
import { MOBILE_THEME_OPTIONS } from "../../../../lib/mobileTheme";
import { useEnvironments } from "../../../../state/environments";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { SettingsActionRow } from "../../components/SettingsActionRow";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";

const CHOICES = [
  { id: "default", label: "Default" },
  ...HARNESS_THEME_PRESETS.map((preset) => ({
    id: harnessPresetChoice(preset.id),
    label: preset.label,
  })),
  ...MOBILE_THEME_OPTIONS.filter((theme) => theme.id !== "material-you").map((theme) => ({
    id: harnessLibraryThemeChoice(theme.id),
    label: theme.label,
  })),
];

export function HarnessThemeSection() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const { environments } = useEnvironments();
  const ready = AsyncResult.isSuccess(preferences);
  const settings = resolveMobileHarnessThemeSettings(
    ready ? preferences.value.harnessThemes : undefined,
  );
  const providers = environments.flatMap((environment) =>
    (environment.serverConfig?.providers ?? []).map((provider) => ({
      ...provider,
      config: environment.serverConfig?.settings.providerInstances[provider.instanceId]?.config,
    })),
  );
  const drivers = mobileHarnessThemeDrivers(providers, settings);
  const update = (transform: (current: typeof settings) => typeof settings) =>
    save({
      transform: (current) => ({
        harnessThemes: transform(resolveMobileHarnessThemeSettings(current.harnessThemes)),
      }),
    });

  return (
    <SettingsSection
      title="Harness themes"
      footer="Chats use their harness’s colors and layout. Default follows your app theme. Choices are saved on this device."
    >
      <SettingsSwitchRow
        icon="paintbrush"
        label="Use harness themes"
        value={settings.enabled}
        disabled={!ready}
        onValueChange={(enabled) => update((current) => ({ ...current, enabled }))}
      />
      {drivers.map((driver) => {
        const choice = harnessThemeChoiceFor(settings, driver);
        const identity = harnessThemeIdentity(driver);
        const preset = HARNESS_THEME_PRESETS.find((candidate) => candidate.key === driver);
        const label =
          preset?.agentLabel ??
          identity.agentId ??
          (isProviderDriverKind(identity.driver)
            ? (PROVIDER_DISPLAY_NAMES[identity.driver] ?? identity.driver)
            : identity.driver);
        const disabled = !ready || !settings.enabled;
        return (
          <View key={driver} className="border-t border-border-subtle">
            <ControlPillMenu
              title={label}
              actions={[
                ...CHOICES.map((option) => ({
                  id: option.id,
                  title: option.label,
                  state: choice === option.id ? ("on" as const) : ("off" as const),
                  attributes: { disabled },
                })),
                { id: "reset", title: "Reset to harness default", attributes: { disabled } },
              ]}
              onPressAction={({ nativeEvent }) =>
                update((current) => {
                  const choices = { ...current.choices };
                  if (nativeEvent.event === "reset") delete choices[driver];
                  else choices[driver] = nativeEvent.event;
                  return { ...current, choices };
                })
              }
            >
              <ListRow
                label={label}
                leading={
                  <View className="size-6 items-center justify-center">
                    <HarnessMascot {...identity} still size={22} />
                  </View>
                }
                detail={CHOICES.find((option) => option.id === choice)?.label ?? "Default"}
                disabled={disabled}
                onPress={() => undefined}
              />
            </ControlPillMenu>
          </View>
        );
      })}
      <View className="border-t border-border-subtle">
        <SettingsActionRow
          icon="arrow.clockwise"
          label="Reset harness themes"
          disabled={!ready || (settings.enabled && Object.keys(settings.choices).length === 0)}
          onPress={() => update(() => DEFAULT_HARNESS_THEME_SETTINGS)}
        />
      </View>
    </SettingsSection>
  );
}
