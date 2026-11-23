import { describe, expect, it } from "vite-plus/test";
import {
  applyUsageLimitsUpdate,
  resolveUsageLimitsAfterProbe,
} from "@t3tools/provider-core/server/usageLimits";
import { remainingPercentLabel } from "@t3tools/shared/usageLimits";

import { claudeRateLimitEventToUpdate, claudeUsageResponseToLimits } from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  it("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            // Newer CLIs add this on top of the typed keys; the pinned SDK
            // typings do not know it yet.
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
        ],
      },
    });
  });

  it("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  it("reports API key and Bedrock accounts as unsupported", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: false, rate_limits: null },
      }).limits,
    ).toEqual({ checkedAt, windows: [], unavailable: { reason: "unsupported" } });
  });

  // Claude Code answers this way when its usage request fails, a login it could not
  // renew included: the account has limits, they just could not be read this time.
  it("reports a subscription whose limits could not be read as a failed reading", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: { rate_limits_available: true, rate_limits: null },
      }).limits,
    ).toEqual({ checkedAt, windows: [], unavailable: { reason: "probeFailed" } });
  });

  it("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });
});

describe("claudeRateLimitEventToUpdate", () => {
  it.each([0.99, 0.996])(
    "merges the allowed event's %s utilization and survives a rounded probe",
    (utilization) => {
      const probe = claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: { seven_day: { utilization: 100, resets_at: "2026-07-24T08:59:00Z" } },
        },
      }).limits;
      const update = claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization,
          resetsAt: Date.parse("2026-07-24T08:59:00Z") / 1000,
          overageStatus: "rejected",
        },
        noNames,
      )!;
      const live = applyUsageLimitsUpdate({
        previous: probe,
        update,
        checkedAt: "2026-07-18T10:01:00.000Z",
      });
      expect(live?.windows[0]).toMatchObject({ usedPercent: utilization * 100, limited: false });
      expect(remainingPercentLabel(live!.windows[0]!)).toBe(utilization === 0.99 ? "1%" : "<1%");
      const refreshed = resolveUsageLimitsAfterProbe({
        published: live,
        probed: { ...probe, checkedAt: "2026-07-18T10:02:00.000Z" },
      });
      expect(refreshed?.windows[0]?.limited).toBe(false);
      expect(remainingPercentLabel(refreshed!.windows[0]!)).toBe("<1%");
    },
  );

  it.each([
    ["allowed", 1, false],
    ["allowed_warning", 0.99, false],
    ["allowed_warning", 0.996, false],
    ["rejected", 0.996, true],
  ] as const)("keeps the %s verdict at utilization %s", (status, utilization, limited) => {
    const update = claudeRateLimitEventToUpdate(
      {
        status,
        rateLimitType: "seven_day",
        utilization,
        overageStatus: "rejected",
        overageDisabledReason: "out_of_credits",
      },
      noNames,
    );
    expect(update?.windows[0]).toMatchObject({ usedPercent: utilization * 100, limited });
  });

  it("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent: 85,
          limited: false,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  it("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    // No probe has named the bucket yet: guessing would open a stray row.
    expect(claudeRateLimitEventToUpdate(event, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          usedPercent: 40,
          limited: false,
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("ignores windows the page does not render and events without a utilization", () => {
    expect(
      claudeRateLimitEventToUpdate(
        { status: "allowed", rateLimitType: "seven_day_opus", utilization: 0.1 },
        noNames,
      ),
    ).toBeUndefined();
    expect(
      claudeRateLimitEventToUpdate({ status: "rejected", rateLimitType: "five_hour" }, noNames),
    ).toBeUndefined();
  });

  it("reads every window an event lists, so one turn fills all the rows", () => {
    // Shape of a real event: no top-level utilization, all windows listed.
    const event = {
      status: "allowed",
      resetsAt: 1794876600,
      rateLimitType: "five_hour",
      unifiedWindows: {
        five_hour: { utilization: 0.09, resetsAt: 1794876600, status: "allowed" },
        seven_day: { utilization: 0.01, resetsAt: 1795096800, status: "allowed" },
        seven_day_overage_included: { utilization: 0.02, resetsAt: 1795096800, status: "allowed" },
        seven_day_opus: { utilization: 0.5, resetsAt: 1795096800, status: "allowed" },
        broken: { resetsAt: 1 },
      },
    } as Parameters<typeof claudeRateLimitEventToUpdate>[0];
    const update = claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" });
    expect(update?.windows.map((window) => [window.id, Math.round(window.usedPercent)])).toEqual([
      ["five_hour", 9],
      ["seven_day", 1],
      ["seven_day_fable", 2],
    ]);
    expect(update?.windows[1]).toMatchObject({
      resetsAt: "2026-11-19T14:00:00.000Z",
      limited: false,
    });
    // Without a probe-named bucket the scoped window is left out, the rest stay.
    expect(
      claudeRateLimitEventToUpdate(event, noNames)?.windows.map((window) => window.id),
    ).toEqual(["five_hour", "seven_day"]);
  });

  it("gives the window an event is about the event's own verdict", () => {
    const update = claudeRateLimitEventToUpdate(
      {
        status: "rejected",
        rateLimitType: "seven_day",
        utilization: 1,
        resetsAt: 1795096800,
        unifiedWindows: {
          seven_day: { utilization: 0.99, resetsAt: 1795096800, status: "allowed" },
        },
      } as Parameters<typeof claudeRateLimitEventToUpdate>[0],
      noNames,
    );
    expect(update?.windows).toHaveLength(1);
    expect(update?.windows[0]).toMatchObject({ id: "seven_day", usedPercent: 100, limited: true });
  });
});
