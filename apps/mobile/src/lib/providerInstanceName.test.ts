import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerAcpInstanceName, providerInstanceNameLabel } from "./providerInstanceName";

const acp = ProviderDriverKind.make("acpRegistry");

describe("providerInstanceNameLabel", () => {
  it("names a badged local ACP agent that has no official icon", () => {
    expect(
      providerInstanceNameLabel({
        provider: "acpRegistry",
        iconUrl: null,
        displayName: "Local Agent",
        showBadge: true,
      }),
    ).toBe("Local Agent");
  });

  it("leaves official icons and other drivers unlabeled", () => {
    expect(
      providerInstanceNameLabel({
        provider: "acpRegistry",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/codex.svg",
        displayName: "Codex",
        showBadge: true,
      }),
    ).toBeNull();
    expect(
      providerInstanceNameLabel({
        provider: "codex",
        displayName: "Codex Work",
        showBadge: true,
      }),
    ).toBeNull();
    expect(
      providerInstanceNameLabel({
        provider: "acpRegistry",
        displayName: "Only Agent",
        showBadge: false,
      }),
    ).toBeNull();
  });
});

describe("composerAcpInstanceName", () => {
  const providers = [
    {
      instanceId: ProviderInstanceId.make("acpRegistry_local"),
      driver: acp,
      displayName: "Local Agent",
      enabled: true,
      installed: true,
    },
    {
      instanceId: ProviderInstanceId.make("acpRegistry_other"),
      driver: acp,
      displayName: "Other Agent",
      enabled: true,
      installed: true,
    },
  ];

  it("marks only the added local ACP account when neither has the default id", () => {
    expect(
      composerAcpInstanceName({
        providerDriver: "acpRegistry",
        providerLabel: "Local Agent",
        instanceId: "acpRegistry_local",
        providers,
      }),
    ).toBeNull();
    expect(
      composerAcpInstanceName({
        providerDriver: "acpRegistry",
        providerLabel: "Other Agent",
        instanceId: "acpRegistry_other",
        providers,
      }),
    ).toBe("Other Agent");
  });
});
