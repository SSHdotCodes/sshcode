import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, SharedKeyId } from "@t3tools/contracts";

import { sharedKeyIdForLabel, sharedKeyUsers } from "./SharedKeysSettings";

describe("sharedKeyIdForLabel", () => {
  it("slugs the label and avoids existing ids", () => {
    expect(sharedKeyIdForLabel("OpenRouter", [])).toBe("openrouter");
    expect(sharedKeyIdForLabel("OpenCode Go!", [])).toBe("opencode-go");
    expect(sharedKeyIdForLabel("OpenRouter", ["openrouter", "openrouter-2"])).toBe("openrouter-3");
    expect(sharedKeyIdForLabel("🔑", [])).toBe("key");
  });
});

describe("sharedKeyUsers", () => {
  it("lists each instance that links a key once, by display name", () => {
    const link = (name: string, key: string) => ({
      name,
      value: "",
      sensitive: true,
      sharedKey: SharedKeyId.make(key),
    });
    const users = sharedKeyUsers({
      [ProviderInstanceId.make("pi_open")]: {
        driver: ProviderDriverKind.make("pi"),
        displayName: "Pi · Open models",
        environment: [link("A", "openrouter"), link("B", "openrouter"), link("C", "opencode-go")],
      },
      [ProviderInstanceId.make("hermes_open")]: {
        driver: ProviderDriverKind.make("acpRegistry"),
        environment: [link("OPENROUTER_API_KEY", "openrouter")],
      },
      [ProviderInstanceId.make("codex")]: { driver: ProviderDriverKind.make("codex") },
    });
    expect(users.get("openrouter")).toEqual(["Pi · Open models", "hermes_open"]);
    expect(users.get("opencode-go")).toEqual(["Pi · Open models"]);
    expect(users.has("codex")).toBe(false);
  });
});
