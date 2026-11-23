import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { preferSiblingAccount } from "./siblingAccount.ts";

const model = "claude-fable-5-2";
const fable = (usedPercent: number): ServerProviderUsageWindow => ({
  id: "seven_day_fable",
  kind: "weekly",
  label: "Weekly · Fable",
  usedPercent,
});

function account(
  instanceId: string,
  windows: ReadonlyArray<ServerProviderUsageWindow> | null,
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
    models: [{ slug: model, name: "Fable 5.2", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    ...(windows === null
      ? {}
      : { usageLimits: { checkedAt: "2026-11-16T12:00:00.000Z", windows } }),
    ...overrides,
  };
}

const NOW = Date.parse("2026-11-16T12:00:00.000Z");
const pick = (
  current: ServerProvider,
  candidates: ReadonlyArray<ServerProvider>,
  limitReached = false,
  balance = true,
) => {
  const moved = preferSiblingAccount({
    current,
    candidates,
    model,
    limitReached,
    balance,
    now: NOW,
  });
  return moved ? [moved.provider.instanceId, moved.notice] : null;
};

describe("preferSiblingAccount", () => {
  it("starts work on the account with the most left to use", () => {
    const note = "Started on Max-2: it has the most left to use before its reset.";
    expect(
      pick(account("claudeAgent", [fable(94)]), [account("claudeAgent_work", [fable(4)])]),
    ).toEqual(["claudeAgent_work", note]);
    expect(
      pick(account("claudeAgent", [fable(40)]), [account("claudeAgent_work", [fable(4)])]),
    ).toEqual(["claudeAgent_work", note]);
    // The account asked for already has the most left, or about as much.
    expect(
      pick(account("claudeAgent", [fable(4)]), [account("claudeAgent_work", [fable(40)])]),
    ).toBeNull();
    expect(
      pick(account("claudeAgent", [fable(40)]), [account("claudeAgent_work", [fable(38)])]),
    ).toBeNull();
  });

  it("says which limit the account asked for is at or near", () => {
    expect(
      pick(account("claudeAgent", [fable(100)]), [account("claudeAgent_work", [fable(4)])]),
    ).toEqual(["claudeAgent_work", "Started on Max-2: Claude reached its Weekly · Fable limit."]);
    expect(
      pick(account("claudeAgent", [fable(98)]), [account("claudeAgent_work", [fable(4)])]),
    ).toEqual([
      "claudeAgent_work",
      "Started on Max-2: Claude has 2% of its Weekly · Fable limit left.",
    ]);
  });

  it("moves off an account refusing work even when no figures show it", () => {
    const note = "Started on Max-2: Claude reached its usage limit.";
    // No limits reported at all.
    expect(pick(account("claudeAgent", null), [account("claudeAgent_work", null)], true)).toEqual([
      "claudeAgent_work",
      note,
    ]);
    // Figures that still show the most room on the account that is refusing work.
    expect(
      pick(account("claudeAgent", [fable(30)]), [account("claudeAgent_work", [fable(50)])], true),
    ).toEqual(["claudeAgent_work", note]);
    // Without a refusal the same figures move nothing.
    expect(pick(account("claudeAgent", null), [account("claudeAgent_work", null)])).toBeNull();
    expect(
      pick(account("claudeAgent", [fable(30)]), [account("claudeAgent_work", [fable(50)])]),
    ).toBeNull();
  });

  it("keeps an account the agent named until it is out or refusing work", () => {
    const named = (current: ServerProvider, limitReached = false) => {
      const moved = preferSiblingAccount({
        current,
        candidates: [account("claudeAgent_work", [fable(4)])],
        model,
        limitReached,
        named: true,
        balance: true,
        now: NOW,
      });
      return moved ? [moved.provider.instanceId, moved.notice] : null;
    };
    // The other account has far more room; running low is still the agent's call.
    expect(named(account("claudeAgent", [fable(94)]))).toBeNull();
    expect(named(account("claudeAgent", [fable(98)]))).toBeNull();
    expect(named(account("claudeAgent", null))).toBeNull();
    // It cannot take the work at all.
    expect(named(account("claudeAgent", [fable(100)]))).toEqual([
      "claudeAgent_work",
      "Started on Max-2: Claude reached its Weekly · Fable limit.",
    ]);
    expect(named(account("claudeAgent", [fable(30)]), true)).toEqual([
      "claudeAgent_work",
      "Started on Max-2: Claude reached its usage limit.",
    ]);
  });

  it("stays put when the other account is out too, or is not a sibling", () => {
    const current = account("claudeAgent", [fable(100)]);
    expect(pick(current, [account("claudeAgent_work", [fable(100)])], true)).toBeNull();
    for (const other of [
      account("claudeAgent_work", [fable(4)], {
        continuation: { groupKey: "claude:home:/other" },
      }),
      account("claudeAgent_work", [fable(4)], { auth: { status: "unauthenticated" } }),
      account("claudeAgent_work", [fable(4)], { models: [] }),
      account("claudeAgent_work", [fable(4)], { driver: ProviderDriverKind.make("codex") }),
    ]) {
      expect(pick(current, [other], true)).toBeNull();
    }
  });

  it("takes the sibling with the most room left", () => {
    expect(
      pick(
        account("claudeAgent", null),
        [account("claudeAgent_work", [fable(80)]), account("claudeAgent_ultra3", [fable(10)])],
        true,
      )?.[0],
    ).toBe("claudeAgent_ultra3");
  });

  it("keeps the requested account with balancing off, including at a quota refusal", () => {
    const roomy = [account("claudeAgent_work", [fable(4)])];
    expect(pick(account("claudeAgent", [fable(100)]), roomy, false, false)).toBeNull();
    expect(pick(account("claudeAgent", [fable(30)]), roomy, true, false)).toBeNull();
  });
});
