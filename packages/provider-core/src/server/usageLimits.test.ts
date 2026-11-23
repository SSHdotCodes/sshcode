import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./usageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it.each(["modelIds", "providerIds"] as const)("publishes changes to %s coverage", (field) => {
    const previous = { ...published, windows: [{ ...session, [field]: ["a"] }] };
    const unchanged = applyUsageLimitsUpdate({
      previous,
      checkedAt,
      update: { windows: [{ ...session, [field]: ["a"] }] },
    });
    expect(unchanged).toBe(previous);
    for (const ids of [["b"], [], undefined]) {
      const next = applyUsageLimitsUpdate({
        previous,
        checkedAt,
        update: { windows: [{ ...session, ...(ids === undefined ? {} : { [field]: ids }) }] },
      });
      expect(next).not.toBe(previous);
      expect(next?.windows[0]?.[field]).toEqual(ids);
    }
  });

  it("publishes a verdict change even when the percentage stays the same", () => {
    const previous = { ...published, windows: [{ ...session, usedPercent: 100, limited: false }] };
    const next = applyUsageLimitsUpdate({
      previous,
      checkedAt,
      update: { windows: [{ ...session, usedPercent: 100, limited: true }] },
    });
    expect(next).not.toBe(previous);
    expect(next?.windows[0]?.limited).toBe(true);
    const recovered = applyUsageLimitsUpdate({
      previous: next,
      checkedAt,
      update: { windows: [{ ...session, usedPercent: 100, limited: false }] },
    });
    expect(recovered?.windows[0]?.limited).toBe(false);
    expect(
      applyUsageLimitsUpdate({ previous: next, checkedAt, update: { windows: next!.windows } }),
    ).toBe(next);
  });

  it("keeps a verdict on sparse updates but clears it for a new reset", () => {
    const previous = { ...published, windows: [{ ...session, limited: true }] };
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt,
        update: { windows: [{ ...session, usedPercent: 100 }] },
      })?.windows[0]?.limited,
    ).toBe(true);
    expect(
      applyUsageLimitsUpdate({
        previous,
        checkedAt,
        update: { windows: [{ ...session, usedPercent: 0, resetsAt: "2026-09-03T19:00:00.000Z" }] },
      })?.windows[0]?.limited,
    ).toBeUndefined();
  });

  it("returns the published object itself when no window moved", () => {
    // Codex repeats the same numbers beside every token-usage tick; the
    // ingestion path relies on identity to skip the publish.
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("moves an unchanged reading's time on once a minute so it never reads stale", () => {
    const update = { windows: [{ ...weekly }, { ...session }] };
    const later = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:20:00.000Z",
      update,
    });
    expect(later).not.toBe(published);
    expect(later).toEqual({ ...published, checkedAt: "2026-09-03T12:20:00.000Z" });
    // Within the minute the refreshed object itself comes back again.
    expect(
      applyUsageLimitsUpdate({ previous: later, checkedAt: "2026-09-03T12:20:30.000Z", update }),
    ).toBe(later);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55 }, weekly],
      resetCredits,
    });
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("fills missing runtime metadata from a full probe without losing newer usage", () => {
    const live = {
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ id: "primary", kind: "other" as const, label: "Usage", usedPercent: 48 }],
    };
    const probed = { checkedAt, windows: [{ ...weekly, id: "primary", usedPercent: 47 }] };
    expect(resolveUsageLimitsAfterProbe({ published: live, probed })).toEqual({
      checkedAt: live.checkedAt,
      windows: [{ ...probed.windows[0], usedPercent: 48 }],
    });
    const explicit = { ...live, windows: [{ ...session, id: "primary", usedPercent: 48 }] };
    expect(resolveUsageLimitsAfterProbe({ published: explicit, probed })?.windows).toEqual(
      explicit.windows,
    );
  });

  it.each([false, true])(
    "keeps the last %s verdict through later probes in the same window",
    (limited) => {
      const live = { ...published, windows: [{ ...session, usedPercent: 99.6, limited }] };
      const probed = {
        checkedAt: "2026-09-03T12:05:00.000Z",
        windows: [{ ...session, usedPercent: 100 }, weekly],
      };
      const next = resolveUsageLimitsAfterProbe({ published: live, probed });
      expect(next).toEqual({
        ...probed,
        windows: [{ ...session, usedPercent: 99.6, limited }, weekly],
      });
    },
  );

  it("takes a newer probe's changed usage without losing the verdict", () => {
    const live = { ...published, windows: [{ ...session, usedPercent: 99, limited: false }] };
    const probed = {
      checkedAt: "2026-09-03T12:05:00.000Z",
      windows: [{ ...session, usedPercent: 100 }],
    };
    expect(resolveUsageLimitsAfterProbe({ published: live, probed })?.windows[0]).toEqual({
      ...session,
      usedPercent: 100,
      limited: false,
    });
  });

  it("starts a new reset without the old verdict or utilization", () => {
    const live = { ...published, windows: [{ ...session, usedPercent: 99.6, limited: true }] };
    const probed = {
      checkedAt: "2026-09-03T15:00:00.000Z",
      windows: [{ ...session, usedPercent: 0, resetsAt: "2026-09-03T19:00:00.000Z" }],
    };
    expect(resolveUsageLimitsAfterProbe({ published: live, probed })).toBe(probed);
  });

  it("keeps newer live windows while taking metadata from a successful probe", () => {
    const live = {
      ...published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 95 }],
    };
    const probed = { ...published, resetCredits: { availableCount: 1 } };
    expect(resolveUsageLimitsAfterProbe({ published: live, probed })).toEqual({
      ...probed,
      checkedAt: live.checkedAt,
      windows: live.windows,
    });
    const sameTime = { ...probed, checkedAt: live.checkedAt };
    expect(resolveUsageLimitsAfterProbe({ published: live, probed: sameTime })).toBe(sameTime);
  });
  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });
});
