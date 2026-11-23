import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { canContinueOnAnotherModel, continueOnModelCandidates } from "./continueOnModel";

function provider(
  instanceId: string,
  driver: string,
  models: ReadonlyArray<{ slug: string; name: string }>,
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
    checkedAt: "2026-11-04T00:00:00.000Z",
    models: models.map((model) => ({ ...model, isCustom: false, capabilities: {} })),
    slashCommands: [],
    skills: [],
    ...extra,
  };
}

const codex = provider("codex", "codex", [{ slug: "gpt-6.1-sol", name: "GPT-6.1-Sol" }]);
const claude = provider("claudeAgent", "claudeAgent", [
  { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
]);
const grok = provider("grok_grok_build", "grok", [{ slug: "grok-4.7", name: "Grok 4.7" }]);
const kimi = provider("kimi", "acp", [{ slug: "kimi-k3", name: "Kimi K3" }]);

const settings = {
  ...DEFAULT_UNIFIED_SETTINGS,
  balanceAccounts: true,
  providerInstances: {
    ...DEFAULT_UNIFIED_SETTINGS.providerInstances,
    grok_grok_build: { driver: ProviderDriverKind.make("grok"), enabled: true, config: {} },
    kimi: { driver: ProviderDriverKind.make("acp"), config: {} },
    claudeAgent_work: { driver: ProviderDriverKind.make("claudeAgent"), config: {} },
  },
};

describe("continueOnModelCandidates", () => {
  it("offers the models the owner starts chats with, most used first, and nothing else", () => {
    const now = Date.parse("2026-11-14T12:00:00.000Z");
    const chats = (instanceId: string, model: string, count: number, effort?: string) =>
      Array.from({ length: count }, (_, index) => ({
        createdBy: "user",
        createdAt: now - index * 60 * 60 * 1000,
        modelSelection: {
          instanceId,
          model,
          ...(effort ? { options: [{ id: "effort", value: effort }] } : {}),
        },
      }));
    const claudeFamily = provider("claudeAgent", "claudeAgent", [
      { slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
      { slug: "claude-opus-5-5", name: "Claude Opus 5.5" },
      { slug: "claude-fable-5-2", name: "Claude Fable 5.2" },
    ]);
    const candidates = continueOnModelCandidates({
      providers: [kimi, grok, codex, claudeFamily],
      settings,
      failedInstanceId: ProviderInstanceId.make("codex"),
      history: [
        ...chats("claudeAgent", "claude-opus-5-5", 20, "high"),
        ...chats("codex", "gpt-6.1-sol", 12),
        ...chats("claudeAgent", "claude-fable-5-2", 5),
        ...chats("claudeAgent", "retired-model", 9),
        ...chats("kimi", "kimi-k3", 1),
      ],
      now,
    });
    // Not Claude's default Sonnet, not Grok, not the Kimi one-off, not the provider that failed.
    expect(candidates.map((candidate) => candidate.label)).toEqual([
      "Claude Opus 5.5",
      "Claude Fable 5.2",
    ]);
    expect(candidates[0]?.options).toEqual([{ id: "effort", value: "high" }]);
  });

  it("offers the chat's own model on the other plan first when this plan is out of room", () => {
    const now = Date.parse("2026-11-16T12:00:00.000Z");
    const models = [
      { slug: "claude-fable-5-2", name: "Fable 5.2" },
      { slug: "claude-opus-5-5", name: "Opus 5.5" },
    ];
    const plan = (instanceId: string, displayName: string, fableUsed: number) =>
      provider(instanceId, "claudeAgent", models, {
        displayName,
        continuation: { groupKey: "claude:home:/synthetic/.claude" },
        usageLimits: {
          checkedAt: "2026-11-16T12:00:00.000Z",
          windows: [
            { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 40 },
            {
              id: "seven_day_fable",
              kind: "weekly",
              label: "Weekly · Fable",
              usedPercent: fableUsed,
            },
          ],
        },
      });
    const input = {
      settings,
      failedModel: "claude-fable-5-2",
      failedOptions: [{ id: "effort", value: "xhigh" }],
      history: Array.from({ length: 6 }, (_, index) => ({
        createdBy: "user",
        createdAt: now - index * 60 * 60 * 1000,
        modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      })),
      now,
    };

    const onOwn = continueOnModelCandidates({
      ...input,
      providers: [codex, plan("claudeAgent", "Claude", 100), plan("claudeAgent_work", "Max-2", 3)],
      failedInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    for (const history of [input.history, []]) {
      const off = continueOnModelCandidates({
        ...input,
        providers: [
          codex,
          plan("claudeAgent", "Claude", 100),
          plan("claudeAgent_work", "Max-2", 3),
        ],
        failedInstanceId: ProviderInstanceId.make("claudeAgent"),
        settings: { ...settings, balanceAccounts: false },
        history,
      });
      expect(off.map((candidate) => candidate.instanceId)).toEqual([codex.instanceId]);
    }
    // The plan names the first choice: the model does not change.
    expect(onOwn.map((candidate) => candidate.label)).toEqual(["Max-2", "GPT-6.1-Sol"]);
    expect(onOwn[0]).toMatchObject({
      instanceId: "claudeAgent_work",
      model: "claude-fable-5-2",
      otherPlan: true,
      options: [{ id: "effort", value: "xhigh" }],
    });

    // From the added plan back to the provider's own, named as the picker names it.
    const onAdded = continueOnModelCandidates({
      ...input,
      providers: [codex, plan("claudeAgent", "Claude", 20), plan("claudeAgent_work", "Max-2", 100)],
      failedInstanceId: ProviderInstanceId.make("claudeAgent_work"),
    });
    expect(onAdded[0]).toMatchObject({ instanceId: "claudeAgent", label: "Max" });

    // Both plans out of room: only the models the owner uses elsewhere.
    const bothOut = continueOnModelCandidates({
      ...input,
      providers: [
        codex,
        plan("claudeAgent", "Claude", 100),
        plan("claudeAgent_work", "Max-2", 100),
      ],
      failedInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    expect(bothOut.map((candidate) => candidate.label)).toEqual(["GPT-6.1-Sol"]);
  });

  it.each(["disabled", "hidden"])(
    "excludes a project-%s sibling from the other-plan and fallback choices",
    (restriction) => {
      const projectId = ProjectId.make("project-a");
      const model = "claude-opus-5-5";
      const account = (instanceId: string, usedPercent: number) =>
        provider(instanceId, "claudeAgent", [{ slug: model, name: "Opus 5.5" }], {
          continuation: { groupKey: "claude:shared" },
          usageLimits: {
            checkedAt: "2026-11-04T00:00:00.000Z",
            windows: [{ id: "seven_day", label: "Weekly", kind: "weekly", usedPercent }],
          },
        });
      const first = account("claudeAgent", 100);
      const second = account("claudeAgent_work", 10);
      const restrictedSettings = {
        ...settings,
        ...(restriction === "disabled"
          ? {
              projectSettingsOverrides: {
                [projectId]: { providerInstances: { [second.instanceId]: { enabled: false } } },
              },
            }
          : {
              providerModelPreferences: {
                [second.instanceId]: { hiddenModels: [model], modelOrder: [] },
              },
            }),
      };
      const now = Date.parse("2026-11-04T00:00:00.000Z");
      const history = Array.from({ length: 3 }, () => ({
        createdBy: "user",
        createdAt: now,
        modelSelection: { instanceId: second.instanceId, model },
      }));
      for (const entries of [[], history]) {
        const candidates = continueOnModelCandidates({
          providers: [first, second, codex],
          settings: restrictedSettings,
          projectId,
          failedInstanceId: first.instanceId,
          failedModel: model,
          history: entries,
          now,
        });
        expect(candidates.map((candidate) => candidate.instanceId)).toEqual([codex.instanceId]);
      }
    },
  );

  it("offers other ready providers, strongest harness first, without chat history", () => {
    const candidates = continueOnModelCandidates({
      providers: [kimi, grok, codex, claude],
      settings,
      failedInstanceId: ProviderInstanceId.make("codex"),
    });
    expect(candidates.map((candidate) => [candidate.instanceId, candidate.model])).toEqual([
      ["claudeAgent", "claude-opus-5-5"],
      ["grok_grok_build", "grok-4.7"],
      ["kimi", "kimi-k3"],
    ]);
    expect(candidates[0]?.label).toBe("Claude Opus 5.5");
  });

  it("skips providers that are off, not ready or just failed themselves", () => {
    const candidates = continueOnModelCandidates({
      providers: [
        claude,
        { ...grok, enabled: false },
        { ...kimi, status: "error" },
        {
          ...codex,
          recentFailure: {
            kind: "usage_limit",
            message: "Weekly limit reached",
            occurredAt: "2026-11-04T00:00:00.000Z",
          },
        },
      ],
      settings,
      failedInstanceId: ProviderInstanceId.make("claudeAgent"),
    });
    expect(candidates).toEqual([]);
  });
});

describe("canContinueOnAnotherModel", () => {
  it("covers limits and provider refusals, not local problems", () => {
    expect(canContinueOnAnotherModel("usage_limit")).toBe(true);
    expect(canContinueOnAnotherModel("provider_error")).toBe(true);
    expect(canContinueOnAnotherModel("permission_error")).toBe(false);
    expect(canContinueOnAnotherModel("transport_error")).toBe(false);
    expect(canContinueOnAnotherModel(null)).toBe(false);
  });
});

it("keeps unaffected models available after a scoped refusal", () => {
  const now = Date.parse("2026-11-17T16:00:00.000Z");
  const limited = provider(
    "claudeAgent",
    "claudeAgent",
    [
      { slug: "fable", name: "Fable" },
      { slug: "opus", name: "Opus" },
    ],
    {
      recentFailure: {
        kind: "usage_limit",
        message: "Fable limit reached.",
        occurredAt: "2026-11-17T16:00:00.000Z",
        resetAt: "2026-11-19T16:00:00.000Z",
        modelIds: ["fable"],
      },
    },
  );
  const result = continueOnModelCandidates({
    providers: [codex, limited],
    settings: DEFAULT_UNIFIED_SETTINGS,
    failedInstanceId: codex.instanceId,
    now,
    history: ["fable", "opus"].map((model) => ({
      createdBy: "user",
      createdAt: now,
      modelSelection: { instanceId: limited.instanceId, model },
    })),
  });
  expect(result.map((candidate) => candidate.model)).toEqual(["opus"]);
});
