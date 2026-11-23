import { describe, expect, it } from "vite-plus/test";
import { compileResolvedKeybindingsConfig } from "@t3tools/shared/keybindings";
import { formatShortcutLabel, resolveShortcutCommand } from "../keybindings";
import {
  buildKeyboardShortcutGroups,
  isKeyboardShortcutsHelpEvent,
} from "./KeyboardShortcuts.logic";

describe("live keyboard shortcut reference", () => {
  const rows = (query = "", isDesktop = false) =>
    buildKeyboardShortcutGroups({
      keybindings: compileResolvedKeybindingsConfig([
        { key: "mod+k", command: "chat.new" },
        { key: "mod+k", command: "commandPalette.toggle" },
        { key: "mod+d", command: "diff.toggle", when: "!terminalFocus" },
        { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
        { key: "mod+1", command: "thread.jump.1", when: "isDesktop && !modelPickerOpen" },
        { key: "ctrl+alt+space", command: "composer.stash" },
      ]),
      query,
      isDesktop,
      platform: "MacIntel",
    }).flatMap((group) => group.rows);

  it("shows the live winning binding and preserves distinct keyboard contexts", () => {
    expect(rows().map((row) => row.command)).toEqual([
      "commandPalette.toggle",
      "composer.stash",
      "diff.toggle",
      "terminal.split",
    ]);
    expect(rows().find((row) => row.command === "terminal.split")?.when).toBe("terminalFocus");
  });

  it("only lists bindings available on this client surface", () => {
    expect(rows("jump", false)).toHaveLength(0);
    expect(rows("jump", true).map((row) => row.command)).toEqual(["thread.jump.1"]);
  });

  it("searches labels, commands, conditions and canonical custom key strings", () => {
    expect(rows("terminal split").map((row) => row.command)).toEqual(["terminal.split"]);
    expect(rows("!terminalFocus").map((row) => row.command)).toEqual(["diff.toggle"]);
    expect(rows("ctrl+alt+space").map((row) => row.command)).toEqual(["composer.stash"]);
    const shortcut = rows("stash")[0]!.shortcut;
    expect(formatShortcutLabel(shortcut, "MacIntel")).toBe("⌃⌥Space");
    expect(formatShortcutLabel(shortcut, "Win32")).toBe("Ctrl+Alt+Space");
  });

  it("updates when custom bindings change, including keys removed from the reference", () => {
    const config = compileResolvedKeybindingsConfig([{ key: "mod+alt+g", command: "chat.new" }]);
    const groups = buildKeyboardShortcutGroups({
      keybindings: config,
      query: "new",
      platform: "Win32",
      isDesktop: false,
    });
    expect(
      groups
        .flatMap((group) => group.rows)
        .map((row) => formatShortcutLabel(row.shortcut, "Win32")),
    ).toEqual(["Ctrl+Alt+G"]);
  });

  it("does not advertise a binding hidden by a later unconditional rule", () => {
    const groups = buildKeyboardShortcutGroups({
      keybindings: compileResolvedKeybindingsConfig([
        { key: "mod+d", command: "terminal.split", when: "terminalFocus" },
        { key: "mod+d", command: "diff.toggle" },
      ]),
      query: "",
      platform: "MacIntel",
      isDesktop: false,
    });
    expect(groups.flatMap((group) => group.rows).map((row) => row.command)).toEqual([
      "diff.toggle",
    ]);
  });
});

describe("shortcut reference help chord", () => {
  const event = {
    key: "?",
    code: "Slash",
    shiftKey: true,
    metaKey: true,
    ctrlKey: false,
    altKey: false,
  };
  it("uses the primary platform modifier and requires shift", () => {
    expect(isKeyboardShortcutsHelpEvent(event, "MacIntel")).toBe(true);
    expect(isKeyboardShortcutsHelpEvent({ ...event, shiftKey: false }, "MacIntel")).toBe(false);
    expect(isKeyboardShortcutsHelpEvent(event, "Win32")).toBe(false);
    expect(isKeyboardShortcutsHelpEvent({ ...event, metaKey: false, ctrlKey: true }, "Win32")).toBe(
      true,
    );
  });
  it("allows a configured command to own the help chord", () => {
    expect(
      resolveShortcutCommand(
        event,
        compileResolvedKeybindingsConfig([{ key: "mod+shift+/", command: "chat.new" }]),
        { platform: "MacIntel" },
      ),
    ).toBe("chat.new");
  });
});
