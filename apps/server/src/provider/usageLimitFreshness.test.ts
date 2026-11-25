import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import { makeUnavailableUsageLimits } from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { withLastUsageReading } from "./usageLimitFreshness.ts";

const HOUR = 3_600_000;
const BASE = Date.parse("2026-11-20T22:23:25.000Z");
const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(BASE + hours * HOUR));
const NOW = Date.parse(at(2));

const failed = makeUnavailableUsageLimits({
  checkedAt: at(2),
  reason: "probeFailed",
  message: "Antigravity's limits show again the next time it runs.",
});

const last: ServerProviderUsageLimits = {
  checkedAt: at(0),
  credentialFingerprint: "google-account",
  resetCredits: { availableCount: 1 },
  windows: [
    {
      id: "gemini-5h",
      kind: "session",
      label: "Gemini · 5-hour",
      usedPercent: 40,
      resetsAt: at(1),
      windowDurationMins: 300,
    },
    {
      id: "gemini-weekly",
      kind: "weekly",
      label: "Gemini · Weekly",
      usedPercent: 52,
      resetsAt: at(100),
      windowDurationMins: 7 * 24 * 60,
      recentPercentPerHour: 3,
    },
    // Untouched buckets report no reset: one window length after the reading it says nothing.
    {
      id: "3p-5h",
      kind: "session",
      label: "Claude & GPT (shared) · 5-hour",
      usedPercent: 0,
      windowDurationMins: 60,
    },
    {
      id: "3p-weekly",
      kind: "weekly",
      label: "Claude & GPT (shared) · Weekly",
      usedPercent: 0,
      windowDurationMins: 7 * 24 * 60,
    },
  ],
};

describe("withLastUsageReading", () => {
  it("serves the last reading, dated when it was read, without windows whose reset passed", () => {
    const served = withLastUsageReading(failed, last, NOW);

    expect(served.checkedAt).toBe(last.checkedAt);
    expect(served.unavailable).toEqual(failed.unavailable);
    expect(served.windows.map((window) => window.id)).toEqual(["gemini-weekly", "3p-weekly"]);
    expect(served.windows[0]?.usedPercent).toBe(52);
    // A pace from hours ago must not raise run-out warnings, nor an old credit offer a redeem.
    expect(served.windows[0]?.recentPercentPerHour).toBeUndefined();
    expect(served.resetCredits).toBeUndefined();
    expect(served.credentialFingerprint).toBe("google-account");
  });

  it("keeps the failure's notice when nothing is left to show", () => {
    expect(withLastUsageReading(failed, undefined, NOW)).toBe(failed);
    const allReset = { ...last, windows: last.windows.slice(0, 1) };
    expect(withLastUsageReading(failed, allReset, NOW)).toBe(failed);
    const unsupported = makeUnavailableUsageLimits({ checkedAt: at(0), reason: "unsupported" });
    expect(withLastUsageReading(failed, unsupported, NOW)).toBe(failed);
  });

  it("never replaces a probe that read something", () => {
    const live: ServerProviderUsageLimits = { checkedAt: at(2), windows: [last.windows[1]!] };
    expect(withLastUsageReading(live, last, NOW)).toBe(live);
    const unsupported = makeUnavailableUsageLimits({ checkedAt: at(2), reason: "unsupported" });
    expect(withLastUsageReading(unsupported, last, NOW)).toBe(unsupported);
  });

  it("only loses windows when it falls back to an older reading again", () => {
    const first = withLastUsageReading(failed, last, NOW);
    const later = withLastUsageReading(failed, first, Date.parse(at(200)));

    expect(later).toBe(failed);
    expect(withLastUsageReading(failed, first, NOW + HOUR).windows).toEqual(first.windows);
  });

  it("keeps a reading from the last few minutes as it was", () => {
    const recent = { ...last, checkedAt: at(1.9) };
    const served = withLastUsageReading(failed, recent, NOW);
    // Six minutes old: still the current numbers, with no failure notice to grey them out.
    expect(served.unavailable).toBeUndefined();
    expect(served.checkedAt).toBe(recent.checkedAt);
    expect(served.windows.map((window) => window.id)).toEqual([
      "gemini-weekly",
      "3p-5h",
      "3p-weekly",
    ]);
    expect(served.windows[0]?.recentPercentPerHour).toBe(3);
    expect(served.resetCredits).toEqual({ availableCount: 1 });
  });
});
