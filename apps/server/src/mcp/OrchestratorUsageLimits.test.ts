import {
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatOutOfCredit } from "@t3tools/client-runtime/providerHealth";
import { accountUnavailable } from "../provider/accountAvailability.ts";
import { collectUsageLimits } from "./OrchestratorUsageLimits.ts";

describe("usage limits report", () => {
  const checkedAt = "2026-11-10T12:00:00.000Z";
  const now = Date.parse(checkedAt);
  const window = {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly Fable",
    usedPercent: 87,
    recentPercentPerHour: 13,
    resetsAt: "2026-11-11T12:00:00.000Z",
  } as const;
  const provider: ServerProvider = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt, windows: [window] },
  };

  it.each([
    [13, "~1h"],
    [26, "~30m"],
    [13 / 3, "~3h"],
  ])("appends a short run-out estimate at %s points per hour", (recentPercentPerHour, text) => {
    const result = collectUsageLimits(
      [{ ...provider, usageLimits: { checkedAt, windows: [{ ...window, recentPercentPerHour }] } }],
      [],
      now,
      {},
    );
    expect(result.providers[0]?.summary).toContain(
      `Weekly Fable: 87% used (resets in 1d 0h); ${text} left at current pace`,
    );
    expect(result.providers[0]?.windows[0]?.recentPercentPerHour).toBe(recentPercentPerHour);
  });

  it.each([
    { recentPercentPerHour: undefined },
    { recentPercentPerHour: 4 },
    { resetsAt: "2026-11-10T12:30:00.000Z" },
    { limited: true },
    { usedPercent: 100 },
  ])("omits run-out estimates without an active recent projection: %j", (overrides) => {
    expect(
      collectUsageLimits(
        [{ ...provider, usageLimits: { checkedAt, windows: [{ ...window, ...overrides }] } }],
        [],
        now,
        {},
      ).providers[0]?.summary,
    ).not.toContain("left at current pace");
  });

  it("does not present a stale estimate as current pace", () => {
    const summary = collectUsageLimits([provider], [], now + 11 * 60_000, {}).providers[0]?.summary;
    expect(summary).toContain("; stale");
    expect(summary).not.toContain("left at current pace");
  });

  it("includes the estimate in extra usage source accounts too", () => {
    const result = collectUsageLimits(
      [],
      [
        {
          id: UsageLimitSourceId.make("hub"),
          kind: "cliproxy",
          label: "Hub",
          checkedAt,
          accounts: [
            { id: "a", driver: provider.driver, usageLimits: { checkedAt, windows: [window] } },
          ],
        },
      ],
      now,
      {},
    );
    expect(result.sources[0]?.accounts[0]?.summary).toContain("; ~1h left at current pace");
  });

  it("reports account failure even without a quota reading", () => {
    const report = collectUsageLimits(
      [
        {
          instanceId: ProviderInstanceId.make("kimi"),
          driver: ProviderDriverKind.make("acpRegistry"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready",
          auth: { status: "authenticated" },
          checkedAt: "2026-11-08T12:00:00.000Z",
          models: [],
          slashCommands: [],
          skills: [],
          recentFailure: {
            kind: "billing_error",
            message: "Budget exhausted.",
            occurredAt: "2026-11-08T12:00:00.000Z",
            resetAt: "2026-11-08T18:00:00.000Z",
          },
        },
      ],
      [],
      Date.parse("2026-11-08T12:00:00.000Z"),
      {},
    );
    expect(report.providers[0]?.summary).toBe(
      "Account unavailable: Budget exhausted. Recheck 2026-11-08T18:00:00.000Z.",
    );
    expect(report.providers[0]?.windows).toEqual([]);
    const original = report.providers[0]!;
    const failure = {
      kind: "billing_error",
      outOfCredit: true,
      message: "Budget exhausted.",
      occurredAt: original.checkedAt,
    } as const;
    const provider = {
      instanceId: original.providerInstanceId,
      driver: original.driver,
      enabled: true,
      checkedAt: original.checkedAt,
      recentFailure: failure,
    } as ServerProvider;
    expect(
      collectUsageLimits([provider], [], Date.parse("2030-01-01"), {}).providers[0]?.summary,
    ).toBe(formatOutOfCredit(failure));
    expect(accountUnavailable(provider, Date.parse("2030-01-01"))).toEqual({
      reason: formatOutOfCredit(failure),
    });
  });
  it("reports a confirmed sign-out with its sign-in command for as long as it stands", () => {
    const reason =
      "Signed out. Sign in again with `CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude auth login`.";
    const provider: ServerProvider = {
      instanceId: ProviderInstanceId.make("claudeAgent_work"),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName: "Work",
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-11-22T19:58:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: {
        checkedAt: "2026-11-22T10:00:00.000Z",
        windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 40 }],
        unavailable: { reason: "probeFailed" },
      },
      // Confirmed by a limits read that failed too: no retry time.
      recentFailure: {
        kind: "authentication_error",
        message: reason,
        occurredAt: "2026-11-22T19:57:50.479Z",
      },
    };
    const nextDay = Date.parse("2026-11-23T19:57:50.479Z");
    expect(accountUnavailable(provider, nextDay)).toEqual({ reason });
    const summary = collectUsageLimits([provider], [], nextDay, {}).providers[0]?.summary;
    expect(summary).toBe(reason);
    expect(summary).not.toContain("unsupported");
  });

  it.each([false, true])("carries the %s verdict and honest summary to agents", (limited) => {
    const checkedAt = "2026-10-27T12:00:00.000Z";
    const provider: ServerProvider = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt,
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: {
        checkedAt,
        windows: [{ id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100, limited }],
      },
    };
    const report = collectUsageLimits([provider], [], Date.parse(checkedAt), {});
    expect(report.providers[0]?.windows[0]).toMatchObject({ usedPercent: 100, limited });
    expect(report.providers[0]?.summary).toContain(limited ? "100% used" : "<1% left");
  });
});
