import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

vi.mock("./ProviderInstanceIcon", () => ({
  ProviderInstanceIcon: (props: {
    readonly acpRegistryAgentId?: string;
    readonly acpRegistryIconUrl?: string;
    readonly displayName: string;
  }) => (
    <span
      data-agent-id={props.acpRegistryAgentId ?? ""}
      data-display-name={props.displayName}
      data-icon-url={props.acpRegistryIconUrl ?? ""}
    />
  ),
}));

function provider(name: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(name.toLowerCase()),
    driver: ProviderDriverKind.make("acpRegistry"),
    displayName: `${name} agent`,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: [
      { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
    ],
    slashCommands: [],
    skills: [],
  };
}

describe("ProviderModelPicker registry icons", () => {
  it("keeps each ACP agent logo in a multi-model selection", () => {
    const iconUrl = "https://cdn.agentclientprotocol.com/registry/icons/picker-explicit.svg";
    const entries = deriveProviderInstanceEntries([provider("First"), provider("Second")]).map(
      (entry, index) =>
        index === 0
          ? { ...entry, acpRegistryIconUrl: iconUrl }
          : { ...entry, acpRegistryAgentId: "picker-by-id" },
    );
    const markup = renderToStaticMarkup(
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={entries[0]!.instanceId}
        model="first"
        selectedModels={entries.map((entry) => ({
          instanceId: entry.instanceId,
          model: entry.instanceId,
        }))}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
        onInstanceModelChange={() => {}}
      />,
    );

    expect(markup).toContain(`data-icon-url="${iconUrl}"`);
    expect(markup).toContain('data-agent-id="picker-by-id"');
    expect(markup).toContain('data-display-name="First agent"');
    expect(markup).toContain('data-display-name="Second agent"');
  });
});
