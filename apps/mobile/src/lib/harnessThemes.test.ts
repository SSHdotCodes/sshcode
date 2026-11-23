import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import {
  CLAUDE_HARNESS_THEME,
  CODEX_HARNESS_THEME,
  DEFAULT_HARNESS_THEME_SETTINGS,
  HARNESS_THEME_PRESETS,
  MUSE_HARNESS_THEME,
  harnessThemeChoiceFor,
} from "@t3tools/shared/harnessThemes";
import { getThemeColorsForAppearance } from "@t3tools/shared/themePalettes";

import {
  mobileHarnessProseStyle,
  mobileHarnessThemeDrivers,
  resolveMobileHarnessDriver,
  resolveMobileHarnessTheme,
  resolveMobileHarnessThemeSettings,
} from "./harnessThemes";
import { MOBILE_THEME_VARIABLE_NAMES } from "./mobileTheme";
import { getMobileThemeRuntimeVariables } from "./mobileThemeVariables";
import { createNativeComposerTheme } from "./nativeComposerTheme";

const defaults = DEFAULT_HARNESS_THEME_SETTINGS;

describe("mobile harness themes", () => {
  it("matches desktop defaults, including unknown harnesses", () => {
    expect(resolveMobileHarnessThemeSettings(undefined)).toEqual({ enabled: true, choices: {} });
    for (const preset of HARNESS_THEME_PRESETS) {
      expect(harnessThemeChoiceFor(defaults, preset.key)).toBe(`preset:${preset.id}`);
    }
    expect(harnessThemeChoiceFor(defaults, "cursor")).toBe("default");
    expect(resolveMobileHarnessTheme(defaults, "cursor", "light", "ios")).toBeNull();
    expect(resolveMobileHarnessTheme(defaults, null, "light", "ios")).toBeNull();
  });

  it("colours links so they stand apart from the text in every harness theme", () => {
    const spread = (hex: string) => {
      const channels = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
      return Math.max(...channels) - Math.min(...channels);
    };
    for (const preset of HARNESS_THEME_PRESETS) {
      for (const appearance of ["light", "dark"] as const) {
        const variables = resolveMobileHarnessTheme(defaults, preset.key, appearance, "ios")!
          .themeVariables as Record<string, string>;
        const link = variables["--color-md-link"]!;
        expect(link, `${preset.id} ${appearance}`).not.toBe(variables["--color-md-body"]);
        // A theme with white, black or grey buttons used to paint links as plain text.
        expect(spread(link), `${preset.id} ${appearance}: ${link}`).toBeGreaterThanOrEqual(40);
      }
    }
    // A theme with a coloured button keeps its own colour for links: Claude's are rust, not blue.
    const claude = resolveMobileHarnessTheme(defaults, "claudeAgent", "dark", "ios")!
      .themeVariables as Record<string, string>;
    const rust = claude["--color-md-link"]!;
    expect(Number.parseInt(rust.slice(1, 3), 16)).toBeGreaterThan(
      Number.parseInt(rust.slice(5, 7), 16) + 40,
    );
  });

  it("keeps valid device choices and ignores malformed stored fields", () => {
    expect(
      resolveMobileHarnessThemeSettings({ enabled: false, choices: { codex: "default", grok: 3 } }),
    ).toEqual({ enabled: false, choices: { codex: "default" } });
    expect(resolveMobileHarnessThemeSettings({ enabled: "yes", choices: [] })).toEqual(defaults);
    expect(resolveMobileHarnessThemeSettings(null)).toEqual(defaults);
  });

  it("looks up custom provider instances by driver and uses the picker only for drafts", () => {
    const instanceId = ProviderInstanceId.make("work-claude");
    const providers = [{ instanceId, driver: ProviderDriverKind.make("claudeAgent") }];
    expect(
      resolveMobileHarnessDriver({
        thread: { modelSelection: { instanceId } },
        providers,
        draftDriver: "codex",
      }),
    ).toBe("claudeAgent");
    expect(resolveMobileHarnessDriver({ thread: null, providers, draftDriver: "muse" })).toBe(
      "muse",
    );
    // A Claude Code chat on a model that isn't Claude keeps the user's theme.
    expect(
      resolveMobileHarnessDriver({
        thread: { modelSelection: { instanceId, model: "glm-5.3" } },
        providers,
      }),
    ).toBe("unthemed");
    expect(
      resolveMobileHarnessDriver({
        thread: { modelSelection: { instanceId: "missing" } },
        providers,
        draftDriver: "codex",
      }),
    ).toBeNull();
  });

  it.each([
    ["mistral-vibe", "acpRegistry:mistral-vibe", "mistral"],
    ["qwen", "acpRegistry:qwen", "qwen"],
    ["qwen-code", "acpRegistry:qwen", "qwen"],
    ["kimi", "acpRegistry", null],
    ["unknown", "acpRegistry", null],
  ] as const)(
    "resolves %s through its configured instance to the mobile look",
    (agentId, key, presetId) => {
      const instanceId = ProviderInstanceId.make("custom-agent");
      const driver = resolveMobileHarnessDriver({
        thread: { modelSelection: { instanceId } },
        providers: [{ instanceId, driver: ProviderDriverKind.make("acpRegistry") }],
        providerInstances: { [instanceId]: { config: { source: "registry", agentId } } },
      });
      expect(driver).toBe(key);
      expect(resolveMobileHarnessTheme(defaults, driver, "light", "ios")?.preset?.id ?? null).toBe(
        presetId,
      );
    },
  );

  it.each(HARNESS_THEME_PRESETS)(
    "maps every mobile role for $label in both appearances",
    (preset) => {
      for (const appearance of ["light", "dark"] as const) {
        const scope = resolveMobileHarnessTheme(defaults, preset.key, appearance, "ios")!;
        const colors = getThemeColorsForAppearance(preset.theme, scope.themeAppearance)!;
        const variables = scope.themeVariables;
        expect(Object.keys(variables).sort()).toEqual([...MOBILE_THEME_VARIABLE_NAMES].sort());
        expect(variables["--color-screen"]).toBe(colors.canvas);
        expect(variables["--color-header"]).toBe(colors.toolbar);
        expect(variables["--color-composer-surface"]).toBe(colors.surfaceRaised);
        expect(variables["--color-user-bubble"]).toBe(colors.messageSurface);
        expect(variables["--color-user-bubble-foreground"]).toBe(colors.messageForeground);
        expect(variables["--color-primary"]).toBe(colors.messageAction);
        expect(variables["--color-primary-foreground"]).toBe(colors.messageActionForeground);
        expect(variables["--color-prominent-action"]).toBe(colors.messageAction);
        expect(createNativeComposerTheme(variables).text).toBe(colors.text);
        expect(createNativeComposerTheme(variables).chipBackground).toMatch(/^#[\da-f]{6}$/i);
      }
    },
  );

  it("forces Grok dark on light phones, including when assigned to a different harness", () => {
    const scope = resolveMobileHarnessTheme(
      { enabled: true, choices: { codex: "preset:grok" } },
      "codex",
      "light",
      "ios",
    )!;
    expect(scope.themeAppearance).toBe("dark");
    expect(scope.themeName).toBe("dark");
    expect(scope.themeVariables["--color-screen"]).toBe("#000000");
    expect(
      resolveMobileHarnessTheme(defaults, "claudeAgent", "light", "ios")?.themeAppearance,
    ).toBe("light");
  });

  it("honors the master switch, Default, and stale choices", () => {
    expect(
      resolveMobileHarnessTheme({ ...defaults, enabled: false }, "grok", "light", "ios"),
    ).toBeNull();
    for (const choice of ["default", "preset:missing", "theme:deleted", "theme:material-you"]) {
      expect(
        resolveMobileHarnessTheme(
          { enabled: true, choices: { codex: choice } },
          "codex",
          "dark",
          "ios",
        ),
      ).toBeNull();
    }
  });

  it("lets a library theme replace a harness look without imposing its font or geometry", () => {
    const scope = resolveMobileHarnessTheme(
      { enabled: true, choices: { claudeAgent: "theme:t3-chat" } },
      "claudeAgent",
      "dark",
      "ios",
    )!;
    expect(scope.preset).toBeNull();
    expect(scope.themeName).toBe("t3-chat-dark");
    expect(scope.themeVariables).toEqual(getMobileThemeRuntimeVariables("t3-chat", "dark", "ios"));
  });

  it("deduplicates installed harnesses across environments and retains customized rows for reset", () => {
    expect(
      mobileHarnessThemeDrivers(
        [
          { driver: ProviderDriverKind.make("codex"), enabled: true, installed: true },
          { driver: ProviderDriverKind.make("codex"), enabled: true, installed: true },
          { driver: ProviderDriverKind.make("grok"), enabled: false, installed: true },
          { driver: ProviderDriverKind.make("cursor"), enabled: true, installed: false },
        ],
        { enabled: true, choices: { muse: "default" } },
      ),
    ).toEqual(["codex", "muse"]);
    expect(mobileHarnessThemeDrivers([], defaults)).toEqual(
      HARNESS_THEME_PRESETS.filter((preset) => !preset.agentIds).map((preset) => preset.key),
    );
  });

  it("lists only installed registry looks, deduplicates aliases, and retains customized missing agents", () => {
    const registry = (agentId: string, enabled = true, installed = true) => ({
      driver: ProviderDriverKind.make("acpRegistry"),
      enabled,
      installed,
      config: { source: "registry", agentId },
    });
    expect(
      mobileHarnessThemeDrivers(
        [
          registry("mistral-vibe"),
          registry("qwen"),
          registry("qwen-code"),
          registry("kimi"),
          registry("unknown"),
        ],
        defaults,
      ),
    ).toEqual(["acpRegistry:mistral-vibe", "acpRegistry:qwen"]);
    expect(
      mobileHarnessThemeDrivers(
        [registry("mistral-vibe", false), registry("qwen", true, false)],
        defaults,
      ),
    ).toEqual([]);
    expect(
      mobileHarnessThemeDrivers([registry("unknown")], {
        enabled: true,
        choices: { "acpRegistry:unknown": "theme:t3-chat", "acpRegistry:qwen": "default" },
      }),
    ).toEqual(["acpRegistry:unknown", "acpRegistry:qwen"]);
  });

  it("maps Claude and Muse prose to available iOS faces and keeps native code/interface defaults", () => {
    expect(mobileHarnessProseStyle(CLAUDE_HARNESS_THEME, 16, "ios")).toMatchObject({
      fontFamily: "Georgia",
      boldFontFamily: "Georgia-Bold",
      headingFontFamily: "Georgia-Bold",
    });
    expect(mobileHarnessProseStyle(MUSE_HARNESS_THEME, 16, "ios")).toMatchObject({
      fontFamily: "AvenirNext-Regular",
      boldFontFamily: "AvenirNext-DemiBold",
    });
    expect(mobileHarnessProseStyle(CODEX_HARNESS_THEME, 16, "ios").fontFamily).toBeUndefined();
    expect(mobileHarnessProseStyle(null, 16, "ios")).toEqual({});
    expect(mobileHarnessProseStyle(CLAUDE_HARNESS_THEME, 16, "ios").lineHeight!).toBeGreaterThan(
      mobileHarnessProseStyle(CODEX_HARNESS_THEME, 16, "ios").lineHeight!,
    );
  });
});
