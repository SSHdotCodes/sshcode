import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { ChatTabsCommand, isChatTabEmoji } from "./chatTabs.ts";

const validCommand = Schema.is(Schema.toType(ChatTabsCommand));
describe("server icon inputs", () => {
  it.each(["🔧", "👩🏽‍💻", "🇺🇸", "1️⃣"])("accepts one emoji: %s", (emoji) => {
    expect(isChatTabEmoji(emoji)).toBe(true);
    expect(validCommand({ action: "set-icon", tab: "Build", icon: { kind: "emoji", emoji } })).toBe(
      true,
    );
  });
  it.each(["ab", "🔧🚀", "", "\n🔧", "<svg/>"])(
    "rejects non-emoji or multiple icons: %s",
    (emoji) => {
      expect(isChatTabEmoji(emoji)).toBe(false);
    },
  );
  it("rejects external URLs, file paths and oversized image uploads", () => {
    for (const icon of [
      { kind: "image", dataUrl: "https://example.invalid/icon.png" },
      { kind: "image", pixels: "/private/icon.png" },
      { kind: "image", pixels: "A".repeat(50_000) },
    ])
      expect(validCommand({ action: "set-icon", tab: "Build", icon })).toBe(false);
  });
});
