import {
  isAgentToolEnabled,
  type AgentToolsState,
  type AgentToolPolicy,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerSettings,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "./connection/registry.ts";
import { createEnvironmentCommand, createEnvironmentRpcQueryAtomFamily } from "./state/runtime.ts";

type AgentToolDescriptor = AgentToolsState["tools"][number];

/** Settings explain the capability; the catalog keeps full instructions for search. */
export function agentToolSummary(description: string) {
  const first = (description.match(/^[\s\S]*?[.!?](?=\s|$)/)?.[0] ?? description).trim();
  const chars = Array.from(first);
  if (chars.length <= 180) return first;
  const prefix = chars.slice(0, 180).join("");
  const space = prefix.lastIndexOf(" ");
  return `${prefix.slice(0, space > 100 ? space : prefix.length).trimEnd()}…`;
}

export type AgentToolSettingSource =
  | "provider-tool"
  | "provider-default"
  | "global-tool"
  | "global-default";

export interface AgentToolSetting {
  readonly enabled: boolean;
  readonly source: AgentToolSettingSource;
}

export function resolveAgentToolSetting(
  policy: AgentToolPolicy,
  tool: string,
  provider?: ProviderInstanceId,
): AgentToolSetting {
  const providerPolicy = provider === undefined ? undefined : policy.providers[provider];
  const source =
    providerPolicy?.tools[tool] !== undefined
      ? "provider-tool"
      : providerPolicy?.enabled !== undefined
        ? "provider-default"
        : policy.tools[tool] !== undefined
          ? "global-tool"
          : "global-default";
  return { enabled: isAgentToolEnabled(policy, tool, provider), source };
}

export function setGlobalAgentToolEnabled(
  policy: AgentToolPolicy,
  tool: string,
  enabled: boolean,
): AgentToolPolicy {
  return { ...policy, tools: { ...policy.tools, [tool]: enabled } };
}

export function setProviderAgentToolEnabled(
  policy: AgentToolPolicy,
  provider: ProviderInstanceId,
  tool: string,
  enabled: boolean,
): AgentToolPolicy {
  const providerPolicy = policy.providers[provider];
  return {
    ...policy,
    providers: {
      ...policy.providers,
      [provider]: {
        ...(providerPolicy?.enabled !== undefined ? { enabled: providerPolicy.enabled } : {}),
        tools: { ...providerPolicy?.tools, [tool]: enabled },
      },
    },
  };
}

export function replaceAgentToolPolicy(enabled: boolean): AgentToolPolicy {
  return { enabled, tools: {}, providers: {} };
}

export function setAllProviderAgentToolsEnabled(
  policy: AgentToolPolicy,
  provider: ProviderInstanceId,
  enabled: boolean,
): AgentToolPolicy {
  return {
    ...policy,
    providers: {
      ...policy.providers,
      [provider]: { enabled, tools: {} },
    },
  };
}

export function resetProviderAgentTools(
  policy: AgentToolPolicy,
  provider: ProviderInstanceId,
): AgentToolPolicy {
  const providers = { ...policy.providers };
  delete providers[provider];
  return { ...policy, providers };
}

export function setAgentToolGroupEnabled(
  policy: AgentToolPolicy,
  tools: ReadonlyArray<{ readonly name: string }>,
  enabled: boolean,
  provider?: ProviderInstanceId,
): AgentToolPolicy {
  return tools.reduce(
    (next, tool) =>
      provider === undefined
        ? setGlobalAgentToolEnabled(next, tool.name, enabled)
        : setProviderAgentToolEnabled(next, provider, tool.name, enabled),
    policy,
  );
}

export function groupAgentToolDescriptors(tools: ReadonlyArray<AgentToolDescriptor>) {
  const groups = new Map<string, AgentToolDescriptor[]>();
  for (const tool of tools) {
    const group = groups.get(tool.group) ?? [];
    group.push(tool);
    groups.set(tool.group, group);
  }
  return groups;
}

export function countProviderAgentToolOverrides(
  policy: AgentToolPolicy,
  tool: string,
  providers: ReadonlyArray<ProviderInstanceId>,
): number {
  return providers.filter((provider) => {
    const providerPolicy = policy.providers[provider];
    return providerPolicy?.enabled !== undefined || providerPolicy?.tools[tool] !== undefined;
  }).length;
}

export function filterAgentToolDescriptors(
  tools: ReadonlyArray<AgentToolDescriptor>,
  query: string,
): AgentToolDescriptor[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...tools];
  return tools.filter((tool) => {
    const fields = [tool.title, tool.name, tool.description, tool.group].map((field) =>
      field.toLowerCase(),
    );
    return tokens.every((token) => fields.some((field) => field.includes(token)));
  });
}

export function createAgentToolsAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, E>,
  options: {
    readonly settingsValueAtom: (environmentId: EnvironmentId) => Atom.Atom<ServerSettings | null>;
  },
) {
  const policyRefreshFamily = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(options.settingsValueAtom(environmentId))?.agentToolPolicy),
  );
  const state = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:agent-tools:state",
    tag: WS_METHODS.serverGetAgentTools,
    staleTimeMs: 60_000,
    refreshTrigger: ({ environmentId }) => policyRefreshFamily(environmentId),
  });
  return {
    state,
    // Keep a settings write locked until a new catalog read has replaced any
    // older in-flight response. Failed refreshes retain the acknowledged policy.
    refresh: createEnvironmentCommand(runtime, {
      label: "environment-data:agent-tools:refresh",
      execute: (_input: Record<string, never>, registry, environmentId) =>
        Effect.suspend(() => {
          const atom = state({ environmentId, input: {} });
          registry.refresh(atom);
          return AtomRegistry.getResult(registry, atom, { suspendOnWaiting: true });
        }),
    }),
  };
}
