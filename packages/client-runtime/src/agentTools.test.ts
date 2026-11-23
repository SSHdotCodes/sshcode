import { ProviderInstanceId, type AgentToolPolicy } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  countProviderAgentToolOverrides,
  filterAgentToolDescriptors,
  replaceAgentToolPolicy,
  resetProviderAgentTools,
  resolveAgentToolSetting,
  setAllProviderAgentToolsEnabled,
  setGlobalAgentToolEnabled,
  setProviderAgentToolEnabled,
  setAgentToolGroupEnabled,
} from "./agentTools.ts";

const claude = ProviderInstanceId.make("claude");
const codex = ProviderInstanceId.make("codex");
const policy: AgentToolPolicy = {
  enabled: true,
  tools: { browser: false },
  providers: {
    [claude]: { enabled: false, tools: { browser: true } },
    [codex]: { tools: { search: false } },
  },
};

describe("agent tool policy editing", () => {
  it("resolves every inheritance level with SSHCode tools enabled by default", () => {
    expect(resolveAgentToolSetting(policy, "terminal", codex)).toEqual({
      enabled: true,
      source: "global-default",
    });
    expect(resolveAgentToolSetting(policy, "browser", codex)).toEqual({
      enabled: false,
      source: "global-tool",
    });
    expect(resolveAgentToolSetting(policy, "search", codex)).toEqual({
      enabled: false,
      source: "provider-tool",
    });
    expect(resolveAgentToolSetting(policy, "terminal", claude)).toEqual({
      enabled: false,
      source: "provider-default",
    });
    expect(resolveAgentToolSetting(policy, "browser", claude)).toEqual({
      enabled: true,
      source: "provider-tool",
    });
  });

  it("changes one global default without removing provider exceptions", () => {
    const original = structuredClone(policy);
    const next = setGlobalAgentToolEnabled(policy, "browser", true);
    expect(next.tools).toEqual({ browser: true });
    expect(next.providers).toEqual(original.providers);
    expect(policy).toEqual(original);
    expect(resolveAgentToolSetting(next, "browser", claude).enabled).toBe(true);
    expect(resolveAgentToolSetting(next, "browser", codex).enabled).toBe(true);
  });

  it("changes a complete tool group in one scope without changing unrelated tools or providers", () => {
    const tools = [{ name: "browser" }, { name: "snapshot" }];
    const global = setAgentToolGroupEnabled(policy, tools, false);
    expect(global.providers).toEqual(policy.providers);
    expect(resolveAgentToolSetting(global, "snapshot").enabled).toBe(false);
    expect(resolveAgentToolSetting(global, "search").enabled).toBe(true);
    const scoped = setAgentToolGroupEnabled(policy, tools, false, claude);
    expect(resolveAgentToolSetting(scoped, "browser", claude).enabled).toBe(false);
    expect(resolveAgentToolSetting(scoped, "snapshot", claude).enabled).toBe(false);
    expect(scoped.tools).toEqual(policy.tools);
    expect(scoped.providers[codex]).toEqual(policy.providers[codex]);
  });

  it("changes one provider tool without discarding its provider default", () => {
    const next = setProviderAgentToolEnabled(policy, claude, "search", true);
    expect(next.providers[claude]).toEqual({
      enabled: false,
      tools: { browser: true, search: true },
    });
    expect(next.providers[codex]).toEqual(policy.providers[codex]);
    expect(next.tools).toEqual(policy.tools);
  });

  it("replaces the entire policy for global bulk actions", () => {
    expect(replaceAgentToolPolicy(false)).toEqual({ enabled: false, tools: {}, providers: {} });
    expect(replaceAgentToolPolicy(true)).toEqual({ enabled: true, tools: {}, providers: {} });
  });

  it("replaces only the selected provider entry for provider bulk actions", () => {
    const next = setAllProviderAgentToolsEnabled(policy, claude, true);
    expect(next).toEqual({
      ...policy,
      providers: {
        ...policy.providers,
        [claude]: { enabled: true, tools: {} },
      },
    });
    expect(next.providers[codex]).toEqual(policy.providers[codex]);
  });

  it("resets only one provider back to global inheritance", () => {
    const next = resetProviderAgentTools(policy, claude);
    expect(next.providers[claude]).toBeUndefined();
    expect(next.providers[codex]).toEqual(policy.providers[codex]);
    expect(resolveAgentToolSetting(next, "browser", claude)).toEqual({
      enabled: false,
      source: "global-tool",
    });
  });

  it("counts overrides only for live provider choices", () => {
    expect(countProviderAgentToolOverrides(policy, "browser", [claude, codex])).toBe(1);
    expect(countProviderAgentToolOverrides(policy, "browser", [codex])).toBe(0);
    expect(countProviderAgentToolOverrides(policy, "search", [claude, codex])).toBe(2);
    expect(countProviderAgentToolOverrides(policy, "terminal", [claude, codex])).toBe(1);
  });
});

describe("agent tool search", () => {
  const tools = [
    {
      name: "browser_open",
      title: "Open browser",
      description: "Open a page in the built-in browser.",
      group: "Browser",
      readonly: false,
    },
    {
      name: "terminal_run",
      title: "Run terminal command",
      description: "Run a shell command.",
      group: "Terminal",
      readonly: false,
    },
  ];

  it("matches every query word across names, descriptions, and groups", () => {
    expect(filterAgentToolDescriptors(tools, "  BROWSER   page ").map((tool) => tool.name)).toEqual(
      ["browser_open"],
    );
    expect(filterAgentToolDescriptors(tools, "terminal shell").map((tool) => tool.name)).toEqual([
      "terminal_run",
    ]);
    expect(filterAgentToolDescriptors(tools, "missing")).toEqual([]);
  });

  it("keeps server order and does not mutate the catalog", () => {
    expect(filterAgentToolDescriptors(tools, "")).toEqual(tools);
    expect(filterAgentToolDescriptors(tools, "o").map((tool) => tool.name)).toEqual([
      "browser_open",
      "terminal_run",
    ]);
  });
});
