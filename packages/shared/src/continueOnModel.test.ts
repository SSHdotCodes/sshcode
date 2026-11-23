import { describe, expect, it } from "vite-plus/test";

import { canContinueOnAnotherModel, continueOnProviders, usedModels } from "./continueOnModel.ts";

describe("continueOnProviders", () => {
  const providers = [
    { instanceId: "kimi", driver: "acp" },
    { instanceId: "grok_grok_build", driver: "grok" },
    { instanceId: "codex", driver: "codex" },
    { instanceId: "claudeAgent", driver: "claudeAgent" },
  ];

  it("puts the strongest harnesses first and keeps the rest in order", () => {
    expect(continueOnProviders(providers, null).map((p) => p.instanceId)).toEqual([
      "claudeAgent",
      "codex",
      "grok_grok_build",
      "kimi",
    ]);
  });

  it("drops the failed provider and any whose own last run failed", () => {
    const withFailure = providers.map((p) =>
      p.instanceId === "grok_grok_build" ? { ...p, recentFailure: { kind: "usage_limit" } } : p,
    );
    expect(continueOnProviders(withFailure, "claudeAgent").map((p) => p.instanceId)).toEqual([
      "codex",
      "kimi",
    ]);
  });

  it("retains providers with only a scoped failure for per-model filtering", () => {
    const scoped = {
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      recentFailure: { kind: "usage_limit", modelIds: ["fable"] },
    };
    expect(continueOnProviders([scoped], null)).toEqual([scoped]);
  });

  it("offers it for limits and provider refusals only", () => {
    expect(canContinueOnAnotherModel("usage_limit")).toBe(true);
    expect(canContinueOnAnotherModel("provider_error")).toBe(true);
    expect(canContinueOnAnotherModel("validation_error")).toBe(false);
    expect(canContinueOnAnotherModel(undefined)).toBe(false);
  });
});

describe("usedModels", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 100 * DAY;
  const chat = (
    instanceId: string,
    model: string,
    daysAgo: number,
    extra: { createdBy?: string; effort?: string } = {},
  ) => ({
    createdBy: extra.createdBy ?? "user",
    createdAt: now - daysAgo * DAY,
    modelSelection: {
      instanceId,
      model,
      ...(extra.effort ? { options: [{ id: "effort", value: extra.effort }] } : {}),
    },
  });
  const repeat = <T>(count: number, make: (index: number) => T) =>
    Array.from({ length: count }, (_, index) => make(index));

  it("lists the models the owner starts chats with, most used first, without one-offs", () => {
    const used = usedModels(
      [
        ...repeat(40, (index) => chat("claudeAgent", "claude-opus-5-5", index % 20)),
        ...repeat(12, (index) => chat("codex", "gpt-6.1-sol", index)),
        chat("grok_grok_build", "grok-4.7", 2),
        chat("opencode", "some-free-model", 9),
      ],
      now,
    );
    expect(used.map((model) => model.model)).toEqual(["claude-opus-5-5", "gpt-6.1-sol"]);
  });

  it("lets a few recent chats outweigh many old ones", () => {
    const used = usedModels(
      [
        ...repeat(8, () => chat("claudeAgent", "old-favourite", 28)),
        ...repeat(3, () => chat("claudeAgent", "new-favourite", 1)),
      ],
      now,
    );
    expect(used.map((model) => model.model)).toEqual(["new-favourite", "old-favourite"]);
  });

  it("ignores chats agents started, chats older than a month and chats from the future", () => {
    expect(
      usedModels(
        [
          chat("codex", "subagent-model", 1, { createdBy: "agent" }),
          chat("codex", "last-season", 45),
          chat("codex", "tomorrow", -1),
        ],
        now,
      ),
    ).toEqual([]);
  });

  it("keeps the options the model is most often run with", () => {
    const used = usedModels(
      [
        chat("codex", "gpt-6.1-sol", 1, { effort: "high" }),
        chat("codex", "gpt-6.1-sol", 2, { effort: "high" }),
        chat("codex", "gpt-6.1-sol", 0, { effort: "low" }),
        chat("claudeAgent", "claude-opus-5-5", 0),
      ],
      now,
    );
    expect(used).toEqual([
      { instanceId: "codex", model: "gpt-6.1-sol", options: [{ id: "effort", value: "high" }] },
      { instanceId: "claudeAgent", model: "claude-opus-5-5" },
    ]);
  });
});
