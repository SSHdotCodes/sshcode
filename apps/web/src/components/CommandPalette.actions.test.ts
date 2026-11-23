import { describe, expect, it, vi } from "vite-plus/test";
import { ChatWidth } from "@t3tools/contracts/settings";
import {
  buildLayoutActions,
  buildSettingsSectionActions,
  commandPaletteActionRegistry,
} from "./CommandPalette.actions";
import { filterCommandPaletteGroups } from "./CommandPalette.logic";
import { SETTINGS_SEARCH_ITEMS, SETTINGS_SECTION_LABELS } from "./settings/settingsSearch";

describe("palette settings actions", () => {
  it.each([
    ["new-design", "action:toggle-new-design", "action:chat-width"],
    ["chat-width", "action:chat-width", "action:toggle-new-design"],
  ])(
    "skips %s after its search ID is renamed and keeps the other layout action",
    (id, omitted, retained) => {
      const items = buildLayoutActions({
        settings: { chatWidth: "comfortable", redesignEnabled: false },
        icon: null,
        updateSettings: async () => {},
        searchItems: SETTINGS_SEARCH_ITEMS.map((item) =>
          item.id === id ? { ...item, id: `renamed-${id}` } : item,
        ),
      });
      const registry = commandPaletteActionRegistry(items);
      expect(registry.has(omitted)).toBe(false);
      expect(registry.has(retained)).toBe(true);
    },
  );

  it("omits layout actions when their search metadata is unavailable", () => {
    expect(
      buildLayoutActions({
        settings: { chatWidth: "comfortable", redesignEnabled: false },
        icon: null,
        updateSettings: async () => {},
        searchItems: [],
      }),
    ).toEqual([]);
  });

  it("covers every registered section when all settings are available", () => {
    const actions = buildSettingsSectionActions({
      availableItems: SETTINGS_SEARCH_ITEMS,
      icon: null,
      navigate: async () => {},
    });
    expect(actions.map((item) => item.value)).toEqual(
      Object.keys(SETTINGS_SECTION_LABELS).map((path) => `settings-section:${path}`),
    );
  });
  it("derives destinations and labels from available settings without unavailable sections", async () => {
    const navigate = vi.fn(async () => {});
    const items = buildSettingsSectionActions({
      availableItems: [
        { id: "theme", title: "Theme", to: "/settings/appearance" },
        { id: "width", title: "Chat width", to: "/settings/appearance" },
        { id: "keyboard", title: "Keyboard", to: "/settings/keybindings" },
      ],
      icon: null,
      navigate,
    });
    expect(items.map((item) => item.title)).toEqual([
      "Appearance settings",
      "Keybindings settings",
    ]);
    await items[1]?.run();
    expect(navigate).toHaveBeenCalledWith("/settings/keybindings");
  });

  it("offers every width in the contract and persists only client settings", async () => {
    const updateSettings = vi.fn(async () => {});
    const items = buildLayoutActions({
      settings: { chatWidth: "comfortable", redesignEnabled: false },
      icon: null,
      updateSettings,
    });
    const registry = commandPaletteActionRegistry(items);
    expect(ChatWidth.literals.every((width) => registry.has(`chat-width:${width}`))).toBe(true);
    const full = registry.get("chat-width:full");
    if (full?.kind === "action") await full.run();
    const redesign = registry.get("action:toggle-new-design");
    if (redesign?.kind === "action") await redesign.run();
    expect(updateSettings.mock.calls).toEqual([
      [{ chatWidth: "full" }],
      [{ redesignEnabled: true }],
    ]);
  });

  it("offers the reverse design toggle using the latest state", async () => {
    const updateSettings = vi.fn(async () => {});
    const item = buildLayoutActions({
      settings: { chatWidth: "full", redesignEnabled: true },
      icon: null,
      updateSettings,
    })[0];
    expect(item?.title).toBe("Turn off new design");
    if (item?.kind === "action") await item.run();
    expect(updateSettings).toHaveBeenCalledWith({ redesignEnabled: false });
  });

  it("finds an opt-in submenu choice directly in action-only search", () => {
    const items = buildLayoutActions({
      settings: { chatWidth: "comfortable", redesignEnabled: false },
      icon: null,
      updateSettings: async () => {},
    });
    const groups = filterCommandPaletteGroups({
      activeGroups: [{ value: "actions", label: "Actions", items }],
      query: ">chat width full",
      isInSubmenu: false,
      projectSearchItems: [],
      threadSearchItems: [],
    });
    expect(groups.flatMap((group) => group.items)[0]?.value).toBe("chat-width:full");
  });
});
