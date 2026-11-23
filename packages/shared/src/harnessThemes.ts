/**
 * Harness themes: built-in looks that make a chat feel like the app of the
 * harness running it (Codex, Claude, Grok, Muse, Mistral, Qwen), plus the
 * client-local settings that assign a look to each harness.
 *
 * Platform-neutral on purpose: web maps the presets onto its CSS theme
 * variables, and native clients can read the same colors, font roles, and
 * view flags. Colors expand to the shared {@link ThemeColors} roles, so a
 * preset is also an ordinary {@link ThemeDefinition}.
 *
 * @module harnessThemes
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  harnessMascotAgentId,
  harnessMascotForDriver,
  harnessMascotForModel,
} from "./harnessMascots.ts";

import {
  T3_CODE_DARK_THEME_COLORS,
  T3_CODE_LIGHT_THEME_COLORS,
  type ThemeAppearance,
  type ThemeColors,
  type ThemeDefinition,
} from "./themePalettes.ts";

export const HARNESS_THEME_PRESET_IDS = [
  "codex",
  "claude",
  "grok",
  "muse",
  "mistral",
  "qwen",
] as const;
export type HarnessThemePresetId = (typeof HARNESS_THEME_PRESET_IDS)[number];

/**
 * The handful of colors a harness look is designed in, per appearance. Every
 * other product role derives from these (see {@link harnessThemeColors}), so
 * a preset stays readable and cannot drift between surfaces. Hex only, so
 * every client can parse them without a color library.
 */
export type HarnessThemePalette = Readonly<{
  /** The chat surface and the toolbar above it. */
  canvas: string;
  sidebar: string;
  /** Cards and panels. */
  surface: string;
  /** The composer and other raised surfaces. */
  raised: string;
  /** Menus, popovers, and dialogs. */
  overlay: string;
  text: string;
  textMuted: string;
  border: string;
  /** Field outlines. */
  input: string;
  /** Toolbar control fill. The canvas itself gives a quiet, ghost chrome. */
  control: string;
  /** Quiet fills: secondary buttons, chips, hover. */
  fill: string;
  /** Highlighted and active fills. */
  fillStrong: string;
  sidebarHover: string;
  sidebarSelected: string;
  /** Focus rings, selection, and the terminal cursor. */
  accent: string;
  accentForeground: string;
  /** The accent used as text on the canvas, such as update notices. */
  accentText: string;
  /** Send and other primary buttons. */
  action: string;
  actionForeground: string;
  actionHover: string;
  /** The user's own message bubble. */
  bubble: string;
  bubbleForeground: string;
  /** Code block background. */
  code: string;
}>;

/**
 * A font role: family names, most preferred first, where the last entry is a
 * CSS generic (`serif`, `sans-serif`, `monospace`). Native clients map the
 * generic to their system design (`serif` is New York on Apple platforms).
 * `null` keeps the platform's own face, which also leaves any font the user
 * picked in their settings in charge.
 */
export type HarnessThemeFontStack = ReadonlyArray<string> | null;

export type HarnessThemeFonts = Readonly<{
  /** Chrome, the composer, and the user's own messages. */
  interface: HarnessThemeFontStack;
  /** The assistant's replies. */
  prose: HarnessThemeFontStack;
  /** Code blocks, inline code, and the terminal. */
  code: HarnessThemeFontStack;
}>;

/** How a harness lays out a transcript, beyond color and type. */
export type HarnessThemeView = Readonly<{
  /**
   * The user's messages sit in a filled bubble (`messageSurface`); the
   * assistant's replies are always unboxed on the canvas. Dimensions are CSS
   * pixels on web and points on native.
   */
  userBubble: Readonly<{ radius: number; paddingX: number; paddingY: number }>;
  /**
   * `compact` keeps the stock reading size with tighter prose; `comfortable`
   * sets assistant prose a step larger with more leading, like a chat app.
   */
  density: "compact" | "comfortable";
}>;

/**
 * `Id` defaults to every look; the harness presets themselves narrow it to
 * HarnessThemePresetId, so lookups keyed by harness never see a UI mode look.
 */
export type HarnessThemePreset<Id extends string = HarnessThemePresetId | UiModeThemeId> =
  Readonly<{
    /** A harness preset, or a whole-app UI mode look such as Discord mode's. */
    id: Id;
    label: string;
    /** The provider driver whose app this imitates. */
    driver: string;
    /** Registry agent aliases, canonical id first; absent for real drivers. */
    agentIds?: readonly [string, ...string[]];
    /** The agent's name in settings, when different from the look's label. */
    agentLabel?: string;
    /** Stable settings key: the driver, or `acpRegistry:<canonical agent id>`. */
    key: string;
    palettes: Readonly<Partial<Record<ThemeAppearance, HarnessThemePalette>>>;
    /** The palettes expanded to every product color role. */
    theme: ThemeDefinition;
    fonts: HarnessThemeFonts;
    view: HarnessThemeView;
  }>;

function hexChannels(value: string): ReadonlyArray<number> {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  if (!match) throw new Error(`Harness theme colors must be #rrggbb hex, got "${value}".`);
  return match.slice(1).map((channel) => Number.parseInt(channel, 16));
}

/** Mix two hex colors in sRGB; `amount` is the share of `overlay`. */
function mixHex(base: string, overlay: string, amount: number): string {
  const to = hexChannels(overlay);
  return `#${hexChannels(base)
    .map((channel, index) =>
      Math.round(channel + (to[index]! - channel) * amount)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * Status and search colors stay the app's standard ones, so a warning reads
 * the same in every harness; only their surfaces are laid over the canvas.
 */
const STANDARD_COLORS: Readonly<Record<ThemeAppearance, ThemeColors>> = {
  light: T3_CODE_LIGHT_THEME_COLORS,
  dark: T3_CODE_DARK_THEME_COLORS,
};

/** Expand a harness palette to every product color role. */
export function harnessThemeColors(
  palette: HarnessThemePalette,
  appearance: ThemeAppearance,
): ThemeColors {
  const standard = STANDARD_COLORS[appearance];
  const surfaceMix = appearance === "dark" ? 0.16 : 0.08;
  return {
    canvas: palette.canvas,
    chrome: palette.canvas,
    toolbar: palette.canvas,
    toolbarForeground: palette.text,
    toolbarBorder: palette.border,
    toolbarControl: palette.control,
    toolbarControlForeground: palette.text,
    toolbarControlHover: palette.fill,
    surface: palette.surface,
    surfaceRaised: palette.raised,
    surfaceOverlay: palette.overlay,
    text: palette.text,
    textMuted: palette.textMuted,
    border: palette.border,
    input: palette.input,
    focus: palette.accent,
    accent: palette.accent,
    accentForeground: palette.accentForeground,
    secondary: palette.fill,
    secondaryForeground: palette.text,
    muted: palette.fill,
    mutedForeground: palette.textMuted,
    placeholder: palette.textMuted,
    secondaryLabel: palette.textMuted,
    iconMuted: palette.textMuted,
    error: standard.error,
    errorForeground: standard.errorForeground,
    errorSurface: mixHex(palette.canvas, standard.error, surfaceMix),
    warning: standard.warning,
    warningForeground: standard.warningForeground,
    warningSurface: mixHex(palette.canvas, standard.warning, surfaceMix),
    update: palette.accent,
    updateForeground: palette.accentText,
    updateSurface: mixHex(palette.canvas, palette.accent, surfaceMix),
    accentSurface: palette.fillStrong,
    accentSurfaceForeground: palette.text,
    messageSurface: palette.bubble,
    messageForeground: palette.bubbleForeground,
    messageAction: palette.action,
    messageActionForeground: palette.actionForeground,
    messageActionHover: palette.actionHover,
    codeBackground: palette.code,
    codeForeground: palette.text,
    searchMatchBackground: standard.searchMatchBackground,
    searchMatchForeground: standard.searchMatchForeground,
    searchMatchActiveBackground: standard.searchMatchActiveBackground,
    searchMatchActiveForeground: standard.searchMatchActiveForeground,
    sidebar: palette.sidebar,
    sidebarForeground: palette.text,
    sidebarMutedForeground: palette.textMuted,
    sidebarControlSurface: palette.sidebarHover,
    sidebarRowHover: palette.sidebarHover,
    sidebarRowActive: palette.sidebarSelected,
    sidebarRowSelected: palette.sidebarSelected,
    sidebarBorder: palette.border,
    terminalBackground: palette.canvas,
    terminalForeground: palette.text,
    terminalCursor: palette.accent,
    terminalSelection: mixHex(palette.canvas, palette.accent, appearance === "dark" ? 0.3 : 0.2),
    terminalScrollbar: palette.input,
    terminalScrollbarHover: palette.textMuted,
  };
}

function defineHarnessThemePreset<Id extends HarnessThemePresetId | UiModeThemeId>(
  preset: Omit<HarnessThemePreset<Id>, "theme" | "key"> & { appearance: ThemeAppearance },
): HarnessThemePreset<Id> {
  const { appearance, ...rest } = preset;
  const base = preset.palettes[appearance];
  if (!base) throw new Error(`The ${preset.label} harness theme has no ${appearance} palette.`);
  const other: ThemeAppearance = appearance === "light" ? "dark" : "light";
  const variant = preset.palettes[other];
  return {
    ...rest,
    key: preset.agentIds ? `${preset.driver}:${preset.agentIds[0]}` : preset.driver,
    theme: {
      id: `harness-${preset.id}`,
      label: preset.label,
      appearance,
      colors: harnessThemeColors(base, appearance),
      ...(variant ? { variants: { [other]: harnessThemeColors(variant, other) } } : {}),
    },
  };
}

/** The serif Claude sets its replies in; Georgia is the face most machines have. */
const SERIF_PROSE_FONTS = ["ui-serif", "Georgia", "Cambria", "Times New Roman", "serif"];

/**
 * OpenAI's Codex app: ChatGPT's neutral greys on white or near-black, a
 * black-or-white send button, a blue kept to focus and selection, and ghost
 * toolbar controls.
 */
export const CODEX_HARNESS_THEME = defineHarnessThemePreset({
  id: "codex",
  label: "Codex",
  driver: "codex",
  appearance: "light",
  palettes: {
    light: {
      canvas: "#ffffff",
      sidebar: "#f9f9f9",
      surface: "#ffffff",
      raised: "#ffffff",
      overlay: "#ffffff",
      text: "#0d0d0d",
      textMuted: "#5d5d5d",
      border: "#e6e6e6",
      input: "#d9d9d9",
      control: "#ffffff",
      fill: "#f4f4f4",
      fillStrong: "#ececec",
      sidebarHover: "#efefef",
      sidebarSelected: "#e8e8e8",
      accent: "#2563eb",
      accentForeground: "#ffffff",
      accentText: "#1d5bd8",
      action: "#0d0d0d",
      actionForeground: "#ffffff",
      actionHover: "#333333",
      bubble: "#f4f4f4",
      bubbleForeground: "#0d0d0d",
      code: "#f9f9f9",
    },
    dark: {
      canvas: "#181818",
      sidebar: "#131313",
      surface: "#1f1f1f",
      raised: "#262626",
      overlay: "#222222",
      text: "#ececec",
      textMuted: "#9b9b9b",
      border: "#2e2e2e",
      input: "#3a3a3a",
      control: "#181818",
      fill: "#222222",
      fillStrong: "#2a2a2a",
      sidebarHover: "#1e1e1e",
      sidebarSelected: "#242424",
      accent: "#4d8dff",
      accentForeground: "#0d0d0d",
      accentText: "#7cacff",
      action: "#ececec",
      actionForeground: "#0d0d0d",
      actionHover: "#d4d4d4",
      bubble: "#2a2a2a",
      bubbleForeground: "#ececec",
      code: "#111111",
    },
  },
  fonts: { interface: null, prose: null, code: null },
  view: { userBubble: { radius: 18, paddingX: 16, paddingY: 10 }, density: "compact" },
});

/**
 * Anthropic's Claude app: warm ivory (or warm charcoal) paper, a terracotta
 * accent, replies set in a serif, and the user's turns in a soft warm bubble.
 */
export const CLAUDE_HARNESS_THEME = defineHarnessThemePreset({
  id: "claude",
  label: "Claude",
  driver: "claudeAgent",
  appearance: "light",
  palettes: {
    light: {
      canvas: "#faf9f5",
      sidebar: "#f4f3ee",
      surface: "#ffffff",
      raised: "#ffffff",
      overlay: "#ffffff",
      text: "#1f1e1d",
      textMuted: "#6a6963",
      border: "#e3e0d7",
      input: "#d6d3c9",
      control: "#f0eee6",
      fill: "#f0eee6",
      fillStrong: "#e8e6dc",
      sidebarHover: "#ecebe3",
      sidebarSelected: "#e6e3d9",
      accent: "#d97757",
      accentForeground: "#1f1e1d",
      accentText: "#ae5232",
      // Claude's send button, deepened a touch so white labels clear 4.5:1.
      action: "#b9573a",
      actionForeground: "#ffffff",
      actionHover: "#a84d32",
      bubble: "#f0eee6",
      bubbleForeground: "#1f1e1d",
      code: "#f3f1ea",
    },
    dark: {
      canvas: "#262624",
      sidebar: "#1f1e1d",
      surface: "#30302e",
      raised: "#30302e",
      overlay: "#30302e",
      text: "#f5f4ef",
      textMuted: "#a3a097",
      border: "#3e3e3a",
      input: "#4a4945",
      control: "#30302e",
      fill: "#30302e",
      fillStrong: "#393936",
      sidebarHover: "#2a2927",
      sidebarSelected: "#33322f",
      accent: "#d97757",
      accentForeground: "#1f1e1d",
      accentText: "#e39271",
      action: "#b9573a",
      actionForeground: "#ffffff",
      actionHover: "#c4613f",
      bubble: "#1a1918",
      bubbleForeground: "#f5f4ef",
      code: "#1f1e1d",
    },
  },
  fonts: { interface: null, prose: SERIF_PROSE_FONTS, code: null },
  view: { userBubble: { radius: 12, paddingX: 16, paddingY: 12 }, density: "comfortable" },
});

/**
 * xAI's Grok iOS app: true black, white type, dark grey pill-round user
 * bubbles, a white send button, and no hue at all. Dark only, like the app.
 */
export const GROK_HARNESS_THEME = defineHarnessThemePreset({
  id: "grok",
  label: "Grok",
  driver: "grok",
  appearance: "dark",
  palettes: {
    dark: {
      canvas: "#000000",
      sidebar: "#080808",
      surface: "#111111",
      raised: "#171717",
      overlay: "#141414",
      text: "#ffffff",
      textMuted: "#9a9a9a",
      border: "#222222",
      input: "#333333",
      control: "#000000",
      fill: "#151515",
      fillStrong: "#1f1f1f",
      sidebarHover: "#141414",
      sidebarSelected: "#1c1c1c",
      accent: "#e5e5e5",
      accentForeground: "#000000",
      accentText: "#ffffff",
      action: "#ffffff",
      actionForeground: "#000000",
      actionHover: "#d9d9d9",
      bubble: "#232323",
      bubbleForeground: "#ffffff",
      code: "#0e0e0e",
    },
  },
  fonts: { interface: null, prose: null, code: null },
  view: { userBubble: { radius: 24, paddingX: 18, paddingY: 12 }, density: "comfortable" },
});

/**
 * Muse Code has no app of its own to imitate, so its look is our own: cool
 * slate paper or midnight, Meta's blue for focus with a violet send button
 * after Meta AI's ring, periwinkle bubbles, and replies in a geometric sans
 * in the spirit of Meta's Optimistic.
 */
export const MUSE_HARNESS_THEME = defineHarnessThemePreset({
  id: "muse",
  label: "Muse",
  driver: "muse",
  appearance: "light",
  palettes: {
    light: {
      canvas: "#f7f8fa",
      sidebar: "#f0f2f6",
      surface: "#ffffff",
      raised: "#ffffff",
      overlay: "#ffffff",
      text: "#141824",
      textMuted: "#5a6275",
      border: "#e1e5ec",
      input: "#ced4de",
      control: "#eef1f6",
      fill: "#eef1f6",
      fillStrong: "#e5e9f2",
      sidebarHover: "#e7ebf2",
      sidebarSelected: "#dfe5f0",
      accent: "#0866ff",
      accentForeground: "#ffffff",
      accentText: "#0757d6",
      action: "#5b3fd9",
      actionForeground: "#ffffff",
      actionHover: "#4e33c4",
      bubble: "#ecebff",
      bubbleForeground: "#1b1840",
      code: "#f0f2f6",
    },
    dark: {
      canvas: "#0d0f14",
      sidebar: "#090b10",
      surface: "#151821",
      raised: "#191c26",
      overlay: "#171a23",
      text: "#e8ebf2",
      textMuted: "#9097a8",
      border: "#232733",
      input: "#2f3442",
      control: "#171a23",
      fill: "#171a23",
      fillStrong: "#1f2330",
      sidebarHover: "#12151c",
      sidebarSelected: "#1a1e29",
      accent: "#3d8bff",
      accentForeground: "#06122a",
      accentText: "#6ea8ff",
      action: "#6a4ff0",
      actionForeground: "#ffffff",
      actionHover: "#7a61f5",
      bubble: "#25233f",
      bubbleForeground: "#eceaff",
      code: "#0a0c11",
    },
  },
  fonts: {
    interface: null,
    prose: ["Optimistic Text", "Avenir Next", "Avenir", "Segoe UI Variable Text", "sans-serif"],
    code: null,
  },
  view: { userBubble: { radius: 20, paddingX: 16, paddingY: 11 }, density: "comfortable" },
});

/** Mistral Vibe's warm paper, orange accents and squared bubbles. */
export const MISTRAL_HARNESS_THEME = defineHarnessThemePreset({
  id: "mistral",
  label: "Mistral",
  driver: "acpRegistry",
  agentIds: ["mistral-vibe"],
  agentLabel: "Mistral Vibe",
  appearance: "light",
  palettes: {
    light: {
      canvas: "#fffaeb",
      sidebar: "#fbf1d3",
      surface: "#ffffff",
      raised: "#ffffff",
      overlay: "#ffffff",
      text: "#1e1b16",
      textMuted: "#6b6253",
      border: "#ecdfb9",
      input: "#e0d2a6",
      control: "#fbf0cf",
      fill: "#fbf0cf",
      fillStrong: "#f5e6b8",
      sidebarHover: "#f6eac6",
      sidebarSelected: "#f0e1b4",
      accent: "#fa500f",
      accentForeground: "#1e1b16",
      accentText: "#c23c05",
      action: "#cf3d00",
      actionForeground: "#ffffff",
      actionHover: "#b93600",
      bubble: "#ffe9a8",
      bubbleForeground: "#1e1b16",
      code: "#fbf3d9",
    },
    dark: {
      canvas: "#1a1713",
      sidebar: "#14120f",
      surface: "#24201a",
      raised: "#24201a",
      overlay: "#262119",
      text: "#fff6e0",
      textMuted: "#b3a78f",
      border: "#3a332a",
      input: "#4a4236",
      control: "#24201a",
      fill: "#24201a",
      fillStrong: "#2e2921",
      sidebarHover: "#1f1b16",
      sidebarSelected: "#2a251d",
      accent: "#ff8205",
      accentForeground: "#1a1713",
      accentText: "#ffa94d",
      action: "#fa500f",
      actionForeground: "#160f08",
      actionHover: "#ff6a2b",
      bubble: "#33291a",
      bubbleForeground: "#fff6e0",
      code: "#14120f",
    },
  },
  fonts: { interface: null, prose: null, code: null },
  view: { userBubble: { radius: 6, paddingX: 14, paddingY: 10 }, density: "comfortable" },
});

/** Qwen Code's clean violet palette and soft rounded bubbles. */
export const QWEN_HARNESS_THEME = defineHarnessThemePreset({
  id: "qwen",
  label: "Qwen",
  driver: "acpRegistry",
  agentIds: ["qwen", "qwen-code"],
  agentLabel: "Qwen Code",
  appearance: "light",
  palettes: {
    light: {
      canvas: "#fbfaff",
      sidebar: "#f4f2fd",
      surface: "#ffffff",
      raised: "#ffffff",
      overlay: "#ffffff",
      text: "#17152b",
      textMuted: "#615f7a",
      border: "#e4e1f5",
      input: "#d6d2ee",
      control: "#f1eefc",
      fill: "#f1eefc",
      fillStrong: "#e8e4fa",
      sidebarHover: "#ece9fa",
      sidebarSelected: "#e3dff8",
      accent: "#615ced",
      accentForeground: "#ffffff",
      accentText: "#4d47d1",
      action: "#5750dc",
      actionForeground: "#ffffff",
      actionHover: "#4a43c8",
      bubble: "#ebe8ff",
      bubbleForeground: "#17152b",
      code: "#f4f2fd",
    },
    dark: {
      canvas: "#12111d",
      sidebar: "#0d0c16",
      surface: "#1b1a2a",
      raised: "#1b1a2a",
      overlay: "#1d1c2d",
      text: "#f1f0ff",
      textMuted: "#a3a0c4",
      border: "#2c2a44",
      input: "#3a3856",
      control: "#1b1a2a",
      fill: "#1b1a2a",
      fillStrong: "#242338",
      sidebarHover: "#171625",
      sidebarSelected: "#201f33",
      accent: "#8f8aff",
      accentForeground: "#12111d",
      accentText: "#a8a4ff",
      action: "#5f58e8",
      actionForeground: "#ffffff",
      actionHover: "#7069f0",
      bubble: "#26244a",
      bubbleForeground: "#f1f0ff",
      code: "#0d0c16",
    },
  },
  fonts: { interface: null, prose: null, code: null },
  view: { userBubble: { radius: 18, paddingX: 16, paddingY: 11 }, density: "comfortable" },
});

// ── UI modes ─────────────────────────────────────────────────────────

/**
 * How the whole app is laid out, chosen per device. `discord` swaps in
 * Discord's layout and wears DISCORD_UI_THEME over every chat, ahead of the
 * per-harness looks; `default` is the app as designed.
 */
export const UI_MODES = ["default", "discord"] as const;
export type UiMode = (typeof UI_MODES)[number];
export const DEFAULT_UI_MODE: UiMode = "default";

export type UiModeThemeId = Exclude<UiMode, "default">;

/**
 * Discord mode's look: Discord's classic greys (rail #1e1f22, channels
 * #2b2d31, chat #313338), blurple for brand and primary actions, and its
 * light theme. Deliberately not in HARNESS_THEME_PRESETS, so no harness can
 * pick it; it only shows while Discord mode is on.
 */
export const DISCORD_UI_THEME = defineHarnessThemePreset({
  id: "discord",
  label: "Discord",
  driver: "",
  appearance: "dark",
  palettes: {
    light: {
      canvas: "#ffffff",
      sidebar: "#f2f3f5",
      surface: "#f2f3f5",
      raised: "#ebedef",
      overlay: "#ffffff",
      text: "#313338",
      textMuted: "#5c5e66",
      border: "#e1e2e4",
      input: "#e3e5e8",
      control: "#ffffff",
      fill: "#ebedef",
      fillStrong: "#d4d6db",
      sidebarHover: "#e0e2e6",
      sidebarSelected: "#d4d6db",
      accent: "#5865f2",
      accentForeground: "#ffffff",
      accentText: "#006ce7",
      action: "#5865f2",
      actionForeground: "#ffffff",
      actionHover: "#4752c4",
      bubble: "#f2f3f5",
      bubbleForeground: "#313338",
      code: "#f2f3f5",
    },
    dark: {
      canvas: "#313338",
      sidebar: "#2b2d31",
      surface: "#2b2d31",
      raised: "#383a40",
      overlay: "#111214",
      text: "#dbdee1",
      textMuted: "#949ba4",
      border: "#3f4147",
      input: "#1e1f22",
      control: "#313338",
      fill: "#393b41",
      fillStrong: "#404249",
      sidebarHover: "#35373c",
      sidebarSelected: "#404249",
      accent: "#5865f2",
      accentForeground: "#ffffff",
      accentText: "#00a8fc",
      action: "#5865f2",
      actionForeground: "#ffffff",
      actionHover: "#4752c4",
      bubble: "#383a40",
      bubbleForeground: "#dbdee1",
      code: "#2b2d31",
    },
  },
  // gg sans is Discord's own face; where it isn't installed the platform's
  // sans follows (the stock stack is always appended).
  fonts: { interface: ["gg sans", "Noto Sans"], prose: ["gg sans", "Noto Sans"], code: null },
  view: { userBubble: { radius: 8, paddingX: 12, paddingY: 8 }, density: "comfortable" },
});

export const HARNESS_THEME_PRESETS: ReadonlyArray<HarnessThemePreset<HarnessThemePresetId>> = [
  CODEX_HARNESS_THEME,
  CLAUDE_HARNESS_THEME,
  GROK_HARNESS_THEME,
  MUSE_HARNESS_THEME,
  MISTRAL_HARNESS_THEME,
  QWEN_HARNESS_THEME,
];

export function getHarnessThemePreset(id: string): HarnessThemePreset<HarnessThemePresetId> | null {
  return HARNESS_THEME_PRESETS.find((preset) => preset.id === id) ?? null;
}

// ── Settings ─────────────────────────────────────────────────────────

/**
 * What a harness wears, stored as one string so the settings stay a flat
 * record: `default` (the user's own theme), `preset:<id>`, or `theme:<id>`
 * for a theme in the user's library. The prefixes keep a library theme that
 * happens to be named `default` or `codex` from being mistaken for either.
 */
export type HarnessThemeChoice = string;
export const DEFAULT_HARNESS_THEME_CHOICE: HarnessThemeChoice = "default";

export function harnessPresetChoice(id: HarnessThemePresetId): HarnessThemeChoice {
  return `preset:${id}`;
}

export function harnessLibraryThemeChoice(themeId: string): HarnessThemeChoice {
  return `theme:${themeId}`;
}

export type ParsedHarnessThemeChoice =
  | Readonly<{ kind: "default" }>
  | Readonly<{ kind: "preset"; preset: HarnessThemePreset }>
  | Readonly<{ kind: "theme"; themeId: string }>;

const DEFAULT_PARSED_CHOICE: ParsedHarnessThemeChoice = { kind: "default" };

/** Unknown or malformed choices read as the default, so a stale save never breaks a chat. */
export function parseHarnessThemeChoice(choice: HarnessThemeChoice): ParsedHarnessThemeChoice {
  if (choice.startsWith("preset:")) {
    const preset = getHarnessThemePreset(choice.slice("preset:".length));
    return preset ? { kind: "preset", preset } : DEFAULT_PARSED_CHOICE;
  }
  if (choice.startsWith("theme:")) {
    const themeId = choice.slice("theme:".length);
    return themeId.length > 0 ? { kind: "theme", themeId } : DEFAULT_PARSED_CHOICE;
  }
  return DEFAULT_PARSED_CHOICE;
}

/** Each preset is its own harness's default; every other harness keeps the user's theme. */
export function defaultHarnessThemeChoice(driver: string): HarnessThemeChoice {
  const preset = HARNESS_THEME_PRESETS.find((candidate) => candidate.key === driver);
  return preset ? harnessPresetChoice(preset.id) : DEFAULT_HARNESS_THEME_CHOICE;
}

/**
 * Client-local, like the theme preference itself: each device decides how
 * its own chats look. `choices` only records what the user changed, so a
 * preset added later still becomes its harness's default.
 */
export const HarnessThemeSettings = Schema.Struct({
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  choices: Schema.Record(Schema.String, Schema.String).pipe(
    Schema.withDecodingDefault(Effect.succeed({})),
  ),
});
export type HarnessThemeSettings = typeof HarnessThemeSettings.Type;

export const DEFAULT_HARNESS_THEME_SETTINGS: HarnessThemeSettings = Schema.decodeSync(
  HarnessThemeSettings,
)({});

export function harnessThemeChoiceFor(
  settings: HarnessThemeSettings,
  driver: string,
): HarnessThemeChoice {
  return settings.choices[driver] ?? defaultHarnessThemeChoice(driver);
}

/** What a chat on this harness wears; the default whenever harness themes are off. */
export function resolveHarnessThemeChoice(
  settings: HarnessThemeSettings,
  driver: string,
): ParsedHarnessThemeChoice {
  if (!settings.enabled) return DEFAULT_PARSED_CHOICE;
  return parseHarnessThemeChoice(harnessThemeChoiceFor(settings, driver));
}

/** A harness no look is assigned to: its chats keep the user's own theme. */
export const UNTHEMED_HARNESS = "unthemed";

/** Claude Code's `--model` shortcuts, which name Claude models without saying "claude". */
const CLAUDE_CODE_MODEL_ALIASES = new Set([
  "default",
  "best",
  "opus",
  "sonnet",
  "haiku",
  "opusplan",
  "fable",
]);

/**
 * The settings key whose look a chat wears, distinguishing registry agents.
 * Claude Code on a non-Claude model (a server behind ANTHROPIC_BASE_URL)
 * keeps the user's own theme rather than Claude's.
 */
export function harnessThemeDriver(input: {
  readonly driver: string;
  readonly instanceId?: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly agentId?: string | null | undefined;
}): string {
  if (input.driver === "acpRegistry") {
    const agentId = input.agentId?.trim();
    return (
      HARNESS_THEME_PRESETS.find((preset) => preset.agentIds?.includes(agentId ?? ""))?.key ??
      input.driver
    );
  }
  if (input.driver !== "claudeAgent") return input.driver;
  const model = (input.model ?? "")
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/u, "");
  // Not known yet: keep the harness's look rather than flash the user's theme.
  if (model.length === 0) return input.driver;
  return model.includes("claude") || CLAUDE_CODE_MODEL_ALIASES.has(model)
    ? input.driver
    : UNTHEMED_HARNESS;
}

/** Recover the provider identity for a theme settings row, including customized registry keys. */
export function harnessThemeIdentity(key: string) {
  const prefix = "acpRegistry:";
  return key.startsWith(prefix)
    ? { driver: "acpRegistry", agentId: key.slice(prefix.length) }
    : { driver: key, agentId: null };
}

/** Installed harnesses with a look, plus saved choices so unavailable harnesses stay resettable. */
export function harnessThemeKeys(
  providers: ReadonlyArray<{
    readonly driver: string;
    readonly enabled: boolean;
    readonly installed: boolean;
    readonly config?: unknown;
  }>,
  settings: HarnessThemeSettings,
): ReadonlyArray<string> {
  const keys =
    providers.length === 0
      ? HARNESS_THEME_PRESETS.filter((preset) => !preset.agentIds).map((preset) => preset.key)
      : providers
          .filter((provider) => provider.enabled && provider.installed)
          .map((provider) =>
            harnessThemeDriver({
              driver: provider.driver,
              agentId: harnessMascotAgentId(provider.driver, provider.config),
            }),
          )
          .filter((key) => key !== "acpRegistry");
  return [...new Set([...keys, ...Object.keys(settings.choices)])];
}

/**
 * Harnesses that run many makers' models. Their own pet (OpenCode's robot,
 * Pi's bird) said nothing about the model, so every chat looked alike; the
 * pet follows the model's maker when that maker has one.
 */
const MULTI_MAKER_HARNESSES: ReadonlySet<string> = new Set(["opencode", "pi"]);

/**
 * The pet that fronts a chat. Claude Code on a model that isn't Claude gets the
 * generic companion rather than Claude's, as its theme stays the user's own.
 */
export function harnessMascotIdentity(input: {
  readonly driver: string | null | undefined;
  readonly instanceId?: string | null | undefined;
  readonly model?: string | null | undefined;
  readonly agentId?: string | null | undefined;
}): { readonly driver: string | null; readonly agentId: string | null } {
  const driver = input.driver ?? null;
  if (
    driver !== null &&
    harnessThemeDriver({
      driver,
      instanceId: input.instanceId,
      model: input.model,
      agentId: input.agentId,
    }) === UNTHEMED_HARNESS
  ) {
    // The registry driver without an agent id is the generic companion, unless
    // the model's own family has a pet.
    return harnessMascotForModel(input.model) ?? { driver: "acpRegistry", agentId: null };
  }
  const agentId = input.agentId ?? null;
  const own = harnessMascotForDriver(driver, agentId);
  // A generic agent (the companion Patch), or a harness that runs many makers'
  // models, running a model whose family has a pet.
  if (
    (driver === "acpRegistry" && (own === null || own.id === "acp")) ||
    (driver !== null && MULTI_MAKER_HARNESSES.has(driver))
  ) {
    return harnessMascotForModel(input.model) ?? { driver, agentId };
  }
  return { driver, agentId };
}
