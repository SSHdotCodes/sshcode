import { ProviderDriverKind } from "@t3tools/contracts";
import type { LimitAccount, LimitPool, LimitPoolWindow } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  combinableRingDrivers,
  isLimitRingShown,
  limitTone,
  planRunsFromThreads,
  planUse,
  resetsInLabel,
  resetsInShort,
  statusRowRings,
  statusRowVisibleRings,
  summarizeProviderLimits,
  tightestProviderLimits,
} from "./limitsGlance";

const NOW = Date.parse("2026-10-15T12:00:00.000Z");

function window(
  id: string,
  usedPercent: number,
  resetInMinutes: number | null,
  kind: LimitPoolWindow["kind"] = "session",
): LimitPoolWindow {
  return {
    id,
    kind,
    label: id,
    members: [],
    columns: [],
    usedPercent,
    remainingPercent: 100 - usedPercent,
    pace: null,
    resets:
      resetInMinutes === null
        ? []
        : [
            {
              member: {} as LimitPoolWindow["resets"][number]["member"],
              at: NOW + resetInMinutes * 60_000,
              restoresPercent: usedPercent,
            },
          ],
  };
}

function pool(driver: string, windows: LimitPoolWindow[]): LimitPool {
  return {
    key: driver,
    driver: ProviderDriverKind.make(driver),
    label: null,
    accounts: [],
    windows,
    unread: [],
  };
}

describe("summarizeProviderLimits", () => {
  it("keeps providers and their windows in place while naming the tightest", () => {
    const summary = summarizeProviderLimits([
      pool("codex", [window("5h", 20, 60), window("weekly", 55, 3_000, "weekly")]),
      pool("claudeAgent", [window("5h", 91, 30), window("weekly", 40, 4_000, "weekly")]),
    ]);

    // Usage moving must not reorder the bars under the reader.
    expect(summary.map((entry) => entry.driver)).toEqual(["codex", "claudeAgent"]);
    expect(summary[0]?.windows.map((entry) => entry.id)).toEqual(["5h", "weekly"]);
    expect(summary[0]?.tightest.id).toBe("weekly");
    expect(summary[1]?.tightest.id).toBe("5h");
    expect(tightestProviderLimits(summary)?.driver).toBe("claudeAgent");
  });

  it("breaks ties by the sooner reset and skips providers without windows", () => {
    const summary = summarizeProviderLimits([
      pool("codex", [window("later", 50, 600), window("sooner", 50, 10)]),
      pool("cursor", []),
    ]);

    expect(summary).toHaveLength(1);
    expect(summary[0]?.tightest.id).toBe("sooner");
  });
});

describe("isLimitRingShown", () => {
  const account = (hideRing: boolean | undefined) =>
    ({
      key: "account",
      ...(hideRing === undefined ? {} : { hideRing }),
    }) as LimitPool["accounts"][number];
  const ring = (key: string, accounts: LimitPool["accounts"]) => ({
    pool: { ...pool("grok", []), key, accounts },
  });

  it("follows the account's setting until this device chooses", () => {
    expect(isLimitRingShown(ring("grok", [account(undefined)]), undefined)).toBe(true);
    expect(isLimitRingShown(ring("grok:added", [account(true)]), undefined)).toBe(false);
    // One hidden account does not take a pooled ring away from the others.
    expect(isLimitRingShown(ring("grok", [account(true), account(false)]), {})).toBe(true);
  });

  it("lets this device's choice win in both directions", () => {
    expect(isLimitRingShown(ring("grok:added", [account(true)]), { "grok:added": true })).toBe(
      true,
    );
    expect(isLimitRingShown(ring("grok", [account(false)]), { grok: false })).toBe(false);
    expect(isLimitRingShown(ring("grok", [account(false)]), { other: false })).toBe(true);
  });
});

describe("statusRowRings", () => {
  const plan = (driver: string, label: string, windows: LimitPoolWindow[]): LimitPool => ({
    ...pool(driver, windows),
    key: `${driver}:${label}`,
    label,
  });
  const withSources = (entry: LimitPool, sourceKeys: string[]): LimitPool => ({
    ...entry,
    accounts: [{ sourceKeys } as unknown as LimitAccount],
  });
  const providers = summarizeProviderLimits([
    pool("codex", [window("weekly", 44, 9_000, "weekly")]),
    pool("claudeAgent", [window("weekly", 70, 2_000, "weekly"), window("fable", 88, 2_000)]),
    plan("claudeAgent", "Max-2", [window("5h", 4, 240), window("weekly", 3, 3_600, "weekly")]),
    pool("opencode", [window("go", 100, 8_000, "weekly")]),
    pool("grok", [window("weekly", 20, 9_900, "weekly")]),
    plan("grok", "Grok-B", [window("weekly", 60, 5_600, "weekly")]),
  ]);

  it("draws every plan apart until told otherwise, without the ones switched off", () => {
    expect(statusRowRings(providers, undefined, undefined).map((ring) => ring.key)).toEqual([
      "codex",
      "claudeAgent",
      "claudeAgent:Max-2",
      "opencode",
      "grok",
      "grok:Grok-B",
    ]);
    const chosen = statusRowRings(providers, { opencode: false, "grok:Grok-B": false }, []);
    expect(chosen.map((ring) => ring.key)).toEqual([
      "codex",
      "claudeAgent",
      "claudeAgent:Max-2",
      "grok",
    ]);
  });

  it("with nothing in use, keeps the closest to running out, in their places, and counts the rest", () => {
    const rings = statusRowRings(providers, undefined, undefined);
    expect(statusRowVisibleRings(rings).more).toBe(0);
    const { shown, more } = statusRowVisibleRings(rings, new Map(), 4);
    // opencode 100, Claude's fable 88, Grok-B 60, codex 44; grok 20 and Max-2 4 are counted.
    expect(shown.map((ring) => ring.key)).toEqual([
      "codex",
      "claudeAgent",
      "opencode",
      "grok:Grok-B",
    ]);
    expect(more).toBe(2);
    expect(statusRowVisibleRings(rings.slice(0, 4), new Map(), 4)).toEqual({
      shown: rings.slice(0, 4),
      more: 0,
    });
  });

  it("gives the room to the plans in use, then the closest to running out", () => {
    const used = summarizeProviderLimits(
      [
        pool("codex", [window("weekly", 44, 9_000, "weekly")]),
        pool("claudeAgent", [window("weekly", 70, 2_000, "weekly")]),
        plan("claudeAgent", "Max-2", [window("5h", 4, 240)]),
        pool("opencode", [window("go", 100, 8_000, "weekly")]),
        pool("grok", [window("weekly", 20, 9_900, "weekly")]),
      ].map((entry) => withSources(entry, [`mac:${entry.key}`])),
    );
    const rings = statusRowRings(used, undefined, undefined);
    const use = new Map([
      ["mac:claudeAgent:Max-2", 5],
      ["mac:grok", 0.2],
    ]);
    // Max-2 and grok are in use; then opencode at 100 beats Claude at 70.
    expect(statusRowVisibleRings(rings, use, 3).shown.map((ring) => ring.key)).toEqual([
      "claudeAgent:Max-2",
      "opencode",
      "grok",
    ]);
  });

  it("counts every plan behind a combined ring", () => {
    const rings = statusRowRings(
      summarizeProviderLimits([
        withSources(pool("grok", [window("weekly", 20, 9_900, "weekly")]), ["mac:grok"]),
        withSources(plan("grok", "Grok-B", [window("weekly", 60, 5_600, "weekly")]), [
          "mac:grok_work",
          "studio:grok_work",
        ]),
      ]),
      undefined,
      ["grok"],
    );
    expect(rings[0]?.sourceKeys).toEqual(["mac:grok", "mac:grok_work", "studio:grok_work"]);
  });

  it("combines only the providers asked for, in the provider's place", () => {
    const rings = statusRowRings(providers, undefined, ["grok"]);
    expect(rings.map((ring) => ring.key)).toEqual([
      "codex",
      "claudeAgent",
      "claudeAgent:Max-2",
      "opencode",
      "grok",
    ]);
    const grok = rings[4]!;
    // Halfway between a plan at 20% and one at 60%; the sooner reset leads.
    expect(grok.label).toBeNull();
    expect(grok.limits.tightest.usedPercent).toBe(40);
    expect(grok.limits.tightest.label).toBe("2 plans");
    expect(resetsInShort(grok.limits.tightest, NOW)).toBe(
      resetsInShort(providers[5]!.tightest, NOW),
    );
  });

  it("combines only the plans switched on, and one plan alone stays itself", () => {
    const rings = statusRowRings(providers, { "claudeAgent:Max-2": false }, ["claudeAgent"]);
    expect(rings[1]?.key).toBe("claudeAgent");
    expect(rings[1]?.limits.tightest.id).toBe("fable");

    const full = statusRowRings(
      summarizeProviderLimits([
        pool("grok", [window("weekly", 100, 9_900, "weekly")]),
        plan("grok", "Grok-B", [window("weekly", 0, 5_600, "weekly")]),
      ]),
      undefined,
      ["grok"],
    );
    // One plan out and one untouched is half of the two, not a full ring.
    expect(full[0]?.limits.tightest.usedPercent).toBe(50);
    expect(limitTone(full[0]!.limits.tightest.usedPercent)).toBe("ok");
  });

  it("offers combining only where a provider has several plans", () => {
    expect(combinableRingDrivers(providers).map((entry) => [entry.driver, entry.plans])).toEqual([
      ["claudeAgent", 2],
      ["grok", 2],
    ]);
  });
});

describe("limit presentation", () => {
  it("colours by headroom", () => {
    expect([10, 69, 70, 89, 90, 100].map(limitTone)).toEqual([
      "ok",
      "ok",
      "warn",
      "warn",
      "critical",
      "critical",
    ]);
  });

  it("says when the window resets", () => {
    expect(resetsInLabel(window("5h", 10, 134), NOW)).toBe("Resets in 2h 14m");
    expect(resetsInLabel(window("5h", 10, -1), NOW)).toBe("Reset time passed");
    expect(resetsInShort(window("5h", 10, -1), NOW)).toBeNull();
    expect(resetsInLabel(window("5h", 10, 0.5), NOW)).toBe("Resets in <1m");
    expect(resetsInShort(window("5h", 10, 0.5), NOW)).toBe("<1m");
    expect(resetsInLabel(window("5h", 10, null), NOW)).toBeNull();
  });

  it("counts down to the next future reset in a pooled window", () => {
    const expired = window("weekly", 90, -60);
    const upcoming = window("weekly", 40, 120);
    const pooled = { ...expired, resets: [...expired.resets, ...upcoming.resets] };
    expect(resetsInLabel(pooled, NOW)).toBe("Resets in 2h 0m");
    expect(resetsInShort(pooled, NOW)).toBe("2h 0m");
  });
});

describe("plan use", () => {
  const HOUR = 3_600_000;
  const thread = (
    instance: string,
    requestedAt: string | null,
    runtime: { status: "running" | "idle"; providerInstanceId: string } | null = null,
  ) =>
    ({
      environmentId: "mac",
      providerInstanceId: instance,
      latestRun: requestedAt === null ? null : { requestedAt, startedAt: null },
      runtime,
    }) as unknown as Parameters<typeof planRunsFromThreads>[0][number];

  it("reads each chat's latest run, on the plan a working one runs on", () => {
    const runs = planRunsFromThreads([
      thread("codex", new Date(NOW - HOUR).toISOString()),
      thread("claudeAgent", null),
      thread("claudeAgent", null, { status: "running", providerInstanceId: "claudeAgent_work" }),
    ]);
    expect(runs).toEqual([
      { sourceKey: "mac:codex", at: NOW - HOUR, working: false },
      { sourceKey: "mac:claudeAgent_work", at: 0, working: true },
    ]);
  });

  it("halves a run's weight each day, drops it after a week, and counts work going on most", () => {
    const use = planUse(
      [
        { sourceKey: "a", at: NOW, working: false },
        { sourceKey: "a", at: NOW - 24 * HOUR, working: false },
        { sourceKey: "b", at: NOW - 8 * 24 * HOUR, working: false },
        { sourceKey: "c", at: 0, working: true },
      ],
      NOW,
    );
    expect(use.get("a")).toBeCloseTo(1.5);
    expect(use.has("b")).toBe(false);
    expect(use.get("c")).toBe(3);
  });

  it("ranks by the server's hours when it has them, plans working now first", () => {
    const recentUse = new Map([
      ["mac:claudeAgent", 122],
      ["mac:grok", 6],
      ["mac:devin", 3.5],
    ]);
    const use = planUse(
      [
        // A chat's latest run counts nothing extra: the hours already hold every run.
        { sourceKey: "mac:grok", at: NOW, working: false },
        { sourceKey: "mac:devin", at: NOW, working: true },
      ],
      NOW,
      recentUse,
    );
    const ranked = [...use].sort((left, right) => right[1] - left[1]).map(([key]) => key);
    expect(ranked).toEqual(["mac:devin", "mac:claudeAgent", "mac:grok"]);
    expect(use.get("mac:grok")).toBe(6);
  });
});
