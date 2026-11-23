import { describe, expect, it } from "vite-plus/test";
import {
  compileResolvedKeybindingsConfig,
  DEFAULT_RESOLVED_KEYBINDINGS,
  mergeWithDefaultKeybindings,
} from "./keybindings.ts";

describe("prompt shortcut compatibility", () => {
  it("fills prompt navigation defaults from older servers while retaining custom bindings", () => {
    const older = DEFAULT_RESOLVED_KEYBINDINGS.filter(
      (binding) =>
        binding.command !== "chat.previousPrompt" && binding.command !== "chat.nextPrompt",
    );
    const custom = compileResolvedKeybindingsConfig([
      { key: "ctrl+shift+p", command: "chat.previousPrompt" },
    ]);
    const merged = mergeWithDefaultKeybindings([...older, ...custom]);
    expect(merged.filter((binding) => binding.command === "chat.previousPrompt")).toEqual(custom);
    expect(merged.find((binding) => binding.command === "chat.nextPrompt")?.shortcut).toMatchObject(
      { key: "arrowdown", modKey: true, altKey: true },
    );
  });
});
