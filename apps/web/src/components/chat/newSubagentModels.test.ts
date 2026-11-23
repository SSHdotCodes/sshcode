import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { newSubagentCandidates } from "./newSubagentModels";

function provider(
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; name: string; isLegacy?: boolean }>,
  extra: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make(driver),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-17T00:00:00.000Z",
    models: models.map((model) => ({ ...model, isCustom: false, capabilities: {} })),
    slashCommands: [],
    skills: [],
    ...extra,
  };
}

const now = Date.parse("2026-11-17T12:00:00.000Z");
const at = (hoursAgo: number) => DateTime.makeUnsafe(now - hoursAgo * 60 * 60 * 1000);

function subagent(
  instanceId: string,
  model: string,
  hoursAgo: number,
  extra: { origin?: "app_owned" | "provider_native"; effort?: string } = {},
) {
  return {
    origin: extra.origin ?? ("app_owned" as const),
    providerInstanceId: ProviderInstanceId.make(instanceId),
    model,
    modelSelection: {
      instanceId: ProviderInstanceId.make(instanceId),
      model,
      ...(extra.effort ? { options: [{ id: "reasoningEffort", value: extra.effort }] } : {}),
    },
    startedAt: at(hoursAgo),
    updatedAt: at(hoursAgo),
  };
}

const chats = (instanceId: string, model: string, count: number) =>
  Array.from({ length: count }, (_, index) => ({
    createdBy: "user",
    createdAt: now - index * 60 * 60 * 1000,
    modelSelection: { instanceId, model },
  }));

const codex = provider("codex", "codex", [
  { slug: "gpt-6.2-sol", name: "GPT-6.2 Sol" },
  { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", isLegacy: true },
]);
const claude = provider("claudeAgent", "claudeAgent", [
  { slug: "claude-fable-5-2", name: "Fable 5.2" },
  { slug: "claude-sonnet-5-5", name: "Sonnet 5.5" },
]);

describe("newSubagentCandidates", () => {
  it("offers this chat's subagent models first, then the models chats start on", () => {
    const candidates = newSubagentCandidates({
      providers: [claude, codex],
      settings: DEFAULT_UNIFIED_SETTINGS,
      subagents: [
        subagent("codex", "gpt-6.2-sol", 1, { effort: "xhigh" }),
        subagent("codex", "gpt-6.2-sol", 2, { effort: "xhigh" }),
        // A subagent the provider started by itself says nothing about the user's picks.
        subagent("claudeAgent", "claude-sonnet-5-5", 1, { origin: "provider_native" }),
      ],
      history: chats("claudeAgent", "claude-fable-5-2", 6),
      now,
    });
    expect(candidates.map((candidate) => candidate.label)).toEqual([
      "GPT-6.2 Sol · xhigh",
      "Fable 5.2",
    ]);
    expect(candidates[0]?.options).toEqual([{ id: "reasoningEffort", value: "xhigh" }]);
  });

  it("leaves out a retired model, a hidden model and a provider that is not ready", () => {
    const candidates = newSubagentCandidates({
      providers: [
        codex,
        claude,
        provider("grok", "grok", [{ slug: "grok-4.7", name: "Grok 4.7" }], { status: "error" }),
      ],
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerModelPreferences: {
          [ProviderInstanceId.make("claudeAgent")]: {
            hiddenModels: ["claude-sonnet-5-5"],
            modelOrder: [],
          },
        },
      },
      subagents: [
        subagent("codex", "gpt-6.1-sol", 1),
        subagent("claudeAgent", "claude-sonnet-5-5", 1),
        subagent("grok", "grok-4.7", 1),
        subagent("claudeAgent", "claude-fable-5-2", 3),
      ],
      history: [],
      now,
    });
    expect(candidates.map((candidate) => candidate.label)).toEqual(["Fable 5.2"]);
  });

  it("never offers a release a newer one replaced, however much the chat used it", () => {
    const candidates = newSubagentCandidates({
      providers: [
        provider("codex", "codex", [
          { slug: "gpt-6.2-sol", name: "GPT-6.2 Sol" },
          { slug: "gpt-6.1-sol", name: "GPT-6.1 Sol" },
        ]),
        claude,
      ],
      settings: DEFAULT_UNIFIED_SETTINGS,
      subagents: [
        subagent("codex", "gpt-6.1-sol", 1),
        subagent("codex", "gpt-6.1-sol", 2),
        subagent("codex", "gpt-6.1-sol", 3),
        subagent("codex", "gpt-6.2-sol", 4, { effort: "xhigh" }),
      ],
      history: chats("claudeAgent", "claude-fable-5-2", 3),
      now,
    });
    // The effort it will run with is part of the name.
    expect(candidates.map((candidate) => candidate.label)).toEqual([
      "GPT-6.2 Sol · xhigh",
      "Fable 5.2",
    ]);
  });

  it("tells two accounts with the same model apart by the account's name", () => {
    const models = [{ slug: "claude-fable-5-2", name: "Fable 5.2" }];
    const candidates = newSubagentCandidates({
      providers: [
        provider("claudeAgent", "claudeAgent", models, { displayName: "Max 1" }),
        provider("claudeAgent_work", "claudeAgent", models, { displayName: "Max 2" }),
        codex,
      ],
      settings: {
        ...DEFAULT_UNIFIED_SETTINGS,
        providerInstances: {
          ...DEFAULT_UNIFIED_SETTINGS.providerInstances,
          [ProviderInstanceId.make("claudeAgent_work")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            config: {},
          },
        },
      },
      subagents: [
        subagent("claudeAgent_work", "claude-fable-5-2", 1),
        subagent("claudeAgent", "claude-fable-5-2", 2),
        subagent("codex", "gpt-6.2-sol", 3),
      ],
      history: [],
      now,
    });
    expect(candidates.map((candidate) => candidate.label)).toEqual([
      "Fable 5.2 · Max 2",
      "Fable 5.2 · Max 1",
      "GPT-6.2 Sol",
    ]);
  });

  it("falls back to each ready provider's default when nothing has been used yet", () => {
    const candidates = newSubagentCandidates({
      providers: [claude, codex],
      settings: DEFAULT_UNIFIED_SETTINGS,
      subagents: [],
      history: [],
      now,
    });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.every((candidate) => candidate.options === undefined)).toBe(true);
  });
});
