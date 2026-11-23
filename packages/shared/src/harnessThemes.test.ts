import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_HARNESS_THEME,
  CODEX_HARNESS_THEME,
  DEFAULT_HARNESS_THEME_SETTINGS,
  GROK_HARNESS_THEME,
  HARNESS_THEME_PRESETS,
  HARNESS_THEME_PRESET_IDS,
  HarnessThemeSettings,
  MUSE_HARNESS_THEME,
  MISTRAL_HARNESS_THEME,
  QWEN_HARNESS_THEME,
  defaultHarnessThemeChoice,
  harnessLibraryThemeChoice,
  harnessPresetChoice,
  harnessThemeColors,
  harnessMascotIdentity,
  harnessThemeDriver,
  parseHarnessThemeChoice,
  resolveHarnessThemeChoice,
  type HarnessThemePalette,
  UNTHEMED_HARNESS,
} from "./harnessThemes.ts";
import { THEME_COLOR_ROLES, type ThemeAppearance } from "./themePalettes.ts";

const decodeHarnessThemeSettings = Schema.decodeSync(HarnessThemeSettings);

function luminance(hex: string): number {
  const channels = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)!.slice(1);
  const [r, g, b] = channels.map((channel) => {
    const value = Number.parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

function contrast(first: string, second: string): number {
  const [lighter, darker] = [luminance(first), luminance(second)].toSorted((a, b) => b - a);
  return (lighter! + 0.05) / (darker! + 0.05);
}

const palettes = HARNESS_THEME_PRESETS.flatMap((preset) =>
  Object.entries(preset.palettes).map(
    ([appearance, palette]) =>
      [`${preset.label} ${appearance}`, palette, appearance as ThemeAppearance] as const,
  ),
);

describe("harness theme presets", () => {
  it("covers six looks with stable driver or registry agent keys", () => {
    expect(HARNESS_THEME_PRESETS.map((preset) => [preset.id, preset.key])).toEqual([
      ["codex", "codex"],
      ["claude", "claudeAgent"],
      ["grok", "grok"],
      ["muse", "muse"],
      ["mistral", "acpRegistry:mistral-vibe"],
      ["qwen", "acpRegistry:qwen"],
    ]);
    expect(HARNESS_THEME_PRESETS.map((preset) => preset.id)).toEqual(HARNESS_THEME_PRESET_IDS);
  });

  it("ships light and dark where the app has both, and Grok dark only", () => {
    for (const preset of [
      CODEX_HARNESS_THEME,
      CLAUDE_HARNESS_THEME,
      MUSE_HARNESS_THEME,
      MISTRAL_HARNESS_THEME,
      QWEN_HARNESS_THEME,
    ]) {
      expect(preset.theme.appearance).toBe("light");
      expect(preset.theme.variants?.dark).toBeDefined();
    }
    expect(GROK_HARNESS_THEME.theme.appearance).toBe("dark");
    expect(GROK_HARNESS_THEME.theme.variants).toBeUndefined();
    expect(GROK_HARNESS_THEME.theme.colors.canvas).toBe("#000000");
  });

  it("expands every palette to every product color role", () => {
    for (const preset of HARNESS_THEME_PRESETS) {
      const variants = [preset.theme.colors, ...Object.values(preset.theme.variants ?? {})];
      for (const colors of variants) {
        expect(Object.keys(colors).toSorted()).toEqual([...THEME_COLOR_ROLES].toSorted());
        for (const color of Object.values(colors)) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("maps the bubble, send button and canvas onto the roles the app paints", () => {
    const light = CLAUDE_HARNESS_THEME.palettes.light!;
    const colors = harnessThemeColors(light, "light");
    expect(colors).toMatchObject({
      canvas: light.canvas,
      chrome: light.canvas,
      toolbar: light.canvas,
      messageSurface: light.bubble,
      messageForeground: light.bubbleForeground,
      messageAction: light.action,
      messageActionForeground: light.actionForeground,
      focus: light.accent,
      sidebar: light.sidebar,
    });
    // Status colors stay standard; only their surfaces sit on the canvas.
    expect(colors.error).toBe("#fb2c36");
    expect(colors.errorSurface).not.toBe(colors.error);
  });

  it.each(palettes)("%s keeps readable contrast", (_label, palette: HarnessThemePalette) => {
    const pairs: ReadonlyArray<readonly [keyof HarnessThemePalette, keyof HarnessThemePalette]> = [
      ["text", "canvas"],
      ["text", "sidebar"],
      ["text", "raised"],
      ["text", "overlay"],
      ["text", "code"],
      ["textMuted", "canvas"],
      ["textMuted", "sidebar"],
      ["textMuted", "raised"],
      ["bubbleForeground", "bubble"],
      ["actionForeground", "action"],
      ["accentForeground", "accent"],
      ["accentText", "canvas"],
    ];
    for (const [foreground, background] of pairs) {
      expect(
        contrast(palette[foreground], palette[background]),
        `${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("sets Claude's replies in a serif and leaves the others on the platform face", () => {
    expect(CLAUDE_HARNESS_THEME.fonts.prose?.at(-1)).toBe("serif");
    expect(CODEX_HARNESS_THEME.fonts).toEqual({ interface: null, prose: null, code: null });
    expect(GROK_HARNESS_THEME.fonts.prose).toBeNull();
    expect(CODEX_HARNESS_THEME.view.density).toBe("compact");
  });
});

describe("harness theme settings", () => {
  it("defaults each preset's harness to it and every other harness to the user's theme", () => {
    expect(DEFAULT_HARNESS_THEME_SETTINGS).toEqual({ enabled: true, choices: {} });
    expect(defaultHarnessThemeChoice("codex")).toBe("preset:codex");
    expect(defaultHarnessThemeChoice("claudeAgent")).toBe("preset:claude");
    expect(defaultHarnessThemeChoice("grok")).toBe("preset:grok");
    expect(defaultHarnessThemeChoice("muse")).toBe("preset:muse");
    expect(defaultHarnessThemeChoice("opencode")).toBe("default");
    expect(defaultHarnessThemeChoice("cursor")).toBe("default");
  });

  it.each([
    ["mistral-vibe", "acpRegistry:mistral-vibe", MISTRAL_HARNESS_THEME],
    ["qwen", "acpRegistry:qwen", QWEN_HARNESS_THEME],
    ["qwen-code", "acpRegistry:qwen", QWEN_HARNESS_THEME],
  ] as const)("resolves a %s chat to its own default look", (agentId, key, preset) => {
    const driver = harnessThemeDriver({ driver: "acpRegistry", agentId });
    expect(driver).toBe(key);
    expect(resolveHarnessThemeChoice(DEFAULT_HARNESS_THEME_SETTINGS, driver)).toEqual({
      kind: "preset",
      preset,
    });
    expect(
      resolveHarnessThemeChoice({ enabled: true, choices: { [key]: "default" } }, driver),
    ).toEqual({ kind: "default" });
    expect(
      resolveHarnessThemeChoice({ enabled: true, choices: { [key]: "theme:grove" } }, driver),
    ).toEqual({ kind: "theme", themeId: "grove" });
  });

  it.each(["kimi", "kimi-code", "hermes", "unknown", null, undefined])(
    "keeps the user's theme for registry agent %s",
    (agentId) => {
      const driver = harnessThemeDriver({ driver: "acpRegistry", agentId, model: "qwen3-coder" });
      expect(driver).toBe("acpRegistry");
      expect(resolveHarnessThemeChoice(DEFAULT_HARNESS_THEME_SETTINGS, driver)).toEqual({
        kind: "default",
      });
    },
  );

  it("keeps decoding and resolving stored choices for the original four drivers", () => {
    const choices = {
      codex: "theme:grove",
      claudeAgent: "default",
      grok: "preset:claude",
      muse: "preset:muse",
    };
    const settings = decodeHarnessThemeSettings({ choices });
    expect(settings.choices).toEqual(choices);
    expect(resolveHarnessThemeChoice(settings, "codex")).toEqual({
      kind: "theme",
      themeId: "grove",
    });
    expect(resolveHarnessThemeChoice(settings, "claudeAgent")).toEqual({ kind: "default" });
    expect(resolveHarnessThemeChoice(settings, "grok")).toEqual({
      kind: "preset",
      preset: CLAUDE_HARNESS_THEME,
    });
    expect(resolveHarnessThemeChoice(settings, "muse")).toEqual({
      kind: "preset",
      preset: MUSE_HARNESS_THEME,
    });
  });

  it("decodes partial and empty saves onto the defaults", () => {
    const decode = Schema.decodeUnknownSync(HarnessThemeSettings);
    expect(decode({})).toEqual(DEFAULT_HARNESS_THEME_SETTINGS);
    expect(decode({ enabled: false })).toEqual({ enabled: false, choices: {} });
    expect(decode({ choices: { codex: "theme:grove" } })).toEqual({
      enabled: true,
      choices: { codex: "theme:grove" },
    });
  });

  it("resolves a harness's choice, honoring overrides and the master switch", () => {
    const settings = {
      enabled: true,
      choices: { codex: harnessLibraryThemeChoice("grove"), claudeAgent: "default" },
    };
    expect(resolveHarnessThemeChoice(settings, "codex")).toEqual({
      kind: "theme",
      themeId: "grove",
    });
    expect(resolveHarnessThemeChoice(settings, "claudeAgent")).toEqual({ kind: "default" });
    expect(resolveHarnessThemeChoice(settings, "grok")).toEqual({
      kind: "preset",
      preset: GROK_HARNESS_THEME,
    });
    expect(resolveHarnessThemeChoice({ ...settings, enabled: false }, "grok")).toEqual({
      kind: "default",
    });
  });

  it("reads unknown and malformed choices as the default", () => {
    expect(parseHarnessThemeChoice(harnessPresetChoice("muse"))).toEqual({
      kind: "preset",
      preset: MUSE_HARNESS_THEME,
    });
    expect(parseHarnessThemeChoice("preset:vscode")).toEqual({ kind: "default" });
    expect(parseHarnessThemeChoice("theme:")).toEqual({ kind: "default" });
    expect(parseHarnessThemeChoice("grove")).toEqual({ kind: "default" });
  });
});

describe("harnessThemeDriver", () => {
  const claude = "claudeAgent";

  it("gives Claude Code on Claude models the Claude look", () => {
    for (const model of [
      "claude-opus-5-5",
      "claude-sonnet-5-5[1m]",
      "us.anthropic.claude-fable-5-1",
      "opus",
      "sonnet[1m]",
    ]) {
      expect(harnessThemeDriver({ driver: claude, instanceId: "claudeAgent", model })).toBe(claude);
    }
    // Before the model is known the harness keeps its look.
    expect(harnessThemeDriver({ driver: claude, instanceId: "claudeAgent", model: null })).toBe(
      claude,
    );
  });

  it("keeps the user's theme for Claude Code on other models", () => {
    expect(
      harnessThemeDriver({ driver: claude, instanceId: "claude_other", model: "nanbeige4.3-33b" }),
    ).toBe(UNTHEMED_HARNESS);
    expect(harnessThemeDriver({ driver: claude, instanceId: "claude_glm", model: "glm-5.3" })).toBe(
      UNTHEMED_HARNESS,
    );
    expect(resolveHarnessThemeChoice(DEFAULT_HARNESS_THEME_SETTINGS, UNTHEMED_HARNESS)).toEqual({
      kind: "default",
    });
  });

  it("leaves other harnesses alone", () => {
    expect(harnessThemeDriver({ driver: "codex", model: "nanbeige4.3-33b" })).toBe("codex");
  });
});

describe("harnessMascotIdentity", () => {
  it("gives Claude Code on other models the generic companion or their maker's pet", () => {
    expect(
      harnessMascotIdentity({
        driver: "claudeAgent",
        instanceId: "claude_other",
        model: "nanbeige4.3-33b",
      }),
    ).toEqual({ driver: "acpRegistry", agentId: null });
    expect(
      harnessMascotIdentity({ driver: "claudeAgent", instanceId: "claude_glm", model: "glm-5.3" }),
    ).toEqual({ driver: "acpRegistry", agentId: "glm" });
  });

  it("keeps Claude's pet on Claude models and other harnesses' pets", () => {
    expect(
      harnessMascotIdentity({
        driver: "claudeAgent",
        instanceId: "claudeAgent",
        model: "claude-opus-5-5",
      }),
    ).toEqual({ driver: "claudeAgent", agentId: null });
    expect(harnessMascotIdentity({ driver: "acpRegistry", agentId: "kimi" })).toEqual({
      driver: "acpRegistry",
      agentId: "kimi",
    });
    expect(harnessMascotIdentity({ driver: null })).toEqual({ driver: null, agentId: null });
  });

  it("gives a chat without a pet of its own the pet of its model's family", () => {
    // Claude Code pointed at a Qwen model, and a generic agent running one.
    expect(
      harnessMascotIdentity({
        driver: "claudeAgent",
        instanceId: "claudeAgent_qwen4",
        model: "qwen4-max",
      }),
    ).toEqual({ driver: "acpRegistry", agentId: "qwen" });
    expect(
      harnessMascotIdentity({ driver: "acpRegistry", agentId: "hermes", model: "x-ai/grok-4.7" }),
    ).toEqual({ driver: "grok", agentId: null });
    // OpenCode and Pi run many makers' models: the pet follows the maker when it has one.
    expect(
      harnessMascotIdentity({ driver: "opencode", model: "mistralai/mistral-large-4" }),
    ).toEqual({ driver: "acpRegistry", agentId: "mistral-vibe" });
    expect(harnessMascotIdentity({ driver: "pi", model: "anthropic/claude-opus-5-5" })).toEqual({
      driver: "claudeAgent",
      agentId: null,
    });
    // A maker without a mascot keeps the harness's own pet.
    expect(harnessMascotIdentity({ driver: "opencode", model: "meta/llama-5-70b" })).toEqual({
      driver: "opencode",
      agentId: null,
    });
    expect(
      harnessMascotIdentity({ driver: "opencode", model: "google-vertex/gemini-4-carbon" }),
    ).toEqual({ driver: "acpRegistry", agentId: "gemini" });
    expect(harnessMascotIdentity({ driver: "pi", model: "zai/glm-5.3" })).toEqual({
      driver: "acpRegistry",
      agentId: "glm",
    });
    // A maker's own harness keeps its pet whatever model it runs.
    expect(
      harnessMascotIdentity({ driver: "acpRegistry", agentId: "kimi", model: "qwen4-max" }),
    ).toEqual({ driver: "acpRegistry", agentId: "kimi" });
  });
});
