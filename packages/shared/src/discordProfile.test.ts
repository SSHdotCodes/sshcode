import { describe, expect, it } from "vite-plus/test";
import {
  discordAvatarIdentity,
  profileCrop,
  profileImage,
  PROFILE_IMAGE_MAX_LENGTH,
} from "./discordProfile.ts";
import { harnessMascotForDriver } from "./harnessMascots.ts";

describe("Discord avatars", () => {
  it.each([
    ["codex", "codex"],
    ["claudeAgent", "claude"],
    ["cursor", "cursor"],
    ["grok", "grok"],
    ["opencode", "opencode"],
    ["antigravity", "gemini"],
    ["muse", "muse"],
    ["pi", "pi"],
    ["unknown", "acp"],
    [null, "acp"],
  ])("resolves the idle mascot for %s", (driver, expected) => {
    const identity = discordAvatarIdentity({ driver });
    expect(harnessMascotForDriver(identity.driver, identity.agentId)?.id).toBe(expected);
  });
  it("gives unthemed models the generic buddy and registry models their configured mascot", () => {
    const generic = discordAvatarIdentity({
      driver: "claudeAgent",
      instanceId: "studio-host",
      model: "private-local-model",
    });
    expect(harnessMascotForDriver(generic.driver, generic.agentId)?.id).toBe("acp");
    const registry = discordAvatarIdentity({ driver: "acpRegistry", agentId: "kimi-code" });
    expect(harnessMascotForDriver(registry.driver, registry.agentId)?.id).toBe("kimi");
  });
});
describe("local profile images", () => {
  it("accepts bounded raster data and rejects remote URLs, SVG and malformed data", () => {
    expect(profileImage("data:image/png;base64,aGVsbG8=")).toBe("data:image/png;base64,aGVsbG8=");
    expect(profileImage("data:image/jpeg;base64,aGVsbG8=")).not.toBeNull();
    for (const value of [
      null,
      "https://example.test/picture.png",
      "data:image/svg+xml;base64,aGVsbG8=",
      "data:image/png;base64,!!!",
      "data:image/png;base64," + "a".repeat(PROFILE_IMAGE_MAX_LENGTH),
    ])
      expect(profileImage(value)).toBeNull();
  });
  it("crops portrait and landscape images around the center before resizing", () => {
    expect(profileCrop(800, 600)).toEqual({ originX: 100, originY: 0, width: 600, height: 600 });
    expect(profileCrop(600, 800)).toEqual({ originX: 0, originY: 100, width: 600, height: 600 });
  });
});
