import type { DesktopBridge, DesktopTheme } from "@t3tools/contracts";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import {
  DEFAULT_HARNESS_THEME_SETTINGS,
  DEFAULT_UI_MODE,
  type HarnessThemeSettings,
  UI_MODES,
  type UiMode,
} from "@t3tools/shared/harnessThemes";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useLayoutEffect, useSyncExternalStore } from "react";
import {
  applyHarnessThemeView,
  DISCORD_WEB_THEME,
  harnessThemeBootHint,
  harnessThemeBootRoute,
  HARNESS_THEMES_STORAGE_KEY,
  readHarnessThemeBootDriver,
  readHarnessThemeSettings,
  resolveActiveHarnessTheme,
  writeHarnessThemeBootHint,
  writeHarnessThemeSettings,
  type ActiveHarnessTheme,
} from "../harnessThemes";
import {
  getLocalStorageItem,
  removeLocalStorageItem,
  setLocalStorageItem,
} from "./useLocalStorage";
import {
  applyThemeDefinition,
  applyThemePalette,
  getThemeColorsForMode,
  CUSTOM_THEMES_STORAGE_KEY,
  invalidateCustomThemes,
  canonicalThemePreference,
  isKnownThemePreference,
  getThemeDefinition,
  getThemePreferenceMode,
  parseThemeHalves,
  resolveDefinitionAppearance,
  resolveDesktopTheme,
  resolveThemeAppearance,
  resolveThemeHalf,
  THEME_PREVIEW_ID,
  THEME_APPEARANCE_MODE_STORAGE_KEY,
  THEME_FOLLOW_SYSTEM_STORAGE_KEY,
  THEME_HALVES_STORAGE_KEY,
  ThemePreference,
  type ThemeAppearance,
  type ThemeHalves,
  type ThemePreferenceMode,
} from "../themePalette";

type Theme = ThemePreference;
type ThemeSnapshot = {
  theme: Theme;
  resolvedTheme: ThemeAppearance;
  systemDark: boolean;
  followSystem: boolean;
  appearanceMode: ThemePreferenceMode;
  themeHalves: ThemeHalves | null;
  /** The look the focused chat's harness wears over `theme`, if any. */
  harnessTheme: ActiveHarnessTheme | null;
};

type DesktopThemeBridge = Pick<DesktopBridge, "setTheme">;

const STORAGE_KEY = "t3code:theme";
const MEDIA_QUERY = "(prefers-color-scheme: dark)";
const DEFAULT_THEME_SNAPSHOT: ThemeSnapshot = {
  theme: "system",
  resolvedTheme: "light",
  systemDark: false,
  followSystem: true,
  appearanceMode: "system",
  themeHalves: null,
  harnessTheme: null,
};

/** Live read of the stored appearance mix, for callers that must not rely on
 * a render-time snapshot (for example rollback after an async dialog). */
export function readThemeHalves(): ThemeHalves | null {
  return readStoredThemeHalves();
}

/**
 * The stored mix as written, without resolvability pruning. Flows that
 * rebuild the whole mix must capture this before a `setTheme` clears it: a
 * published id resolves only once its set has streamed in, and treating "not
 * resolvable yet" as "absent" silently rewrites that half.
 */
export function readThemeHalvesRaw(): { light?: string; dark?: string } {
  if (typeof window === "undefined") return {};
  return readStoredThemeHalvesRaw();
}

function readStoredThemeHalves(): ThemeHalves | null {
  if (typeof window === "undefined") return null;
  try {
    return parseThemeHalves(window.localStorage.getItem(THEME_HALVES_STORAGE_KEY));
  } catch {
    return null;
  }
}

/**
 * The stored mix as written, without resolvability pruning. An environment
 * published id resolves only once its set has streamed in, so a write that
 * merged over the pruned parse would silently erase that half whenever the
 * other one changed before the set arrived.
 */
function readStoredThemeHalvesRaw(): { light?: string; dark?: string } {
  try {
    const value: unknown = JSON.parse(
      window.localStorage.getItem(THEME_HALVES_STORAGE_KEY) ?? "null",
    );
    if (value === null || typeof value !== "object") return {};
    const halves: { light?: string; dark?: string } = {};
    for (const appearance of ["light", "dark"] as const) {
      const themeId = (value as Record<string, unknown>)[appearance];
      if (typeof themeId === "string") halves[appearance] = themeId;
    }
    return halves;
  } catch {
    return {};
  }
}

function themeHalvesSignature(halves: ThemeHalves | null): string {
  return `${halves?.light ?? ""}|${halves?.dark ?? ""}`;
}

const THEME_COLOR_META_NAME = "theme-color";
const DYNAMIC_THEME_COLOR_SELECTOR = `meta[name="${THEME_COLOR_META_NAME}"][data-dynamic-theme-color="true"]`;

export class ThemeStorageError extends Schema.TaggedError<ThemeStorageError>()(
  "ThemeStorageError",
  {
    operation: Schema.Literals(["read", "write"]),
    storageKey: Schema.String,
    theme: Schema.optional(ThemePreference),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} theme preference for ${this.storageKey}.`;
  }
}

export const isThemeStorageError = Schema.is(ThemeStorageError);

export class DesktopThemeSyncError extends Schema.TaggedError<DesktopThemeSyncError>()(
  "DesktopThemeSyncError",
  {
    theme: ThemePreference,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to sync the ${this.theme} theme to the desktop shell.`;
  }
}

export const isDesktopThemeSyncError = Schema.is(DesktopThemeSyncError);

let listeners: Array<() => void> = [];
let lastSnapshot: ThemeSnapshot | null = null;
let snapshotStale = true;
let lastDesktopTheme: "light" | "dark" | "system" | null = null;
let lastAppliedTheme: Omit<ThemeSnapshot, "resolvedTheme"> | null = null;
let themeStorageReadFailure: ThemeStorageError | null = null;
/**
 * The focused chat's harness settings key: its provider driver or registry agent,
 * including a draft's selected harness. `restored` marks a claim carried over
 * from the last session (see writeHarnessThemeBootHint) until the chat mounts.
 */
type HarnessClaim = { readonly driver: string; readonly restored?: boolean };
let harnessClaim: HarnessClaim | null = null;
let harnessThemeSettings: HarnessThemeSettings | null = null;
let lastDesktopThemeOverride: DesktopTheme | undefined;

function getHarnessThemeSettings(): HarnessThemeSettings {
  if (typeof window === "undefined") return DEFAULT_HARNESS_THEME_SETTINGS;
  return (harnessThemeSettings ??= readHarnessThemeSettings());
}

/** Client-local, like the theme itself: each device picks its own layout. */
export const UI_MODE_STORAGE_KEY = "t3code:ui-mode:v1";
/** Read by the boot script in index.html; keep the key and fields in sync. */
const UI_MODE_BOOT_STORAGE_KEY = "t3code:ui-mode-boot:v1";
const UiModeSchema = Schema.Literals(UI_MODES);
const UiModeBootColors = Schema.Struct({
  background: Schema.String,
  foreground: Schema.String,
  accent: Schema.String,
  chrome: Schema.String,
});
const UiModeBootHint = Schema.Struct({
  mode: UiModeSchema,
  light: UiModeBootColors,
  dark: UiModeBootColors,
});
let uiMode: UiMode | null = null;

const DISCORD_LOOK: ActiveHarnessTheme = {
  key: "ui:discord",
  definition: DISCORD_WEB_THEME.theme,
  preset: DISCORD_WEB_THEME,
};

function getUiMode(): UiMode {
  if (typeof window === "undefined") return DEFAULT_UI_MODE;
  if (uiMode === null) {
    try {
      uiMode = getLocalStorageItem(UI_MODE_STORAGE_KEY, UiModeSchema) ?? DEFAULT_UI_MODE;
    } catch {
      // A corrupt or unreadable save shows the app as designed.
      uiMode = DEFAULT_UI_MODE;
    }
  }
  return uiMode;
}

/** The boot splash paints the mode's colors before the app loads, so switching never flashes. */
function writeUiModeBootHint(mode: UiMode) {
  try {
    if (mode === "default") {
      removeLocalStorageItem(UI_MODE_BOOT_STORAGE_KEY);
      return;
    }
    const colorsFor = (appearance: ThemeAppearance) => {
      const colors =
        getThemeColorsForMode(DISCORD_LOOK.definition, appearance) ??
        DISCORD_LOOK.definition.colors;
      return {
        background: colors.canvas,
        foreground: colors.text,
        accent: colors.accent,
        chrome: colors.chrome,
      };
    };
    setLocalStorageItem(
      UI_MODE_BOOT_STORAGE_KEY,
      { mode, light: colorsFor("light"), dark: colorsFor("dark") },
      UiModeBootHint,
    );
  } catch {
    // Only the boot splash misses the colors; the app still applies the mode.
  }
}

function applyUiModeAttribute(mode: UiMode) {
  const dataset = document.documentElement.dataset;
  if (!dataset) return;
  if (mode === "default") delete dataset.uiMode;
  else dataset.uiMode = mode;
}

function getActiveHarnessTheme(): ActiveHarnessTheme | null {
  // Discord mode wears its own look over every chat, ahead of harness looks.
  if (getUiMode() === "discord") return DISCORD_LOOK;
  return resolveActiveHarnessTheme({
    driver: harnessClaim?.driver ?? null,
    settings: getHarnessThemeSettings(),
    getThemeDefinition,
  });
}

/**
 * What is actually on screen: the harness look when one applies (following
 * the user's light/dark mode wherever it can render it), else the stored
 * preference and its mix.
 */
function resolveAppliedAppearance(
  theme: Theme,
  systemDark: boolean,
  appearanceMode: ThemePreferenceMode,
  themeHalves: ThemeHalves | null,
  harnessTheme: ActiveHarnessTheme | null,
): ThemeAppearance {
  if (harnessTheme === null) {
    return resolveThemeAppearance(
      theme,
      systemDark,
      appearanceMode === "system",
      appearanceMode,
      themeHalves,
    );
  }
  const wanted = appearanceMode === "system" ? (systemDark ? "dark" : "light") : appearanceMode;
  return resolveDefinitionAppearance(harnessTheme.definition, wanted);
}

/**
 * The shell follows a harness look only under an explicit light or dark mode.
 * Under System, forcing the shell would also flip `prefers-color-scheme`, and
 * the next chat would resolve against the forced value instead of the OS and
 * flash; there the shell keeps following the stored preference.
 */
function harnessDesktopTheme(
  harnessTheme: ActiveHarnessTheme | null,
  appearanceMode: ThemePreferenceMode,
  resolvedAppearance: ThemeAppearance,
): DesktopTheme | undefined {
  return harnessTheme !== null && appearanceMode !== "system" ? resolvedAppearance : undefined;
}

function emitChange() {
  snapshotStale = true;
  for (const listener of listeners) listener();
}

function getSystemDark() {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(MEDIA_QUERY).matches
  );
}

function readStoredFollowSystem(theme: Theme): boolean {
  if (typeof window === "undefined") return theme === "system";

  try {
    const raw = window.localStorage.getItem(THEME_FOLLOW_SYSTEM_STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // Fall back to the legacy theme value when the separate preference is unavailable.
  }

  return theme === "system";
}

function isThemePreferenceMode(value: string | null): value is ThemePreferenceMode {
  return value === "light" || value === "dark" || value === "system";
}

export function readAppearanceModePreference(theme: Theme): ThemePreferenceMode {
  if (typeof window !== "undefined") {
    try {
      const raw = window.localStorage.getItem(THEME_APPEARANCE_MODE_STORAGE_KEY);
      if (isThemePreferenceMode(raw)) return raw;
    } catch {
      // Fall back to the legacy preference below when storage is unavailable.
    }
  }

  if (readStoredFollowSystem(theme)) return "system";
  return getThemePreferenceMode(theme) ?? "light";
}

function writeAppearanceModePreference(appearanceMode: ThemePreferenceMode): void {
  if (typeof window === "undefined") return;
  try {
    // The legacy follow-system flag is read-only migration input now; the
    // mode key is the single source of truth.
    window.localStorage.setItem(THEME_APPEARANCE_MODE_STORAGE_KEY, appearanceMode);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: THEME_APPEARANCE_MODE_STORAGE_KEY,
      cause,
    });
  }
}

export function readThemePreference(): Theme {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT.theme;
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(STORAGE_KEY);
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "read",
      storageKey: STORAGE_KEY,
      cause,
    });
  }
  if (raw !== null && isKnownThemePreference(raw)) {
    return canonicalThemePreference(raw);
  }
  return DEFAULT_THEME_SNAPSHOT.theme;
}

export function writeThemePreference(theme: Theme): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
    themeStorageReadFailure = null;
  } catch (cause) {
    throw new ThemeStorageError({
      operation: "write",
      storageKey: STORAGE_KEY,
      theme,
      cause,
    });
  }
}

function getStored(): Theme {
  if (themeStorageReadFailure !== null) {
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
  try {
    return readThemePreference();
  } catch (cause) {
    const error = isThemeStorageError(cause)
      ? cause
      : new ThemeStorageError({
          operation: "read",
          storageKey: STORAGE_KEY,
          cause,
        });
    themeStorageReadFailure = error;
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return DEFAULT_THEME_SNAPSHOT.theme;
  }
}

function ensureThemeColorMetaTag(): HTMLMetaElement {
  let element = document.querySelector<HTMLMetaElement>(DYNAMIC_THEME_COLOR_SELECTOR);
  if (element) {
    return element;
  }

  element = document.createElement("meta");
  element.name = THEME_COLOR_META_NAME;
  element.setAttribute("data-dynamic-theme-color", "true");
  document.head.append(element);
  return element;
}

function normalizeThemeColor(value: string | null | undefined): string | null {
  const normalizedValue = value?.trim().toLowerCase();
  if (
    !normalizedValue ||
    normalizedValue === "transparent" ||
    normalizedValue === "rgba(0, 0, 0, 0)" ||
    normalizedValue === "rgba(0 0 0 / 0)"
  ) {
    return null;
  }

  return value?.trim() ?? null;
}

function resolveBrowserChromeSurface(): HTMLElement {
  return (
    document.querySelector<HTMLElement>("main[data-slot='sidebar-inset']") ??
    document.querySelector<HTMLElement>("[data-slot='sidebar-inner']") ??
    document.body
  );
}

export function syncBrowserChromeTheme() {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return;
  const rootStyles = getComputedStyle(document.documentElement);
  const themeChromeColor = document.documentElement.dataset.themeId
    ? normalizeThemeColor(rootStyles.getPropertyValue("--app-chrome-background"))
    : null;
  const surfaceColor = normalizeThemeColor(
    getComputedStyle(resolveBrowserChromeSurface()).backgroundColor,
  );
  const fallbackColor = normalizeThemeColor(getComputedStyle(document.body).backgroundColor);
  const backgroundColor = themeChromeColor ?? surfaceColor ?? fallbackColor;
  if (!backgroundColor) return;

  document.documentElement.style.backgroundColor = backgroundColor;
  document.body.style.backgroundColor = backgroundColor;
  // Update every theme-color meta so any element another layer added (for
  // example a media-scoped one) carries the resolved color too.
  const themeColorMetas = document.querySelectorAll<HTMLMetaElement>(
    `meta[name="${THEME_COLOR_META_NAME}"]`,
  );
  if (themeColorMetas.length === 0) {
    ensureThemeColorMetaTag().setAttribute("content", backgroundColor);
    return;
  }
  for (const element of themeColorMetas) {
    element.setAttribute("content", backgroundColor);
  }
}

function applyTheme(theme: Theme, { suppressTransitions = false, preservePreview = true } = {}) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  applyUiModeAttribute(getUiMode());
  // Keep the editor's draft visible until an explicit refresh restores the selection.
  if (preservePreview && document.documentElement.dataset?.themeId === THEME_PREVIEW_ID) {
    return;
  }
  const appearanceMode = readAppearanceModePreference(theme);
  const followSystem = appearanceMode === "system";
  const systemDark = followSystem ? getSystemDark() : false;
  const themeHalves = readStoredThemeHalves();
  const harnessTheme = getActiveHarnessTheme();
  if (
    lastAppliedTheme?.theme === theme &&
    lastAppliedTheme.systemDark === systemDark &&
    lastAppliedTheme.followSystem === followSystem &&
    lastAppliedTheme.appearanceMode === appearanceMode &&
    themeHalvesSignature(lastAppliedTheme.themeHalves) === themeHalvesSignature(themeHalves) &&
    lastAppliedTheme.harnessTheme?.key === harnessTheme?.key
  ) {
    syncDesktopTheme(theme, followSystem, appearanceMode, lastDesktopThemeOverride);
    return;
  }

  if (suppressTransitions) {
    document.documentElement.classList.add("no-transitions");
  }
  const resolvedAppearance = resolveAppliedAppearance(
    theme,
    systemDark,
    appearanceMode,
    themeHalves,
    harnessTheme,
  );
  if (harnessTheme) {
    applyThemeDefinition(harnessTheme.definition, resolvedAppearance);
  } else {
    applyThemePalette(resolveThemeHalf(theme, themeHalves, resolvedAppearance), resolvedAppearance);
  }
  applyHarnessThemeView(document.documentElement, harnessTheme?.preset ?? null);
  document.documentElement.classList.toggle("dark", resolvedAppearance === "dark");
  lastAppliedTheme = { theme, systemDark, followSystem, appearanceMode, themeHalves, harnessTheme };
  lastDesktopThemeOverride = harnessDesktopTheme(harnessTheme, appearanceMode, resolvedAppearance);
  scheduleBrowserChromeSync();
  syncDesktopTheme(theme, followSystem, appearanceMode, lastDesktopThemeOverride);
  if (suppressTransitions) {
    // The class outlives the next frame's style update, which takes in the new
    // colors with it. A forced reflow here instead would restyle the whole app
    // in the middle of a chat switch, and again when the class went before paint.
    const suppression = ++transitionSuppression;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (suppression === transitionSuppression) {
          document.documentElement.classList.remove("no-transitions");
        }
      }),
    );
  }
}

let transitionSuppression = 0;
let browserChromeSyncPending = false;

/**
 * The browser's own chrome follows the theme in the next frame, still before
 * it paints. Reading the new colors back at once would restyle the whole app
 * while a chat switch is still laying out.
 */
function scheduleBrowserChromeSync() {
  if (typeof requestAnimationFrame !== "function") return syncBrowserChromeTheme();
  if (browserChromeSyncPending) return;
  browserChromeSyncPending = true;
  requestAnimationFrame(() => {
    browserChromeSyncPending = false;
    syncBrowserChromeTheme();
  });
}

export async function syncDesktopThemePreference(
  bridge: DesktopThemeBridge,
  theme: Theme,
  followSystem?: boolean,
  appearanceMode?: ThemePreferenceMode,
  halves: ThemeHalves | null = readStoredThemeHalves(),
  override?: DesktopTheme,
): Promise<void> {
  try {
    await bridge.setTheme(
      override ?? resolveDesktopTheme(theme, followSystem, appearanceMode, halves),
    );
  } catch (cause) {
    throw new DesktopThemeSyncError({ theme, cause });
  }
}

/** `override` is the appearance a harness look holds the shell to, if any. */
export function syncDesktopTheme(
  theme: Theme,
  followSystem?: boolean,
  appearanceMode?: ThemePreferenceMode,
  override?: DesktopTheme,
) {
  if (typeof window === "undefined") return;
  const bridge = window.desktopBridge;
  const halves = readStoredThemeHalves();
  const desktopTheme = override ?? resolveDesktopTheme(theme, followSystem, appearanceMode, halves);
  if (!bridge || typeof bridge.setTheme !== "function" || lastDesktopTheme === desktopTheme) {
    return;
  }

  lastDesktopTheme = desktopTheme;
  void syncDesktopThemePreference(
    bridge,
    theme,
    followSystem,
    appearanceMode,
    halves,
    override,
  ).catch((cause: unknown) => {
    const error = isDesktopThemeSyncError(cause)
      ? cause
      : new DesktopThemeSyncError({ theme, cause });
    console.error(error.message, {
      theme: error.theme,
      ...safeErrorLogAttributes(error),
    });
    if (lastDesktopTheme === desktopTheme) {
      lastDesktopTheme = null;
    }
  });
}

/** Remember a themed chat across reloads and restarts, so it reopens without a flash. */
function saveHarnessThemeBootHint() {
  const harnessTheme = lastAppliedTheme?.harnessTheme ?? null;
  writeHarnessThemeBootHint(
    harnessTheme && harnessClaim
      ? harnessThemeBootHint({
          route: harnessThemeBootRoute(window.location),
          driver: harnessClaim.driver,
          harnessTheme,
          appearance: document.documentElement.classList.contains("dark") ? "dark" : "light",
        })
      : null,
  );
}

// Apply immediately on module load to prevent flash
if (typeof document !== "undefined" && typeof window !== "undefined") {
  const restoredDriver = window.location
    ? readHarnessThemeBootDriver(harnessThemeBootRoute(window.location))
    : null;
  if (restoredDriver !== null) harnessClaim = { driver: restoredDriver, restored: true };
  applyTheme(getStored());
  window.addEventListener?.("pagehide", saveHarnessThemeBootHint);
}

function getSnapshot(): ThemeSnapshot {
  if (typeof window === "undefined") return DEFAULT_THEME_SNAPSHOT;
  // Reading the preference hits localStorage, so only recompute after a
  // change was signalled; useTheme consumers call this on every render.
  if (!snapshotStale && lastSnapshot) return lastSnapshot;
  snapshotStale = false;
  const theme = getStored();
  const appearanceMode = readAppearanceModePreference(theme);
  const followSystem = appearanceMode === "system";
  const systemDark = followSystem ? getSystemDark() : false;
  const themeHalves = readStoredThemeHalves();
  const harnessTheme = getActiveHarnessTheme();

  const resolvedTheme = resolveAppliedAppearance(
    theme,
    systemDark,
    appearanceMode,
    themeHalves,
    harnessTheme,
  );
  if (
    lastSnapshot &&
    lastSnapshot.theme === theme &&
    lastSnapshot.resolvedTheme === resolvedTheme &&
    lastSnapshot.systemDark === systemDark &&
    lastSnapshot.followSystem === followSystem &&
    lastSnapshot.appearanceMode === appearanceMode &&
    themeHalvesSignature(lastSnapshot.themeHalves) === themeHalvesSignature(themeHalves) &&
    lastSnapshot.harnessTheme?.key === harnessTheme?.key
  ) {
    return lastSnapshot;
  }

  lastSnapshot = {
    theme,
    resolvedTheme,
    systemDark,
    followSystem,
    appearanceMode,
    themeHalves,
    harnessTheme,
  };
  return lastSnapshot;
}

function getServerSnapshot() {
  return DEFAULT_THEME_SNAPSHOT;
}

function handleSystemAppearanceChange() {
  const storedTheme = getStored();
  if (readAppearanceModePreference(storedTheme) === "system") {
    applyTheme(storedTheme, { suppressTransitions: true });
  }
  emitChange();
}

function handleStorageChange(e: StorageEvent) {
  if (e.key === STORAGE_KEY) {
    themeStorageReadFailure = null;
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  } else if (e.key === THEME_FOLLOW_SYSTEM_STORAGE_KEY) {
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  } else if (e.key === THEME_APPEARANCE_MODE_STORAGE_KEY || e.key === THEME_HALVES_STORAGE_KEY) {
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  } else if (e.key === UI_MODE_STORAGE_KEY) {
    uiMode = null;
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  } else if (e.key === HARNESS_THEMES_STORAGE_KEY) {
    harnessThemeSettings = null;
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  } else if (e.key === CUSTOM_THEMES_STORAGE_KEY || e.key === null) {
    if (e.key === null) {
      themeStorageReadFailure = null;
      harnessThemeSettings = null;
    }
    invalidateCustomThemes();
    lastAppliedTheme = null;
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
  }
}

let removeWindowListeners: (() => void) | null = null;

function subscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  listeners.push(listener);

  // The system-preference and cross-tab listeners are shared by all
  // subscribers; each event applies the theme once and notifies everyone.
  if (!removeWindowListeners) {
    const mq = typeof window.matchMedia === "function" ? window.matchMedia(MEDIA_QUERY) : null;
    mq?.addEventListener("change", handleSystemAppearanceChange);
    window.addEventListener("storage", handleStorageChange);
    removeWindowListeners = () => {
      mq?.removeEventListener("change", handleSystemAppearanceChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }

  return () => {
    listeners = listeners.filter((l) => l !== listener);
    if (listeners.length === 0) {
      removeWindowListeners?.();
      removeWindowListeners = null;
    }
  };
}

export function useTheme() {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { theme, resolvedTheme } = snapshot;

  const setTheme = useCallback((next: Theme): boolean => {
    if (typeof window === "undefined") return false;
    try {
      // Preserve the current mode before replacing a legacy or inferred theme
      // preference. Otherwise a fresh System preference is re-inferred from
      // the new theme's base appearance, which can switch a dark UI to light.
      writeAppearanceModePreference(readAppearanceModePreference(getStored()));
      // Choosing a whole theme replaces any automatic-mode mix. The mix is
      // captured first so a failed preference write can put it back instead
      // of erasing it or leaving it attached to the new theme.
      const previousHalvesRaw = window.localStorage.getItem(THEME_HALVES_STORAGE_KEY);
      window.localStorage.removeItem(THEME_HALVES_STORAGE_KEY);
      try {
        writeThemePreference(next);
      } catch (cause) {
        if (previousHalvesRaw !== null) {
          try {
            window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, previousHalvesRaw);
          } catch {
            // Storage is failing wholesale; the outer handler reports it.
          }
        }
        throw cause;
      }
    } catch (cause) {
      const error = isThemeStorageError(cause)
        ? cause
        : new ThemeStorageError({
            operation: "write",
            storageKey: STORAGE_KEY,
            theme: next,
            cause,
          });
      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        theme: next,
        ...safeErrorLogAttributes(error),
      });
      return false;
    }
    applyTheme(next, { suppressTransitions: true });
    emitChange();
    return true;
  }, []);

  const setAppearanceMode = useCallback((nextAppearanceMode: ThemePreferenceMode): boolean => {
    if (typeof window === "undefined") return false;
    try {
      writeAppearanceModePreference(nextAppearanceMode);
    } catch (cause) {
      const error = isThemeStorageError(cause)
        ? cause
        : new ThemeStorageError({
            operation: "write",
            storageKey: THEME_APPEARANCE_MODE_STORAGE_KEY,
            cause,
          });
      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        ...safeErrorLogAttributes(error),
      });
      return false;
    }
    themeStorageReadFailure = null;
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
    return true;
  }, []);

  const setFollowSystem = useCallback(
    (nextFollowSystem: boolean): boolean => {
      const currentMode = readAppearanceModePreference(theme);
      const nextMode = nextFollowSystem
        ? "system"
        : currentMode === "system"
          ? (getThemePreferenceMode(theme) ?? "light")
          : currentMode;
      return setAppearanceMode(nextMode);
    },
    [setAppearanceMode, theme],
  );

  const setThemeHalf = useCallback(
    (appearance: ThemeAppearance, themeId: string | null): boolean => {
      if (typeof window === "undefined") return false;
      try {
        const current = readStoredThemeHalvesRaw();
        const next: { light?: string; dark?: string } = { ...current };
        if (themeId === null) delete next[appearance];
        else next[appearance] = themeId;
        if (next.light === undefined && next.dark === undefined) {
          window.localStorage.removeItem(THEME_HALVES_STORAGE_KEY);
        } else {
          window.localStorage.setItem(THEME_HALVES_STORAGE_KEY, JSON.stringify(next));
        }
      } catch (cause) {
        const error = new ThemeStorageError({
          operation: "write",
          storageKey: THEME_HALVES_STORAGE_KEY,
          cause,
        });
        console.error(error.message, {
          operation: error.operation,
          storageKey: error.storageKey,
          ...safeErrorLogAttributes(error),
        });
        return false;
      }
      applyTheme(getStored(), { suppressTransitions: true });
      emitChange();
      return true;
    },
    [],
  );

  const clearThemeHalves = useCallback((): boolean => {
    if (typeof window === "undefined") return false;
    try {
      window.localStorage.removeItem(THEME_HALVES_STORAGE_KEY);
    } catch (cause) {
      const error = new ThemeStorageError({
        operation: "write",
        storageKey: THEME_HALVES_STORAGE_KEY,
        cause,
      });
      console.error(error.message, {
        operation: error.operation,
        storageKey: error.storageKey,
        ...safeErrorLogAttributes(error),
      });
      return false;
    }
    applyTheme(getStored(), { suppressTransitions: true });
    emitChange();
    return true;
  }, []);

  const refreshTheme = useCallback(({ preservePreview = false } = {}) => {
    if (typeof window === "undefined") return;
    lastAppliedTheme = null;
    applyTheme(getStored(), { suppressTransitions: true, preservePreview });
    emitChange();
  }, []);

  // Keep DOM in sync on mount/change
  useEffect(() => {
    applyTheme(theme);
  }, [snapshot.appearanceMode, theme]);

  return {
    theme,
    setTheme,
    setAppearanceMode,
    setFollowSystem,
    setThemeHalf,
    clearThemeHalves,
    refreshTheme,
    followSystem: snapshot.followSystem,
    appearanceMode: snapshot.appearanceMode,
    resolvedTheme,
    themeHalves: snapshot.themeHalves,
    harnessTheme: snapshot.harnessTheme,
  } as const;
}

/** Re-apply after the harness claim or its settings moved; a no-op when the look is unchanged. */
function refreshHarnessTheme() {
  if (typeof window === "undefined") return;
  const previousKey = lastAppliedTheme?.harnessTheme?.key;
  applyTheme(getStored(), { suppressTransitions: true });
  if (lastAppliedTheme?.harnessTheme?.key !== previousKey) emitChange();
}

/**
 * Hand the window to a focused chat's harness until the returned release
 * runs. Applied synchronously, so a layout effect repaints before the browser
 * does. Release waits a microtask: when one chat hands over to the next in
 * the same commit, the user's own theme never paints in between.
 */
export function claimHarnessTheme(driver: string): () => void {
  const claim: HarnessClaim = { driver };
  harnessClaim = claim;
  refreshHarnessTheme();
  return () => releaseHarnessClaim(claim);
}

function releaseHarnessClaim(claim: HarnessClaim) {
  if (harnessClaim !== claim) return;
  harnessClaim = null;
  queueMicrotask(() => {
    if (harnessClaim === null) refreshHarnessTheme();
  });
}

/**
 * Wear the look assigned to this chat's harness while the chat is on screen.
 * `driver` is the resolved harness settings key, or null while still unknown.
 * That keeps the user's own theme, apart from a look restored at startup for
 * this very chat, which holds until the chat goes away.
 */
export function useHarnessThemeClaim(driver: string | null): void {
  useLayoutEffect(() => {
    if (driver !== null) return claimHarnessTheme(driver);
    const restored = harnessClaim?.restored ? harnessClaim : null;
    return restored ? () => releaseHarnessClaim(restored) : undefined;
  }, [driver]);
}

/**
 * Switch the whole app's layout on this device. Applies at once, without a
 * reload: the root `data-ui-mode` attribute, the mode's look and every
 * `useUiMode` subscriber follow in the same frame.
 */
export function setUiModePreference(next: UiMode): boolean {
  if (typeof window === "undefined") return false;
  try {
    setLocalStorageItem(UI_MODE_STORAGE_KEY, next, UiModeSchema);
  } catch (cause) {
    const error = new ThemeStorageError({
      operation: "write",
      storageKey: UI_MODE_STORAGE_KEY,
      cause,
    });
    console.error(error.message, {
      operation: error.operation,
      storageKey: error.storageKey,
      ...safeErrorLogAttributes(error),
    });
    return false;
  }
  uiMode = next;
  writeUiModeBootHint(next);
  applyTheme(getStored(), { suppressTransitions: true });
  emitChange();
  return true;
}

/** The layout this device shows: `default`, or `discord` for Discord mode. */
export function useUiMode() {
  const mode = useSyncExternalStore(subscribe, getUiMode, () => DEFAULT_UI_MODE);
  return [mode, setUiModePreference] as const;
}

export function useHarnessThemeSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getHarnessThemeSettings,
    () => DEFAULT_HARNESS_THEME_SETTINGS,
  );

  const updateSettings = useCallback(
    (update: (current: HarnessThemeSettings) => HarnessThemeSettings): boolean => {
      if (typeof window === "undefined") return false;
      const next = update(getHarnessThemeSettings());
      try {
        writeHarnessThemeSettings(next);
      } catch (cause) {
        const error = new ThemeStorageError({
          operation: "write",
          storageKey: HARNESS_THEMES_STORAGE_KEY,
          cause,
        });
        console.error(error.message, {
          operation: error.operation,
          storageKey: error.storageKey,
          ...safeErrorLogAttributes(error),
        });
        return false;
      }
      harnessThemeSettings = next;
      applyTheme(getStored(), { suppressTransitions: true });
      emitChange();
      return true;
    },
    [],
  );

  return { settings, updateSettings } as const;
}
