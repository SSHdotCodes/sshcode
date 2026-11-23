import { describe, expect, it } from "vite-plus/test";
import { nextPlanTipDisplay, planTipKey } from "@t3tools/client-runtime/plan-tip";

describe("phone plan tip visibility", () => {
  const pair = { fromInstanceId: "claudeAgent_work", toInstanceId: "claudeAgent" };
  const now = Date.parse("2026-11-16T12:00:00.000Z");
  const key = planTipKey("phone-environment:chat", pair);

  it("waits until the model sheet or composer takeover closes before first showing", () => {
    const seen = new Set<string>();
    expect(nextPlanTipDisplay(key, null, true, seen, now)).toBeNull();
    expect(nextPlanTipDisplay(key, null, false, seen, now)).toEqual({
      key,
      expiresAt: now + 12_000,
    });
  });

  it("keeps one pair visible as its percentages change", () => {
    expect(
      nextPlanTipDisplay(key, { key, expiresAt: now + 12_000 }, false, new Set([key]), now)?.key,
    ).toBe(key);
  });

  it("closes on a takeover or when the selection no longer qualifies", () => {
    expect(
      nextPlanTipDisplay(key, { key, expiresAt: now + 12_000 }, true, new Set([key]), now),
    ).toBeNull();
    expect(
      nextPlanTipDisplay(null, { key, expiresAt: now + 12_000 }, false, new Set([key]), now),
    ).toBeNull();
  });

  it("remembers dismiss, switching and the 12 second expiry across composer remounts", () => {
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
    const seen = new Set([key]);
    expect(nextPlanTipDisplay(key, null, false, seen, now)).toBeNull();
    const otherChat = planTipKey("phone-environment:other-chat", pair);
    expect(nextPlanTipDisplay(otherChat, null, false, seen, now)?.key).toBe(otherChat);
    const otherEnvironment = planTipKey("other-environment:chat", pair);
    expect(nextPlanTipDisplay(otherEnvironment, null, false, seen, now)?.key).toBe(
      otherEnvironment,
    );
  });
});
