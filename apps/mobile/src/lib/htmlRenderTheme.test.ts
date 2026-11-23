import { DEFAULT_HARNESS_THEME_SETTINGS } from "@t3tools/shared/harnessThemes";
import { resolveMobileHarnessTheme } from "./harnessThemes";
import { describe, expect, it } from "vite-plus/test";

import { mobileHtmlRenderTheme } from "./htmlRenderTheme";
import { getMobileThemeVariables } from "./mobileTheme";

describe("mobileHtmlRenderTheme", () => {
  it("uses the harness palette inside inline renders, including Grok on light phones", () => {
    for (const driver of ["codex", "claudeAgent", "grok", "muse"]) {
      const scope = resolveMobileHarnessTheme(
        DEFAULT_HARNESS_THEME_SETTINGS,
        driver,
        "light",
        "ios",
      )!;
      const theme = mobileHtmlRenderTheme({
        themeId: "t3-code",
        appearance: scope.themeAppearance,
        variables: scope.themeVariables,
        harnessPreset: scope.preset,
        systemColors: false,
        platform: "ios",
      });
      expect(theme.variables["--background"]).toBe(scope.themeVariables["--color-screen"]);
      expect(theme.variables["--foreground"]).toBe(scope.themeVariables["--color-foreground"]);
      expect(theme.variables["--primary"]).toBe(scope.themeVariables["--color-primary"]);
      expect(theme.variables["--card"]).toBe(scope.themeVariables["--color-card"]);
    }
  });
  it("paints the page with the feed's own canvas", () => {
    const variables = {
      ...getMobileThemeVariables("grove", "dark"),
      "--color-thread-canvas": "#101010",
    };
    const theme = (platform: string) =>
      mobileHtmlRenderTheme({
        themeId: "grove",
        appearance: "dark",
        variables,
        systemColors: false,
        platform,
      });
    expect(theme("android").variables["--background"]).toBe("#101010");
    expect(theme("ios").variables["--background"]).toBe(variables["--color-screen"]);
  });

  it("takes Material You's system roles over the default palette", () => {
    const variables = {
      ...getMobileThemeVariables("t3-code", "light"),
      "--color-primary": "#6750A4FF",
      "--color-foreground": "#1D1B20FF",
    };
    const theme = mobileHtmlRenderTheme({
      themeId: "material-you",
      appearance: "light",
      variables,
      systemColors: true,
      platform: "android",
    });
    expect(theme.variables["--accent"]).toBe("#6750A4FF");
    expect(theme.variables["--foreground"]).toBe("#1D1B20FF");
  });
});
