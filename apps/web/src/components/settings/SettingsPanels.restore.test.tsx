import { DEFAULT_UNIFIED_SETTINGS, type UnifiedSettings } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const state = vi.hoisted(() => ({
  settings: null as UnifiedSettings | null,
  update: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
  };
});

vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

vi.mock("../../hooks/useTheme", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../hooks/useTheme")>()),
  useTheme: () => ({
    theme: "system",
    followSystem: true,
    themeHalves: null,
    setTheme: vi.fn(),
    setFollowSystem: vi.fn(),
    setThemeHalf: vi.fn(),
    clearThemeHalves: vi.fn(),
  }),
  readThemePreference: () => "system",
  readThemeHalves: () => null,
  readAppearanceModePreference: () => "system",
}));

vi.mock("./useScopedSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useScopedSettings")>()),
  useScopedSettings: () => state.settings,
  useUpdateScopedSettings: () => state.update,
}));

vi.mock("../../localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../localApi")>()),
  readLocalApi: () => ({ dialogs: { confirm: state.confirm } }),
}));

import { useSettingsRestore } from "./SettingsPanels";

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS };
  state.confirm.mockResolvedValue(true);
});

describe("restoring V2 settings", () => {
  it.each([
    ["chatBackdropEnabled", "Chat backdrop"],
    ["persistComposerContextStrip", "Composer context"],
    ["autoResumeLimitedThreads", "Continue stopped chats"],
    ["snoozeLimitedThreads", "Snooze limited chats"],
  ] as const)("restores %s when it is the only changed setting", async (key, label) => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, [key]: true };
    hooks.beginRender();
    const restore = useSettingsRestore();

    expect(restore.changedSettingLabels).toEqual([label]);
    await restore.restoreDefaults();

    expect(state.confirm.mock.calls[0]?.[0]).toContain(label);
    expect(state.update).toHaveBeenCalledOnce();
    expect(state.update.mock.calls[0]?.[0][key]).toBe(DEFAULT_UNIFIED_SETTINGS[key]);
  });

  it("restores the new chat dashboard after it was turned off", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, newChatDashboardEnabled: false };
    hooks.beginRender();
    const restore = useSettingsRestore();

    expect(restore.changedSettingLabels).toEqual(["New chat dashboard"]);
    await restore.restoreDefaults();

    expect(state.update.mock.calls[0]?.[0].newChatDashboardEnabled).toBe(true);
  });

  it("restores the sidebar peek after it was turned off", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, sidebarPeekEnabled: false };
    hooks.beginRender();
    const restore = useSettingsRestore();

    expect(restore.changedSettingLabels).toEqual(["Sidebar peek"]);
    await restore.restoreDefaults();

    expect(state.update.mock.calls[0]?.[0].sidebarPeekEnabled).toBe(true);
  });

  it("restores the menu bar status after it was turned off", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, menuBarStatusEnabled: false };
    hooks.beginRender();
    const restore = useSettingsRestore();

    expect(restore.changedSettingLabels).toEqual(["Menu bar status"]);
    await restore.restoreDefaults();

    expect(state.update.mock.calls[0]?.[0].menuBarStatusEnabled).toBe(true);
  });

  it("restores keeping the computer awake after it was turned off", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, keepAwakeWhileWorking: false };
    hooks.beginRender();
    const restore = useSettingsRestore();

    expect(restore.changedSettingLabels).toEqual(["Keep awake while agents work"]);
    await restore.restoreDefaults();

    expect(state.update.mock.calls[0]?.[0].keepAwakeWhileWorking).toBe(true);
  });

  it("does not reset settings after cancellation", async () => {
    state.settings = { ...DEFAULT_UNIFIED_SETTINGS, autoResumeLimitedThreads: true };
    state.confirm.mockResolvedValue(false);
    hooks.beginRender();

    await useSettingsRestore().restoreDefaults();

    expect(state.confirm).toHaveBeenCalledOnce();
    expect(state.update).not.toHaveBeenCalled();
  });
});
