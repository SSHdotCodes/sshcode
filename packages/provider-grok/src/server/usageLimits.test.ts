import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { pickAccountForNewSession } from "@t3tools/shared/accountBalance";
import { describe, expect, it } from "vite-plus/test";
import { grokUsageResponseToLimits } from "./usageLimits.ts";

const checkedAt = "2026-11-17T16:40:00.000Z";
const now = Date.parse(checkedAt);
const limits = (type: string, usedPercent: number, end: string, start?: string) =>
  grokUsageResponseToLimits(
    {
      config: {
        creditUsagePercent: usedPercent,
        currentPeriod: { type, end, ...(start ? { start } : {}) },
      },
    },
    checkedAt,
  );

const account = (id: string, usageLimits: ServerProvider["usageLimits"]): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make("grok"),
  continuation: { groupKey: "grok:shared" },
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt,
  models: [{ slug: "grok-4.7", name: "Grok 4.7", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  usageLimits,
});

describe("Grok quota periods", () => {
  it.each(["WEEKLY", "MONTHLY"])(
    "advances a passed %s reset by its period when balancing",
    (type) => {
      const refilled = account("grok", limits(type, 100, "2026-11-17T16:39:00.000Z"));
      const remaining = account("grok_work", limits(type, 30, "2026-11-21T00:40:00.000Z"));
      const pick = pickAccountForNewSession(
        [refilled, remaining],
        { instanceId: refilled.instanceId, model: "grok-4.7" },
        { now },
      );
      expect(pick?.instanceId).toBe(remaining.instanceId);
      expect(refilled.usageLimits?.windows[0]?.windowDurationMins).toBe(
        (type === "WEEKLY" ? 7 : 31) * 1440,
      );
    },
  );

  it("uses the reported monthly boundaries and otherwise the calendar month ending at reset", () => {
    expect(limits("MONTHLY", 10, "2026-03-01T00:00:00Z").windows[0]?.windowDurationMins).toBe(
      28 * 1440,
    );
    expect(
      limits("MONTHLY", 10, "2026-03-01T00:00:00Z", "2026-02-03T00:00:00Z").windows[0]
        ?.windowDurationMins,
    ).toBe(26 * 1440);
    expect(
      limits("UNKNOWN", 10, "2026-03-01T00:00:00Z").windows[0]?.windowDurationMins,
    ).toBeUndefined();
  });

  it("shows a period with nothing metered yet at 0%, and no window without a period", () => {
    const unmetered = grokUsageResponseToLimits(
      {
        config: {
          currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-11-23T20:00:00Z" },
        },
      },
      checkedAt,
    );
    expect(unmetered.windows).toHaveLength(1);
    expect(unmetered.windows[0]?.usedPercent).toBe(0);
    expect(unmetered.windows[0]?.kind).toBe("weekly");
    expect(unmetered.unavailable).toBeUndefined();
    expect(grokUsageResponseToLimits({ config: {} }, checkedAt).windows).toEqual([]);
  });
});
