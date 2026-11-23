import { DISCORD_UI_THEME } from "@t3tools/shared/harnessThemes";
import { getThemeColorsForAppearance } from "@t3tools/shared/themePalettes";

import { createMobileThemeVariables, type MobileThemeAppearance } from "../../lib/mobileTheme";

export function discordMobileTheme(appearance: MobileThemeAppearance) {
  const colors = getThemeColorsForAppearance(DISCORD_UI_THEME.theme, appearance)!;
  const palette = DISCORD_UI_THEME.palettes[appearance]!;
  return {
    ...createMobileThemeVariables(colors, appearance, colors.surface, [
      colors.messageAction,
      colors.messageActionForeground,
    ]),
    "--color-header": colors.canvas,
    "--color-sheet": palette.sidebar,
    "--color-sheet-solid": palette.sidebar,
    "--color-foreground-secondary": palette.textMuted,
    "--color-foreground-muted": palette.textMuted,
    "--color-drawer-foreground-muted": palette.textMuted,
    "--color-composer-surface": palette.raised,
    "--color-glass-fallback": palette.raised,
    "--color-user-bubble": colors.canvas,
    "--color-user-bubble-foreground": colors.text,
    "--color-md-user-code-bg": palette.code,
    "--color-md-user-fence-bg": palette.code,
    "--color-md-user-code-text": colors.text,
    "--color-md-link": palette.accentText,
    "--color-danger-foreground": "#F23F43",
    "--color-danger": appearance === "dark" ? "#492f34" : "#fceced",
    "--color-danger-border": "#F23F43",
    "--color-primary-text": palette.accentText,
  };
}

export function discordSurfaces(appearance: MobileThemeAppearance) {
  return {
    rail: appearance === "dark" ? "#1E1F22" : "#E3E5E8",
    primary: appearance === "dark" ? "#F2F3F5" : "#060607",
    green: "#23A55A",
    red: "#F23F43",
    selected: appearance === "dark" ? "rgba(78,80,88,0.6)" : "rgba(116,124,138,0.24)",
  };
}
