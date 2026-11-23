import { describe, expect, it } from "vite-plus/test";
import { nextPlanTipDisplay, planTipCopy, planTipKey } from "@t3tools/client-runtime/plan-tip";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

describe("web plan tip visibility", () => {
  const pair = { fromInstanceId: "claudeAgent", toInstanceId: "claudeAgent_work" };
  const now = Date.parse("2026-11-16T12:00:00.000Z");
  const key = planTipKey("environment:chat", pair);

  it("opens a new pair and keeps it open through usage snapshot updates", () => {
    const seen = new Set<string>();
    const active = nextPlanTipDisplay(key, null, false, seen, now);
    expect(active).toEqual({ key, expiresAt: now + 12_000 });
    seen.add(key);
    expect(nextPlanTipDisplay(key, active, false, seen, now + 1_000)).toBe(active);
  });

  it("closes for a picker, question, or approval and stays closed afterwards", () => {
    const seen = new Set([key]);
    expect(nextPlanTipDisplay(key, { key, expiresAt: now + 12_000 }, true, seen, now)).toBeNull();
    expect(nextPlanTipDisplay(key, null, false, seen, now)).toBeNull();
  });

  it("closes when the rule stops applying or the selection switches", () => {
    const seen = new Set([key]);
    expect(nextPlanTipDisplay(null, { key, expiresAt: now + 12_000 }, false, seen, now)).toBeNull();
    expect(nextPlanTipDisplay(key, null, false, seen, now)).toBeNull();
  });

  it("does not reopen after dismiss, switching, timeout, or remount in this chat", () => {
    expect(
      nextPlanTipDisplay(key, { key, expiresAt: now + 12_000 }, false, new Set([key]), now + 11_999)
        ?.key,
    ).toBe(key);
    expect(
      nextPlanTipDisplay(
        key,
        { key, expiresAt: now + 12_000 },
        false,
        new Set([key]),
        now + 12_000,
      ),
    ).toBeNull();
    expect(nextPlanTipDisplay(key, null, false, new Set([key]), now)).toBeNull();
    const otherChat = planTipKey("environment:other-chat", pair);
    expect(nextPlanTipDisplay(otherChat, null, false, new Set([key]), now)?.key).toBe(otherChat);
    const reverse = planTipKey("environment:chat", {
      fromInstanceId: pair.toInstanceId,
      toInstanceId: pair.fromInstanceId,
    });
    expect(nextPlanTipDisplay(reverse, null, false, new Set([key]), now)?.key).toBe(reverse);
  });

  it("does not consume a tip that was blocked before it could open", () => {
    const seen = new Set<string>();
    expect(nextPlanTipDisplay(key, null, true, seen, now)).toBeNull();
    expect(nextPlanTipDisplay(key, null, false, seen, now)?.key).toBe(key);
  });

  it("uses the Runs in plan names and the requested copy in both directions", () => {
    const own: ServerProvider = {
      instanceId: ProviderInstanceId.make(pair.fromInstanceId),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Claude",
      enabled: true,
      installed: true,
      status: "ready",
      version: null,
      auth: { status: "authenticated" },
      checkedAt: "2026-11-16T12:00:00.000Z",
      models: [
        { slug: "claude-fable-5-2", name: "Fable 5.2", isCustom: false, capabilities: null },
      ],
      slashCommands: [],
      skills: [],
    };
    const added = {
      ...own,
      instanceId: ProviderInstanceId.make(pair.toInstanceId),
      displayName: "Max-2",
    };
    const tip = {
      ...pair,
      reason: "more-room" as const,
      windowLabel: "Weekly · Fable",
      fromRemainingPercent: 15,
      toRemainingPercent: 97,
    };
    expect(planTipCopy([own, added], "claude-fable-5-2", tip)).toEqual({
      from: "Max",
      to: "Max-2",
      message: "Max-2 has more room for this model: 97% left, 15% here.",
    });
    expect(
      planTipCopy([own, added], "claude-fable-5-2", {
        ...tip,
        fromInstanceId: pair.toInstanceId,
        toInstanceId: pair.fromInstanceId,
        reason: "limit-reached",
        fromRemainingPercent: 0,
      }).message,
    ).toBe("Max-2 is at its Weekly · Fable limit. Max has 97% left.");
    expect(
      planTipCopy(
        [
          { ...own, models: [] },
          { ...added, models: [] },
        ],
        "missing",
        tip,
      ).from,
    ).toBe("Claude");
  });
});
