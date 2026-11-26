import { describe, expect, it } from "vite-plus/test";

import { knownPlan, planName } from "./subscriptionPlans.ts";

const clues = (driver: string, planLabel?: string, extra: { windowIds?: string[] } = {}) => ({
  driver,
  ...(planLabel === undefined ? {} : { planLabel }),
  windowIds: extra.windowIds ?? [],
});

describe("knownPlan", () => {
  it("prices the plans providers name", () => {
    expect(knownPlan(clues("claudeAgent", "Claude Ultra Subscription"))).toEqual({
      label: "Claude Ultra",
      monthlyUsd: 200,
    });
    expect(knownPlan(clues("claudeAgent", "Claude Max 20x Subscription"))?.monthlyUsd).toBe(200);
    expect(knownPlan(clues("claudeAgent", "Claude Max 5x Subscription"))?.monthlyUsd).toBe(100);
    expect(knownPlan(clues("claudeAgent", "Claude Pro Subscription"))?.monthlyUsd).toBe(20);
    expect(knownPlan(clues("codex", "ChatGPT Pro 20x Subscription"))?.monthlyUsd).toBe(200);
    expect(knownPlan(clues("codex", "ChatGPT Pro 10x Subscription"))).toEqual({
      label: "ChatGPT Pro 10x",
      monthlyUsd: 100,
    });
    expect(knownPlan(clues("codex", "ChatGPT Plus Subscription"))?.monthlyUsd).toBe(20);
    expect(knownPlan(clues("codex", "ChatGPT Go Subscription"))?.monthlyUsd).toBe(8);
  });

  it("knows a plan by its limit windows or its name when the provider names none", () => {
    expect(
      knownPlan(clues("opencode", undefined, { windowIds: ["go_rolling", "go_weekly"] })),
    ).toEqual({
      label: "OpenCode Go",
      monthlyUsd: 10,
      includedMonthlyUsd: 60,
      providerIds: ["opencode-go"],
    });
    expect(
      knownPlan({ driver: "acpRegistry", displayName: "Mistral Vibe", windowIds: [] }),
    ).toEqual({ label: "Mistral Vibe Pro", monthlyUsd: 14.99 });
  });

  it("guesses nothing for keys, unknown plans and other providers' names", () => {
    expect(knownPlan(clues("claudeAgent", "Claude API Key"))).toBeUndefined();
    expect(knownPlan(clues("codex", "ChatGPT Enterprise Subscription"))).toBeUndefined();
    expect(knownPlan(clues("grok", "Grok account"))).toBeUndefined();
    // A plan name means nothing on another provider's driver.
    expect(knownPlan(clues("grok", "ChatGPT Plus Subscription"))).toBeUndefined();
    expect(knownPlan(clues("opencode", undefined, { windowIds: ["weekly"] }))).toBeUndefined();
  });

  it("drops the word every plan label ends with", () => {
    expect(planName("ChatGPT Pro 10x Subscription")).toBe("ChatGPT Pro 10x");
    expect(planName("Claude API Key")).toBeUndefined();
    expect(planName(undefined)).toBeUndefined();
  });
});
