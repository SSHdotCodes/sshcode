import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { phoneContinueCandidates } from "./continueOnModelCandidates";

function group(instanceId: string, driver: string, models: ReadonlyArray<[string, boolean]>) {
  return {
    providerKey: instanceId,
    providerLabel: instanceId,
    models: models.map(
      ([slug, isDefault]) =>
        ({
          key: `${instanceId}:${slug}`,
          label: slug.toUpperCase(),
          subtitle: "",
          providerKey: instanceId,
          providerLabel: instanceId,
          providerDriver: driver,
          isDefault,
          isLegacy: false,
          capabilities: null,
          selection: { instanceId: ProviderInstanceId.make(instanceId), model: slug },
        }) satisfies ModelOption,
    ),
  } satisfies ProviderGroup;
}

describe("phoneContinueCandidates", () => {
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
  const groups = [
    group("grok_grok_build", "grok", [["grok-4.7", true]]),
    group("codex", "codex", [
      ["gpt-6-luna", false],
      ["gpt-6.1-sol", true],
    ]),
    group("claudeAgent", "claudeAgent", [
      ["claude-sonnet-5-5", true],
      ["claude-opus-5-5", false],
      ["claude-fable-5-2", false],
    ]),
    group("kimi", "acp", [["kimi-k3", true]]),
  ];

  it("offers the models the owner starts chats with, most used first, and nothing else", () => {
    const candidates = phoneContinueCandidates(
      groups,
      "codex",
      [
        ...chats("claudeAgent", "claude-opus-5-5", 20, "high"),
        ...chats("codex", "gpt-6.1-sol", 12),
        ...chats("claudeAgent", "claude-fable-5-2", 5),
        ...chats("kimi", "kimi-k3", 1),
      ],
      now,
    );
    // Not Claude's default Sonnet, not Grok, not the Kimi one-off, not the provider that failed.
    expect(candidates.map((candidate) => candidate.label)).toEqual([
      "CLAUDE-OPUS-5-5",
      "CLAUDE-FABLE-5-2",
    ]);
    expect(candidates[0]?.selection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
      options: [{ id: "effort", value: "high" }],
    });
    expect(new Set(candidates.map((candidate) => candidate.key)).size).toBe(2);
  });

  it("skips a used model that is gone, hidden or on a provider whose last run failed", () => {
    const hidden = groups.map((entry) =>
      entry.providerKey === "claudeAgent"
        ? {
            ...entry,
            models: entry.models.map((model) =>
              model.selection.model === "claude-opus-5-5" ? { ...model, isHidden: true } : model,
            ),
          }
        : entry.providerKey === "kimi"
          ? { ...entry, recentFailure: { kind: "usage_limit" } as never }
          : entry,
    );
    const candidates = phoneContinueCandidates(
      hidden,
      "codex",
      [
        ...chats("claudeAgent", "claude-opus-5-5", 9),
        ...chats("claudeAgent", "retired-model", 9),
        ...chats("kimi", "kimi-k3", 9),
        ...chats("claudeAgent", "claude-fable-5-2", 9),
      ],
      now,
    );
    expect(candidates.map((candidate) => candidate.label)).toEqual(["CLAUDE-FABLE-5-2"]);
  });

  it("picks each other provider's default model, strongest harness first, without history", () => {
    const candidates = phoneContinueCandidates(
      [
        group("grok_grok_build", "grok", [["grok-4.7", true]]),
        group("codex", "codex", [
          ["gpt-6-luna", false],
          ["gpt-6.1-sol", true],
        ]),
        group("claudeAgent", "claudeAgent", [["claude-opus-5-5", false]]),
      ],
      "codex",
    );
    expect(candidates.map((candidate) => [candidate.instanceId, candidate.label])).toEqual([
      ["claudeAgent", "CLAUDE-OPUS-5-5"],
      ["grok_grok_build", "GROK-4.7"],
    ]);
    expect(candidates[0]?.selection).toEqual({
      instanceId: "claudeAgent",
      model: "claude-opus-5-5",
    });
  });
  it("puts the chat's own model on the other plan first, named by the plan", () => {
    const plans = [
      ...groups,
      group("claudeAgent_work", "claudeAgent", [
        ["claude-sonnet-5-5", true],
        ["claude-fable-5-2", false],
      ]),
    ];
    const candidates = phoneContinueCandidates(
      plans,
      "claudeAgent",
      [...chats("codex", "gpt-6.1-sol", 12), ...chats("claudeAgent_work", "claude-fable-5-2", 6)],
      now,
      {
        instanceId: "claudeAgent_work",
        label: "Max-2",
        model: "claude-fable-5-2",
        options: [{ id: "effort", value: "xhigh" }],
      },
    );

    // Listed once, first, although chat history names it too.
    expect(candidates.map((candidate) => candidate.label)).toEqual(["Max-2", "GPT-6.1-SOL"]);
    expect(candidates[0]?.selection).toEqual({
      instanceId: "claudeAgent_work",
      model: "claude-fable-5-2",
      options: [{ id: "effort", value: "xhigh" }],
    });
  });
});

it("offers an unaffected model while another model on the account is limited", () => {
  const now = Date.parse("2026-11-17T16:00:00.000Z");
  const limited = {
    ...group("claudeAgent", "claudeAgent", [
      ["fable", true],
      ["opus", false],
    ]),
    recentFailure: {
      kind: "usage_limit" as const,
      message: "Fable limit reached.",
      occurredAt: "2026-11-17T16:00:00.000Z",
      resetAt: "2026-11-19T16:00:00.000Z",
      modelIds: ["fable"],
    },
  };
  const result = phoneContinueCandidates(
    [limited],
    "codex",
    ["fable", "opus"].map((model) => ({
      createdBy: "user",
      createdAt: now,
      modelSelection: { instanceId: "claudeAgent", model },
    })),
    now,
  );
  expect(result.map((candidate) => candidate.selection.model)).toEqual(["opus"]);
});
