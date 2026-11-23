import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";
import { newSubagentCandidates } from "./newSubagentModels";

function group(
  instanceId: string,
  label: string,
  driver: string,
  models: ReadonlyArray<[slug: string, flags?: Partial<ModelOption>]>,
) {
  return {
    providerKey: instanceId,
    providerLabel: label,
    models: models.map(
      ([slug, flags]) =>
        ({
          key: `${instanceId}:${slug}`,
          label: slug.toUpperCase(),
          subtitle: "",
          providerKey: instanceId,
          providerLabel: label,
          providerDriver: driver,
          isDefault: false,
          isLegacy: false,
          capabilities: null,
          selection: { instanceId: ProviderInstanceId.make(instanceId), model: slug },
          ...flags,
        }) satisfies ModelOption,
    ),
  } satisfies ProviderGroup;
}

const now = Date.parse("2026-11-17T20:00:00.000Z");
const HOUR = 60 * 60 * 1000;
const subagent = (
  hoursAgo: number,
  instanceId: string,
  model: string | null,
  extra: { readonly effort?: string; readonly origin?: "app_owned" | "provider_native" } = {},
) => ({
  origin: extra.origin ?? ("app_owned" as const),
  providerInstanceId: ProviderInstanceId.make(instanceId),
  model,
  ...(extra.effort === undefined || model === null
    ? {}
    : {
        modelSelection: {
          instanceId: ProviderInstanceId.make(instanceId),
          model,
          options: [{ id: "reasoningEffort", value: extra.effort }],
        },
      }),
  startedAt: DateTime.makeUnsafe(now - hoursAgo * HOUR),
  updatedAt: DateTime.makeUnsafe(now - hoursAgo * HOUR),
});
const chat = (hoursAgo: number, instanceId: string, model: string) => ({
  createdBy: "user",
  createdAt: now - hoursAgo * HOUR,
  modelSelection: { instanceId, model },
});

const groups = [
  group("claudeAgent", "Max 1", "claudeAgent", [["claude-fable-5-2", { isDefault: true }]]),
  group("codex", "Home", "codex", [["gpt-6.2-sol", { isDefault: true }], ["gpt-6.2-astra"]]),
  group("codex_work", "Work", "codex", [
    ["gpt-6.2-sol", { isDefault: true }],
    ["gpt-6.2-astra"],
    ["gpt-6-astra", { isLegacy: true }],
  ]),
];

describe("models the phone offers for a subagent the user starts", () => {
  it("leads with what this chat's subagents run on, as they run it, then the user's chat models", () => {
    const candidates = newSubagentCandidates({
      groups,
      providers: [],
      subagents: [
        subagent(1, "codex_work", "gpt-6.2-astra", { effort: "xhigh" }),
        subagent(2, "codex_work", "gpt-6.2-astra", { effort: "xhigh" }),
        subagent(30, "codex_work", "gpt-6.2-sol"),
      ],
      history: [chat(5, "claudeAgent", "claude-fable-5-2")],
      now,
    });
    // The effort it will run with is part of the name.
    expect(candidates.map((candidate) => candidate.label)).toEqual([
      "GPT-6.2-ASTRA · xhigh",
      "GPT-6.2-SOL",
      "CLAUDE-FABLE-5-2",
    ]);
    expect(candidates[0]?.selection).toEqual({
      instanceId: "codex_work",
      model: "gpt-6.2-astra",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    });
    // An older record without a stored selection still names its model.
    expect(candidates[1]?.selection).toEqual({ instanceId: "codex_work", model: "gpt-6.2-sol" });
  });

  it("names the account when the same model is offered on two", () => {
    const candidates = newSubagentCandidates({
      groups,
      providers: [],
      subagents: [subagent(1, "codex_work", "gpt-6.2-sol"), subagent(2, "codex", "gpt-6.2-sol")],
      history: [],
      now,
    });
    expect(candidates.map((candidate) => candidate.label)).toEqual([
      "GPT-6.2-SOL · Work",
      "GPT-6.2-SOL · Home",
    ]);
  });

  it("skips models that are gone, retired or the provider's own helpers", () => {
    const candidates = newSubagentCandidates({
      groups,
      providers: [],
      subagents: [
        subagent(1, "codex_work", "gpt-6-astra"),
        subagent(1, "vanished", "some-model"),
        subagent(1, "claudeAgent", null),
        subagent(1, "claudeAgent", "claude-haiku-5-5", { origin: "provider_native" }),
        subagent(3, "codex", "gpt-6.2-astra"),
      ],
      history: [],
      now,
    });
    expect(candidates.map((candidate) => candidate.key)).toEqual(["codex\0gpt-6.2-astra"]);
  });

  it("never offers a release a newer one replaced, however much the chat used it", () => {
    const model = (slug: string) => ({ slug, name: slug, isCustom: false, capabilities: null });
    const candidates = newSubagentCandidates({
      groups: [
        group("codex_work", "Work", "codex", [
          ["gpt-6.2-sol", { isDefault: true }],
          ["gpt-6.1-sol"],
        ]),
      ],
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex_work"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-11-17T00:00:00.000Z",
          models: [model("gpt-6.2-sol"), model("gpt-6.1-sol")],
          slashCommands: [],
          skills: [],
        },
      ],
      subagents: [
        subagent(1, "codex_work", "gpt-6.1-sol"),
        subagent(2, "codex_work", "gpt-6.1-sol"),
        subagent(3, "codex_work", "gpt-6.2-sol", { effort: "xhigh" }),
      ],
      history: [],
      now,
    });
    expect(candidates.map((candidate) => candidate.label)).toEqual(["GPT-6.2-SOL · xhigh"]);
  });

  it("offers each provider's default when there is nothing to go by", () => {
    const candidates = newSubagentCandidates({
      groups,
      providers: [],
      subagents: [],
      history: [],
      now,
    });
    expect(candidates.map((candidate) => candidate.selection.model)).toEqual([
      "claude-fable-5-2",
      "gpt-6.2-sol",
      "gpt-6.2-sol",
    ]);
  });
});
