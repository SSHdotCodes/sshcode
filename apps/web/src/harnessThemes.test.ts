import {
  CLAUDE_HARNESS_THEME,
  CODEX_HARNESS_THEME,
  DEFAULT_HARNESS_THEME_SETTINGS,
  GROK_HARNESS_THEME,
  MUSE_HARNESS_THEME,
  MISTRAL_HARNESS_THEME,
  QWEN_HARNESS_THEME,
  harnessThemeDriver,
} from "@t3tools/shared/harnessThemes";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  applyHarnessThemeView,
  DISCORD_WEB_THEME,
  harnessThemeView,
  HARNESS_THEMES_STORAGE_KEY,
  readHarnessThemeSettings,
  resolveActiveHarnessTheme,
  writeHarnessThemeSettings,
} from "./harnessThemes";
import {
  GROVE_THEME,
  getThemeColorsForMode,
  isThemeColor,
  resolveDefinitionAppearance,
  type ThemeDefinition,
} from "./themePalette";

const library: Record<string, ThemeDefinition> = { grove: GROVE_THEME };
const getThemeDefinition = (themeId: string) => library[themeId] ?? null;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveActiveHarnessTheme", () => {
  it("dresses each preset's harness in it by default", () => {
    for (const [driver, preset] of [
      ["codex", CODEX_HARNESS_THEME],
      ["claudeAgent", CLAUDE_HARNESS_THEME],
      ["grok", GROK_HARNESS_THEME],
      ["muse", MUSE_HARNESS_THEME],
      [
        harnessThemeDriver({ driver: "acpRegistry", agentId: "mistral-vibe" }),
        MISTRAL_HARNESS_THEME,
      ],
      [harnessThemeDriver({ driver: "acpRegistry", agentId: "qwen-code" }), QWEN_HARNESS_THEME],
    ] as const) {
      expect(
        resolveActiveHarnessTheme({
          driver,
          settings: DEFAULT_HARNESS_THEME_SETTINGS,
          getThemeDefinition,
        }),
      ).toEqual({ key: `preset:${preset.id}`, definition: preset.theme, preset });
    }
  });

  it("keeps the user's theme without a focused chat, for other harnesses, or when off", () => {
    const resolve = (driver: string | null, enabled = true) =>
      resolveActiveHarnessTheme({
        driver,
        settings: { ...DEFAULT_HARNESS_THEME_SETTINGS, enabled },
        getThemeDefinition,
      });
    expect(resolve(null)).toBeNull();
    expect(resolve("opencode")).toBeNull();
    expect(resolve("cursor")).toBeNull();
    expect(resolve(harnessThemeDriver({ driver: "acpRegistry", agentId: "kimi" }))).toBeNull();
    expect(resolve(harnessThemeDriver({ driver: "acpRegistry", agentId: "unknown" }))).toBeNull();
    expect(resolve("claudeAgent", false)).toBeNull();
  });

  it("applies a library theme chosen for a harness, and falls back when it is gone", () => {
    const settings = {
      enabled: true,
      choices: { codex: "theme:grove", grok: "theme:deleted-theme", claudeAgent: "default" },
    };
    expect(resolveActiveHarnessTheme({ driver: "codex", settings, getThemeDefinition })).toEqual({
      key: "theme:grove",
      definition: GROVE_THEME,
      preset: null,
    });
    expect(resolveActiveHarnessTheme({ driver: "grok", settings, getThemeDefinition })).toBeNull();
    expect(
      resolveActiveHarnessTheme({ driver: "claudeAgent", settings, getThemeDefinition }),
    ).toBeNull();
  });
});

describe("harness preset palettes", () => {
  it("are literal colors for every role the app paints", () => {
    for (const preset of [
      CODEX_HARNESS_THEME,
      CLAUDE_HARNESS_THEME,
      MUSE_HARNESS_THEME,
      MISTRAL_HARNESS_THEME,
      QWEN_HARNESS_THEME,
    ]) {
      for (const appearance of ["light", "dark"] as const) {
        const colors = getThemeColorsForMode(preset.theme, appearance);
        expect(colors).not.toBeNull();
        expect(Object.values(colors!).every(isThemeColor)).toBe(true);
      }
    }
  });

  it("follow the user's light/dark mode, except Grok which stays dark", () => {
    expect(resolveDefinitionAppearance(CLAUDE_HARNESS_THEME.theme, "dark")).toBe("dark");
    expect(resolveDefinitionAppearance(CODEX_HARNESS_THEME.theme, "light")).toBe("light");
    expect(resolveDefinitionAppearance(GROK_HARNESS_THEME.theme, "light")).toBe("dark");
  });
});

describe("harnessThemeView", () => {
  it("maps Claude's serif replies and bubble onto root hooks", () => {
    const view = harnessThemeView(CLAUDE_HARNESS_THEME);
    expect(view.dataset).toEqual({
      harnessTheme: "claude",
      harnessDensity: "comfortable",
      harnessFontProse: "",
    });
    expect(view.properties["--harness-font-prose"]).toMatch(
      /^ui-serif, Georgia, Cambria, "Times New Roman", serif, var\(--font-sans\)$/,
    );
    expect(view.properties["--harness-user-bubble-radius"]).toBe("12px");
    expect(view.properties["--harness-user-bubble-padding-x"]).toBe("16px");
  });

  it("leaves platform font roles to the app and the user's own font choices", () => {
    const view = harnessThemeView(CODEX_HARNESS_THEME);
    expect(view.dataset).toEqual({ harnessTheme: "codex", harnessDensity: "compact" });
    expect(Object.keys(view.properties).filter((key) => key.includes("font"))).toEqual([]);
  });

  it.each([MISTRAL_HARNESS_THEME, QWEN_HARNESS_THEME])(
    "applies $label's bubble geometry while retaining platform fonts",
    (preset) => {
      const view = harnessThemeView(preset);
      expect(view.dataset).toEqual({ harnessTheme: preset.id, harnessDensity: "comfortable" });
      expect(view.properties).toEqual({
        "--harness-user-bubble-radius": `${preset.view.userBubble.radius}px`,
        "--harness-user-bubble-padding-x": `${preset.view.userBubble.paddingX}px`,
        "--harness-user-bubble-padding-y": `${preset.view.userBubble.paddingY}px`,
      });
    },
  );

  it("paints and then clears the root", () => {
    const properties = new Map<string, string>();
    const root = {
      dataset: {} as Record<string, string>,
      style: {
        setProperty: (name: string, value: string) => properties.set(name, value),
        removeProperty: (name: string) => properties.delete(name),
      },
    } as unknown as HTMLElement;

    applyHarnessThemeView(root, MUSE_HARNESS_THEME);
    expect(root.dataset).toMatchObject({ harnessTheme: "muse", harnessFontProse: "" });
    expect(properties.get("--harness-font-prose")).toContain('"Avenir Next"');

    applyHarnessThemeView(root, null);
    expect(root.dataset).toEqual({});
    expect(properties.size).toBe(0);
  });
});

describe("harness theme settings storage", () => {
  function stubStorage(initial: Record<string, string> = {}) {
    const store = new Map(Object.entries(initial));
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => store.set(key, value),
        removeItem: (key: string) => store.delete(key),
      },
    });
    return store;
  }

  it("reads the defaults when nothing is saved or the save is corrupt", () => {
    stubStorage();
    expect(readHarnessThemeSettings()).toEqual(DEFAULT_HARNESS_THEME_SETTINGS);
    stubStorage({ [HARNESS_THEMES_STORAGE_KEY]: "{not json" });
    expect(readHarnessThemeSettings()).toEqual(DEFAULT_HARNESS_THEME_SETTINGS);
  });

  it("round-trips a save", () => {
    const store = stubStorage();
    const settings = { enabled: false, choices: { codex: "theme:grove" } };
    writeHarnessThemeSettings(settings);
    expect(JSON.parse(store.get(HARNESS_THEMES_STORAGE_KEY)!)).toEqual(settings);
    expect(readHarnessThemeSettings()).toEqual(settings);
  });
});

describe("Discord midnight palette", () => {
  it("keeps the mode dark under a light preference and keeps text at AA on its surfaces", () => {
    expect(resolveDefinitionAppearance(DISCORD_WEB_THEME.theme, "light")).toBe("dark");
    const palette = DISCORD_WEB_THEME.palettes.dark;
    const luminance = (hex: string) => {
      const channels = hex
        .slice(1)
        .match(/.{2}/gu)!
        .map((value) => {
          const channel = Number.parseInt(value, 16) / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    for (const surface of [
      palette.canvas,
      palette.sidebar,
      palette.surface,
      palette.raised,
      palette.overlay,
    ]) {
      for (const text of [palette.text, palette.textMuted]) {
        const levels = [luminance(text), luminance(surface)].sort((a, b) => b - a);
        expect((levels[0]! + 0.05) / (levels[1]! + 0.05)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
});
