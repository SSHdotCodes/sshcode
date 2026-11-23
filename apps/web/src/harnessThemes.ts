/**
 * Web side of harness themes (`@t3tools/shared/harnessThemes`): which look a
 * focused chat wears, how a preset's fonts and view flags reach CSS, and the
 * client-local settings that pick a look per harness.
 *
 * The palette itself goes through the regular theme path (`applyThemeColors`),
 * so a harness look is just another theme to every consumer; only the
 * typography and transcript shape need the extra hooks below, which
 * `index.css` reads under `html[data-harness-theme]`.
 */
import {
  DEFAULT_HARNESS_THEME_SETTINGS,
  DISCORD_UI_THEME,
  harnessThemeColors,
  HarnessThemeSettings,
  resolveHarnessThemeChoice,
  type HarnessThemeFontStack,
  type HarnessThemePreset,
} from "@t3tools/shared/harnessThemes";
import * as Schema from "effect/Schema";

import {
  cssFontFamilies,
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
} from "./appearanceFonts";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "./hooks/useLocalStorage";
import { getThemeColorsForMode, type ThemeAppearance, type ThemeDefinition } from "./themePalette";

export const HARNESS_THEMES_STORAGE_KEY = "t3code:harness-themes:v1";
/** Read by the boot script in index.html; keep the key and fields in sync. */
export const HARNESS_THEME_BOOT_STORAGE_KEY = "t3code:harness-theme-boot:v1";

/** The look a focused chat wears over the user's own theme. */
export type ActiveHarnessTheme = Readonly<{
  /** Stable identity for change detection: `preset:<id>` or `theme:<id>`. */
  key: string;
  definition: ThemeDefinition;
  /** Set for built-in presets, which also bring fonts and view flags. */
  preset: HarnessThemePreset | null;
}>;

/**
 * The harness look for a chat, or null to keep the user's theme: no focused
 * chat, harness themes off, a harness left on Default, or a library theme
 * that no longer resolves (deleted, or not yet streamed in).
 */
export function resolveActiveHarnessTheme(input: {
  readonly driver: string | null;
  readonly settings: HarnessThemeSettings;
  readonly getThemeDefinition: (themeId: string) => ThemeDefinition | null;
}): ActiveHarnessTheme | null {
  if (input.driver === null) return null;
  const choice = resolveHarnessThemeChoice(input.settings, input.driver);
  switch (choice.kind) {
    case "default":
      return null;
    case "preset":
      return {
        key: `preset:${choice.preset.id}`,
        definition: choice.preset.theme,
        preset: choice.preset,
      };
    case "theme": {
      const definition = input.getThemeDefinition(choice.themeId);
      return definition ? { key: `theme:${definition.id}`, definition, preset: null } : null;
    }
  }
}

export function readHarnessThemeSettings(): HarnessThemeSettings {
  try {
    return (
      getLocalStorageItem(HARNESS_THEMES_STORAGE_KEY, HarnessThemeSettings) ??
      DEFAULT_HARNESS_THEME_SETTINGS
    );
  } catch {
    // An unreadable or corrupt save falls back to the defaults rather than
    // leaving chats unthemed; the next write replaces it.
    return DEFAULT_HARNESS_THEME_SETTINGS;
  }
}

export function writeHarnessThemeSettings(settings: HarnessThemeSettings): void {
  setLocalStorageItem(HARNESS_THEMES_STORAGE_KEY, settings, HarnessThemeSettings);
}

/** A preset font role as a CSS stack, or null to leave the app's own stack alone. */
function harnessFontStack(stack: HarnessThemeFontStack, fallback: string): string | null {
  const families = stack === null ? null : cssFontFamilies(stack.join(","));
  // The stock stack still follows, so glyph coverage never regresses.
  return families === null ? null : `${families}, ${fallback}`;
}

/** What a preset sets on the document root beyond its palette. */
export type HarnessThemeView = Readonly<{
  dataset: Readonly<Record<string, string>>;
  properties: Readonly<Record<string, string>>;
}>;

const HARNESS_VIEW_DATASET_KEYS = [
  "harnessTheme",
  "harnessDensity",
  "harnessFontInterface",
  "harnessFontProse",
  "harnessFontCode",
] as const;

const HARNESS_VIEW_PROPERTIES = [
  "--harness-font-interface",
  "--harness-font-prose",
  "--harness-font-code",
  "--harness-user-bubble-radius",
  "--harness-user-bubble-padding-x",
  "--harness-user-bubble-padding-y",
] as const;

/**
 * A preset's fonts and view flags as root attributes and custom properties.
 * Font roles left to the platform are omitted, so the user's own font
 * choices (inline `--font-*` overrides) keep winning there.
 */
export function harnessThemeView(preset: HarnessThemePreset): HarnessThemeView {
  const dataset: Record<string, string> = {
    harnessTheme: preset.id,
    harnessDensity: preset.view.density,
  };
  const { radius, paddingX, paddingY } = preset.view.userBubble;
  const properties: Record<string, string> = {
    "--harness-user-bubble-radius": `${radius}px`,
    "--harness-user-bubble-padding-x": `${paddingX}px`,
    "--harness-user-bubble-padding-y": `${paddingY}px`,
  };
  const fonts = [
    ["Interface", "--harness-font-interface", preset.fonts.interface, DEFAULT_SANS_FONT_STACK],
    ["Prose", "--harness-font-prose", preset.fonts.prose, "var(--font-sans)"],
    ["Code", "--harness-font-code", preset.fonts.code, DEFAULT_CODE_FONT_STACK],
  ] as const;
  for (const [role, property, stack, fallback] of fonts) {
    const value = harnessFontStack(stack, fallback);
    if (value === null) continue;
    dataset[`harnessFont${role}`] = "";
    properties[property] = value;
  }
  return { dataset, properties };
}

/** Paint a preset's view onto the root, or clear it when the look has none. */
export function applyHarnessThemeView(root: HTMLElement, preset: HarnessThemePreset | null): void {
  if (!root?.style) return;
  const view = preset ? harnessThemeView(preset) : null;
  for (const key of HARNESS_VIEW_DATASET_KEYS) {
    const value = view?.dataset[key];
    if (value === undefined) delete root.dataset[key];
    else root.dataset[key] = value;
  }
  for (const property of HARNESS_VIEW_PROPERTIES) {
    const value = view?.properties[property];
    if (value === undefined) root.style.removeProperty(property);
    else root.style.setProperty(property, value);
  }
}

/**
 * The chat that wore a harness look when the page went away. Reopening the
 * same path paints that look from the boot splash on, instead of the user's
 * own theme until the chat mounts. Colors are resolved here so the boot
 * script needs no copy of any palette.
 */
const HarnessThemeBootHint = Schema.Struct({
  /** See harnessThemeBootRoute. */
  route: Schema.String,
  driver: Schema.String,
  dark: Schema.Boolean,
  background: Schema.String,
  foreground: Schema.String,
  accent: Schema.String,
  chrome: Schema.String,
});
export type HarnessThemeBootHint = typeof HarnessThemeBootHint.Type;

/** The chat a page shows: the hash carries the route in the desktop app, the path elsewhere. */
export function harnessThemeBootRoute(location: Pick<Location, "pathname" | "hash">): string {
  return `${location.pathname}${location.hash}`;
}

export function harnessThemeBootHint(input: {
  readonly route: string;
  readonly driver: string;
  readonly harnessTheme: ActiveHarnessTheme;
  readonly appearance: ThemeAppearance;
}): HarnessThemeBootHint {
  const { definition } = input.harnessTheme;
  const colors = getThemeColorsForMode(definition, input.appearance) ?? definition.colors;
  return {
    route: input.route,
    driver: input.driver,
    dark: input.appearance === "dark",
    background: colors.canvas,
    foreground: colors.text,
    accent: colors.messageAction,
    chrome: colors.chrome,
  };
}

/** The harness to restore for a page opened on `route`, if it closed on a themed chat there. */
export function readHarnessThemeBootDriver(route: string): string | null {
  try {
    const hint = getLocalStorageItem(HARNESS_THEME_BOOT_STORAGE_KEY, HarnessThemeBootHint);
    return hint?.route === route ? hint.driver : null;
  } catch {
    return null;
  }
}

export function writeHarnessThemeBootHint(hint: HarnessThemeBootHint | null): void {
  try {
    if (hint === null) removeLocalStorageItem(HARNESS_THEME_BOOT_STORAGE_KEY);
    else setLocalStorageItem(HARNESS_THEME_BOOT_STORAGE_KEY, hint, HarnessThemeBootHint);
  } catch {
    // Only costs the next launch a frame or two of the user's own theme.
  }
}

/** Web and desktop Discord mode is always midnight; normal and native palettes stay unchanged. */
const discordMidnightPalette = {
  ...DISCORD_UI_THEME.palettes.dark!,
  canvas: "#17181c",
  sidebar: "#111214",
  surface: "#1b1c21",
  raised: "#232428",
  overlay: "#101114",
  text: "#e0e2e7",
  textMuted: "#aaafb9",
  border: "#303239",
  input: "#303239",
  control: "#17181c",
  fill: "#25262c",
  fillStrong: "#34363f",
  sidebarHover: "#202127",
  sidebarSelected: "#2a2c34",
  bubble: "#232428",
  bubbleForeground: "#e0e2e7",
  code: "#111214",
};
export const DISCORD_WEB_THEME = {
  ...DISCORD_UI_THEME,
  palettes: { dark: discordMidnightPalette },
  theme: {
    id: DISCORD_UI_THEME.theme.id,
    label: DISCORD_UI_THEME.label,
    appearance: "dark" as const,
    colors: harnessThemeColors(discordMidnightPalette, "dark"),
  },
};
