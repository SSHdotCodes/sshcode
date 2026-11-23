import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProviderInstanceAcpRegistryIconUrl } from "./ProviderInstanceIcon";

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });

  it("leaves Antigravity to its own Gemini mark, even with a registry icon", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("antigravity"),
        iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/antigravity-acp.svg",
      }),
    ).toBeNull();
  });

  it("does not resolve registry icons for other provider drivers by agent id", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("codex"),
        agentId: "kilo",
      }),
    ).toBeNull();
  });

  it("draws a configured registry icon on another driver, official URLs only", () => {
    const claude = ProviderDriverKind.make("claudeAgent");
    const qwen = "https://cdn.agentclientprotocol.com/registry/v1/latest/qwen-code.svg";
    expect(resolveProviderInstanceAcpRegistryIconUrl({ driverKind: claude, iconUrl: qwen })).toBe(
      qwen,
    );
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: claude,
        iconUrl: "https://example.com/qwen.svg",
      }),
    ).toBeNull();
  });
});
