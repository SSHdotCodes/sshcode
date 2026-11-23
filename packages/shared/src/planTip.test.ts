import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { betterPlanTip } from "./planTip.ts";

const model = "claude-fable-5-2";
const selection = { instanceId: "claudeAgent", model };
const weekly = { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 65 } as const;
const fable = {
  id: "seven_day_fable",
  kind: "weekly",
  label: "Weekly · Fable",
  usedPercent: 85,
} as const;

function provider(
  instanceId: string,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: instanceId === "claudeAgent" ? "Claude" : "Max-2",
    continuation: { groupKey: "claude:home:/synthetic/.claude" },
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-16T12:00:00.000Z",
    models: [
      { slug: model, name: "Fable 5.2", isCustom: false, capabilities: null },
      { slug: "claude-opus-5-2", name: "Opus 5.2", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: "2026-11-16T12:00:00.000Z", windows },
    ...overrides,
  };
}

const own = provider("claudeAgent", [weekly, fable]);
const added = provider("claudeAgent_work", [
  { ...weekly, usedPercent: 2 },
  { ...fable, usedPercent: 3 },
]);

describe("betterPlanTip", () => {
  it("suggests the roomier plan for Fable and names its tightest window", () => {
    expect(betterPlanTip([own, added], selection)).toEqual({
      fromInstanceId: "claudeAgent",
      toInstanceId: "claudeAgent_work",
      reason: "more-room",
      windowLabel: "Weekly · Fable",
      fromRemainingPercent: 15,
      toRemainingPercent: 97,
    });
  });

  it("ignores the Fable window for Opus", () => {
    expect(betterPlanTip([own, added], { ...selection, model: "claude-opus-5-2" })).toBeNull();
  });

  it("recognizes an explicit limit before the percentage reaches 100", () => {
    expect(
      betterPlanTip([provider("claudeAgent", [{ ...weekly, limited: true }]), added], selection),
    ).toMatchObject({ reason: "limit-reached", windowLabel: "Weekly", fromRemainingPercent: 0 });
  });

  it.each([
    { enabled: false },
    { installed: false },
    { auth: { status: "unauthenticated" } },
    { models: [] },
    { usageLimits: undefined },
    { usageLimits: { ...added.usageLimits!, unavailable: { reason: "probeFailed" } } },
    { usageLimits: { ...added.usageLimits!, windows: [] } },
    { usageLimits: { ...added.usageLimits!, windows: [{ ...fable, label: "Weekly · Opus" }] } },
    { continuation: { groupKey: "claude:home:/synthetic/other" } },
    { continuation: undefined },
    { driver: ProviderDriverKind.make("codex") },
  ] satisfies ReadonlyArray<Partial<ServerProvider>>)(
    "rejects an ineligible other plan: %j",
    (overrides) => {
      expect(betterPlanTip([own, { ...added, ...overrides }], selection)).toBeNull();
    },
  );

  it("does not tip when the selected plan already has more room", () => {
    expect(betterPlanTip([own, added], { ...selection, instanceId: added.instanceId })).toBeNull();
  });

  it("can point from the added account back to the own account", () => {
    expect(
      betterPlanTip(
        [provider("claudeAgent", added.usageLimits!.windows), provider(added.instanceId, [fable])],
        { ...selection, instanceId: added.instanceId },
      ),
    ).toMatchObject({ fromInstanceId: added.instanceId, toInstanceId: own.instanceId });
  });

  it("chooses the candidate with the most headroom across all relevant windows", () => {
    const third = provider("claudeAgent_third", [{ ...weekly, usedPercent: 1 }]);
    expect(betterPlanTip([own, added, third], selection)?.toInstanceId).toBe(third.instanceId);
  });

  it.each([
    [80, 50, "more-room"],
    [79, 0, null],
    [80, 51, null],
    [100, 99, "limit-reached"],
    [100, 100, null],
  ])("uses the thresholds at %s%% and %s%% used", (from, to, reason) => {
    expect(
      betterPlanTip(
        [
          provider(own.instanceId, [{ ...weekly, usedPercent: from }]),
          provider(added.instanceId, [{ ...weekly, usedPercent: to }]),
        ],
        selection,
      )?.reason ?? null,
    ).toBe(reason);
  });

  it("treats unreadable selected limits and a missing selection or group as unknown", () => {
    expect(betterPlanTip([own, added], { ...selection, instanceId: "missing" })).toBeNull();
    for (const overrides of [
      { continuation: undefined },
      { usageLimits: undefined },
      { usageLimits: { ...own.usageLimits!, unavailable: { reason: "unsupported" as const } } },
      { usageLimits: { ...own.usageLimits!, windows: [] } },
    ]) {
      expect(betterPlanTip([{ ...own, ...overrides }, added], selection)).toBeNull();
    }
  });

  it("uses explicit modelIds for scoped windows, including an empty list", () => {
    for (const modelIds of [[], ["claude-opus-5-2"]]) {
      expect(
        betterPlanTip([provider(own.instanceId, [{ ...fable, modelIds }]), added], selection),
      ).toBeNull();
    }
    expect(
      betterPlanTip(
        [
          provider(own.instanceId, [{ ...fable, label: "Weekly · Other", modelIds: [model] }]),
          added,
        ],
        selection,
      )?.reason,
    ).toBe("more-room");
  });

  it("always includes account-wide windows, even if modelIds is present", () => {
    expect(
      betterPlanTip(
        [provider(own.instanceId, [{ ...weekly, usedPercent: 100, modelIds: [] }]), added],
        selection,
      )?.reason,
    ).toBe("limit-reached");
  });

  it("matches the final scope against normalized model names as well as slugs", () => {
    const named = {
      ...own,
      models: [{ ...own.models[0]!, slug: "custom-alias", name: "Fable 5.2" }],
    };
    const other = { ...added, models: named.models };
    expect(betterPlanTip([named, other], { ...selection, model: "custom-alias" })?.reason).toBe(
      "more-room",
    );
    expect(
      betterPlanTip(
        [provider(own.instanceId, [{ ...fable, label: "Weekly · Claude · F-a-b-l-e" }]), added],
        selection,
      )?.reason,
    ).toBe("more-room");
  });

  it("uses remainingPercent rounding and preserves fractional headroom", () => {
    expect(
      betterPlanTip(
        [provider(own.instanceId, [{ ...weekly, usedPercent: 85.4 }]), added],
        selection,
      )?.fromRemainingPercent,
    ).toBe(15);
    expect(
      betterPlanTip(
        [provider(own.instanceId, [{ ...weekly, usedPercent: 99.5, limited: false }]), added],
        selection,
      ),
    ).toMatchObject({ reason: "more-room", fromRemainingPercent: 0.5 });
  });
});
