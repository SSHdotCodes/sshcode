import { isProviderDriverKind } from "@t3tools/contracts";
import { HarnessMascot } from "../HarnessMascot";
import { harnessMascotForDriver } from "@t3tools/shared/harnessMascots";
import {
  DEFAULT_HARNESS_THEME_CHOICE,
  defaultHarnessThemeChoice,
  harnessLibraryThemeChoice,
  harnessPresetChoice,
  harnessThemeChoiceFor,
  harnessThemeIdentity,
  HARNESS_THEME_PRESETS,
  parseHarnessThemeChoice,
  type HarnessThemeChoice,
  type HarnessThemeSettings as HarnessThemeSettingsValue,
} from "@t3tools/shared/harnessThemes";
import { BUILT_IN_THEMES } from "@t3tools/shared/themePalettes";
import { useCallback, useMemo } from "react";

import { useCustomThemes } from "../../hooks/useCustomThemes";
import { useEnvironmentThemeDefinitions } from "../../hooks/useEnvironmentTheme";
import { useHarnessThemeSettings, useTheme } from "../../hooks/useTheme";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  getThemeColorsForMode,
  getThemeDefinition,
  resolveDefinitionAppearance,
  type ThemeAppearance,
  type ThemeDefinition,
} from "../../themePalette";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { harnessThemeRows } from "./HarnessThemeSettings.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";

type ThemeOption = Readonly<{ choice: HarnessThemeChoice; definition: ThemeDefinition }>;

/** The canvas with a dot of the send-button color, in the appearance on screen. */
function HarnessThemeSwatch({
  definition,
  appearance,
}: {
  definition: ThemeDefinition | null;
  appearance: ThemeAppearance;
}) {
  const colors = definition
    ? getThemeColorsForMode(definition, resolveDefinitionAppearance(definition, appearance))
    : null;
  return (
    <span
      aria-hidden
      className="flex size-4 shrink-0 items-center justify-center rounded-full border border-border bg-background"
      style={colors ? { backgroundColor: colors.canvas } : undefined}
    >
      <span
        className="size-1.5 rounded-full bg-primary"
        style={colors ? { backgroundColor: colors.messageAction } : undefined}
      />
    </span>
  );
}

function HarnessThemeOptionLabel({
  label,
  hint,
  definition,
  appearance,
}: {
  label: string;
  hint?: string | undefined;
  definition: ThemeDefinition | null;
  appearance: ThemeAppearance;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <HarnessThemeSwatch appearance={appearance} definition={definition} />
      <span className="truncate">{label}</span>
      {hint ? <span className="shrink-0 text-muted-foreground">{hint}</span> : null}
    </span>
  );
}

/**
 * Settings → Appearance → Harness themes: which look each harness's chats
 * wear. Client-local, beside the theme it overrides (see useTheme).
 */
export function HarnessThemeSettings() {
  const { settings, updateSettings } = useHarnessThemeSettings();
  const { resolvedTheme } = useTheme();
  const { connectedEnvironments } = useSettingsScope();
  const environmentThemes = useEnvironmentThemeDefinitions();
  const customThemes = useCustomThemes();
  const rows = useMemo(
    () =>
      harnessThemeRows(
        connectedEnvironments.flatMap((environment) =>
          (environment.serverConfig?.providers ?? []).map((provider) => ({
            ...provider,
            config:
              environment.serverConfig?.settings.providerInstances[provider.instanceId]?.config,
          })),
        ),
        settings,
      ),
    [connectedEnvironments, settings],
  );

  // The theme library in its own order. A saved theme shadows a published
  // one with the same id, exactly as theme resolution does.
  const libraryThemes = useMemo<ReadonlyArray<ThemeOption>>(
    () =>
      [
        ...BUILT_IN_THEMES,
        ...environmentThemes.filter(
          (environmentTheme) => !customThemes.some((theme) => theme.id === environmentTheme.id),
        ),
        ...customThemes,
      ].map((definition) => ({ choice: harnessLibraryThemeChoice(definition.id), definition })),
    [customThemes, environmentThemes],
  );

  const save = useCallback(
    (update: (current: HarnessThemeSettingsValue) => HarnessThemeSettingsValue) => {
      if (updateSettings(update)) return;
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn’t save harness themes",
          description: "Try again.",
        }),
      );
    },
    [updateSettings],
  );

  const setChoice = (driver: string, choice: HarnessThemeChoice) =>
    save((current) => {
      const { [driver]: _previous, ...choices } = current.choices;
      // Only departures from the default are stored, so a preset added later
      // still reaches harnesses the user never touched.
      return choice === defaultHarnessThemeChoice(driver)
        ? { ...current, choices }
        : { ...current, choices: { ...choices, [driver]: choice } };
    });

  const describeChoice = (choice: HarnessThemeChoice) => {
    const parsed = parseHarnessThemeChoice(choice);
    switch (parsed.kind) {
      case "default":
        return { label: "Default", hint: "your theme", definition: null };
      case "preset":
        return {
          label: parsed.preset.label,
          hint: parsed.preset.theme.variants ? undefined : "dark only",
          definition: parsed.preset.theme,
        };
      case "theme": {
        const definition = getThemeDefinition(parsed.themeId);
        return definition
          ? { label: definition.label, hint: undefined, definition }
          : { label: "Missing theme", hint: "uses default", definition: null };
      }
    }
  };

  return (
    <SettingsSection {...searchableSetting("harness-themes")}>
      <SettingsRow
        title="Use harness themes"
        description="While a chat is open, the app takes on the look of the harness running it."
        control={
          <Switch
            aria-label="Use harness themes"
            checked={settings.enabled}
            onCheckedChange={(checked) =>
              save((current) => ({ ...current, enabled: Boolean(checked) }))
            }
          />
        }
      />
      {rows.map(({ driver, label }) => {
        const identity = harnessThemeIdentity(driver);
        const choice = harnessThemeChoiceFor(settings, driver);
        const selected = describeChoice(choice);
        return (
          <SettingsRow
            key={driver}
            title={
              <span className="flex items-center gap-2">
                {harnessMascotForDriver(identity.driver, identity.agentId) ? (
                  <HarnessMascot {...identity} still size={24} />
                ) : isProviderDriverKind(identity.driver) ? (
                  <ProviderInstanceIcon
                    driverKind={identity.driver}
                    displayName={label}
                    iconClassName="size-4"
                  />
                ) : null}
                {label}
              </span>
            }
            resetAction={
              choice !== defaultHarnessThemeChoice(driver) ? (
                <SettingResetButton
                  label={`${label} theme`}
                  onClick={() => setChoice(driver, defaultHarnessThemeChoice(driver))}
                />
              ) : null
            }
            control={
              <Select
                disabled={!settings.enabled}
                value={choice}
                onValueChange={(value) => {
                  if (typeof value === "string") setChoice(driver, value);
                }}
              >
                <SelectTrigger aria-label={`${label} theme`} className="w-full sm:w-52" size="sm">
                  <HarnessThemeOptionLabel appearance={resolvedTheme} {...selected} />
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value={DEFAULT_HARNESS_THEME_CHOICE}>
                    <HarnessThemeOptionLabel
                      appearance={resolvedTheme}
                      {...describeChoice(DEFAULT_HARNESS_THEME_CHOICE)}
                    />
                  </SelectItem>
                  <SelectGroup>
                    <SelectGroupLabel>Harness looks</SelectGroupLabel>
                    {HARNESS_THEME_PRESETS.map((preset) => (
                      <SelectItem key={preset.id} value={harnessPresetChoice(preset.id)}>
                        <HarnessThemeOptionLabel
                          appearance={resolvedTheme}
                          {...describeChoice(harnessPresetChoice(preset.id))}
                        />
                      </SelectItem>
                    ))}
                  </SelectGroup>
                  <SelectGroup>
                    <SelectGroupLabel>Your themes</SelectGroupLabel>
                    {libraryThemes.map(({ choice: themeChoice, definition }) => (
                      <SelectItem key={themeChoice} value={themeChoice}>
                        <HarnessThemeOptionLabel
                          appearance={resolvedTheme}
                          definition={definition}
                          label={definition.label}
                        />
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectPopup>
              </Select>
            }
          />
        );
      })}
    </SettingsSection>
  );
}
