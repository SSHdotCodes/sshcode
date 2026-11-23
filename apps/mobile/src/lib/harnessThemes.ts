import { harnessMascotAgentId } from "@t3tools/shared/harnessMascots";
import type { ServerProvider } from "@t3tools/contracts";
import {
  DEFAULT_HARNESS_THEME_SETTINGS,
  harnessThemeKeys,
  harnessThemeDriver,
  resolveHarnessThemeChoice,
  type HarnessThemePreset,
  type HarnessThemeSettings,
} from "@t3tools/shared/harnessThemes";
import { getThemeColorsForAppearance } from "@t3tools/shared/themePalettes";

import type { NativeMarkdownTextStyle } from "../native/SelectableMarkdownText.types";
import { resolveNativeMarkdownTypography } from "./appearancePreferences";
import {
  createMobileThemeVariables,
  MOBILE_THEME_IDS,
  type MobileThemeAppearance,
  type MobileThemeId,
} from "./mobileTheme";
import { getMobileUniwindThemeName } from "./mobileThemeRuntime";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";

export function resolveMobileHarnessThemeSettings(value: unknown): HarnessThemeSettings {
  if (typeof value !== "object" || value === null) return DEFAULT_HARNESS_THEME_SETTINGS;
  const stored = value as Record<string, unknown>;
  return {
    enabled: typeof stored.enabled === "boolean" ? stored.enabled : true,
    choices:
      typeof stored.choices === "object" &&
      stored.choices !== null &&
      !Array.isArray(stored.choices)
        ? Object.fromEntries(
            Object.entries(stored.choices).filter(
              (entry): entry is [string, string] => typeof entry[1] === "string",
            ),
          )
        : {},
  };
}

/** A thread's provider wins over the new-chat picker, including custom provider instances. */
export function resolveMobileHarnessDriver(input: {
  readonly thread: {
    readonly modelSelection: { readonly instanceId: string; readonly model?: string };
  } | null;
  readonly providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>;
  readonly draftDriver?: string | null;
  readonly providerInstances?: Readonly<Record<string, { readonly config?: unknown }>>;
}): string | null {
  if (!input.thread) return input.draftDriver ?? null;
  const selection = input.thread.modelSelection;
  const driver = input.providers.find(
    (provider) => provider.instanceId === selection.instanceId,
  )?.driver;
  return driver === undefined
    ? null
    : harnessThemeDriver({
        driver,
        instanceId: selection.instanceId,
        model: selection.model,
        agentId: harnessMascotAgentId(
          driver,
          input.providerInstances?.[selection.instanceId]?.config,
        ),
      });
}

/** Resolve the entire scope during render so JS and Uniwind paint the same first frame. */
export function resolveMobileHarnessTheme(
  settings: HarnessThemeSettings,
  driver: string | null,
  appearance: MobileThemeAppearance,
  platform: string,
) {
  if (driver === null) return null;
  const choice = resolveHarnessThemeChoice(settings, driver);
  if (choice.kind === "preset") {
    const { preset } = choice;
    const themeAppearance = getThemeColorsForAppearance(preset.theme, appearance)
      ? appearance
      : preset.theme.appearance;
    const colors = getThemeColorsForAppearance(preset.theme, themeAppearance)!;
    return {
      preset,
      themeId: null,
      themeAppearance,
      themeName: themeAppearance,
      themeVariables: {
        ...createMobileThemeVariables(colors, themeAppearance, colors.surface, [
          colors.messageAction,
          colors.messageActionForeground,
        ]),
        "--color-header": colors.toolbar,
        "--color-composer-surface": colors.surfaceRaised,
      },
    };
  }
  if (
    choice.kind === "theme" &&
    choice.themeId !== "material-you" &&
    (MOBILE_THEME_IDS as readonly string[]).includes(choice.themeId)
  ) {
    const themeId = choice.themeId as MobileThemeId;
    return {
      preset: null,
      themeId,
      themeAppearance: appearance,
      themeName: getMobileUniwindThemeName(themeId, appearance),
      themeVariables: getMobileThemeRuntimeVariables(themeId, appearance, platform),
    };
  }
  return null;
}

export function mobileHarnessThemeDrivers(
  providers: ReadonlyArray<
    Pick<ServerProvider, "driver" | "enabled" | "installed"> & { readonly config?: unknown }
  >,
  settings: HarnessThemeSettings,
): ReadonlyArray<string> {
  return harnessThemeKeys(providers, settings);
}

const IOS_PROSE_FONTS = {
  Georgia: { fontFamily: "Georgia", boldFontFamily: "Georgia-Bold" },
  "Avenir Next": { fontFamily: "AvenirNext-Regular", boldFontFamily: "AvenirNext-DemiBold" },
  Avenir: { fontFamily: "Avenir-Book", boldFontFamily: "Avenir-Heavy" },
} as const;

export function mobileHarnessProseStyle(
  preset: HarnessThemePreset | null,
  baseFontSize: number,
  platform: string,
): Partial<NativeMarkdownTextStyle> {
  if (!preset) return {};
  if (preset.id === "discord")
    return {
      fontFamily: "System",
      boldFontFamily: "System",
      headingFontFamily: "System",
      fontSize: 16,
      lineHeight: 22,
    };
  const comfortable = preset.view.density === "comfortable";
  const typography = resolveNativeMarkdownTypography(baseFontSize + (comfortable ? 1 : 0));
  const font = preset.fonts.prose?.flatMap((name) => {
    if (platform === "ios") {
      const mapped = IOS_PROSE_FONTS[name as keyof typeof IOS_PROSE_FONTS];
      return mapped ? [mapped] : [];
    }
    return name === "serif" ? [{ fontFamily: "serif", boldFontFamily: "serif" }] : [];
  })[0];
  return {
    ...typography,
    lineHeight: comfortable
      ? Math.max(typography.lineHeight, typography.fontSize * 1.6)
      : typography.lineHeight,
    ...(font ? { ...font, headingFontFamily: font.boldFontFamily } : {}),
  };
}
