import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { unavailableGoogleLimits } from "./usageLimits.ts";
import { betterPlanTip } from "./planTip.ts";

import {
  accountAcceptsModel,
  accountPickReason,
  accountPickSummary,
  accountSwitchTip,
  newSessionAccountKeys,
  pickAccountForNewSession,
  usageWindowsForModel,
} from "./accountBalance.ts";

const NOW = Date.parse("2026-11-17T08:00:00.000Z");
const HOUR = 3_600_000;
const inHours = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * HOUR));

const fable = "claude-fable-5-2";
const opus = "claude-opus-5-5";

function weekly(usedPercent: number, hoursLeft: number): ServerProviderUsageWindow {
  return {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedPercent,
    resetsAt: inHours(hoursLeft),
    windowDurationMins: 10_080,
  };
}

function weeklyFable(usedPercent: number, hoursLeft: number): ServerProviderUsageWindow {
  return { ...weekly(usedPercent, hoursLeft), id: "seven_day_fable", label: "Weekly · Fable" };
}

function session(usedPercent: number, hoursLeft = 3): ServerProviderUsageWindow {
  return {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent,
    resetsAt: inHours(hoursLeft),
    windowDurationMins: 300,
  };
}

function account(
  instanceId: string,
  windows: ReadonlyArray<ServerProviderUsageWindow> | null,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: instanceId,
    continuation: { groupKey: "claude:home:/synthetic/.claude" },
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", label: "Claude Ultra Subscription" },
    checkedAt: "2026-11-17T08:00:00.000Z",
    models: [
      { slug: fable, name: "Fable 5.2", isCustom: false, capabilities: null },
      { slug: opus, name: "Opus 5.5", isCustom: false, capabilities: null },
    ],
    slashCommands: [],
    skills: [],
    ...(windows === null
      ? {}
      : { usageLimits: { checkedAt: "2026-11-17T08:00:00.000Z", windows } }),
    ...overrides,
  };
}

const pick = (
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string,
  model = fable,
  accepts?: (provider: ServerProvider) => boolean,
) => pickAccountForNewSession(providers, { instanceId, model }, { now: NOW, accepts });

const names: Record<string, string> = { one: "Max 1", two: "Max 2" };
const reason = (
  providers: ReadonlyArray<ServerProvider>,
  instanceId: string,
  model = fable,
): string | null => {
  const picked = pick(providers, instanceId, model);
  return picked === null ? null : accountPickReason(picked, (id) => names[id] ?? id);
};

describe("usageWindowsForModel", () => {
  it("keeps the limits for every model and the model's own", () => {
    const provider = account("one", [weekly(10, 50), weeklyFable(20, 50), session(5)]);
    expect(usageWindowsForModel(provider, fable).map((window) => window.label)).toEqual([
      "Weekly",
      "Weekly · Fable",
      "Session",
    ]);
    expect(usageWindowsForModel(provider, opus).map((window) => window.label)).toEqual([
      "Weekly",
      "Session",
    ]);
  });

  it("goes by the models a limit names before its label", () => {
    const provider = account("one", [
      { ...weekly(100, 50), modelIds: [fable] },
      { ...weekly(10, 50), id: "other", label: "Weekly · Fable", modelIds: [opus] },
      { ...weekly(10, 50), id: "routed", label: "Routed", providerIds: ["opencode"] },
    ]);
    expect(usageWindowsForModel(provider, fable).map((window) => window.id)).toEqual(["seven_day"]);
    expect(usageWindowsForModel(provider, opus).map((window) => window.id)).toEqual(["other"]);
    expect(usageWindowsForModel(provider, "opencode/glm").map((window) => window.id)).toEqual([
      "routed",
    ]);
  });
});

describe("pickAccountForNewSession", () => {
  // The two plans as they stood on 2026-11-17: one near the end of its week, one new.
  const first = account("one", [weekly(75, 27), weeklyFable(94, 27)]);
  const second = account("two", [weekly(7, 53), weeklyFable(7, 53), session(14)]);

  it("keeps the selected Google plan until agy reports it has hit a limit", () => {
    const plan = (id: string) =>
      account(id, null, {
        driver: ProviderDriverKind.make("antigravity"),
        continuation: { groupKey: "antigravity" },
        auth: { status: "authenticated", type: "oauth-personal" },
        usageLimits: unavailableGoogleLimits(inHours(0)),
      });
    const ultra = plan("ultra");
    const pro = plan("pro");
    expect(pick([ultra, pro], "pro")?.instanceId).toBe("pro");
    const limited = {
      ...pro,
      recentFailure: {
        kind: "usage_limit" as const,
        message: "Individual quota reached.",
        occurredAt: inHours(0),
        resetAt: inHours(1),
      },
    };
    expect(pick([ultra, limited], "pro")?.instanceId).toBe("ultra");
    expect(
      pickAccountForNewSession(
        [ultra, limited],
        { instanceId: "pro", model: fable },
        { now: NOW + HOUR },
      )?.instanceId,
    ).toBe("pro");
  });

  it("starts on the account with the most left to use before its reset", () => {
    expect(pick([first, second], "one")?.instanceId).toBe("two");
    expect(pick([first, second], "one", opus)?.instanceId).toBe("two");
    expect(pick([first, second], "two")?.instanceId).toBe("two");
    expect(reason([first, second], "one")).toBe("it has the most left to use before its reset");
    expect(reason([first, second], "two")).toBeNull();
  });

  it("only balances a selected service tier onto an account that offers it", () => {
    const model = "gpt-6.2-sol";
    const plan = (id: string, size: number, used: number, tiers: string[]) =>
      account(id, [weekly(used, 48)], {
        driver: ProviderDriverKind.make("codex"),
        auth: { status: "authenticated", label: `ChatGPT Pro ${size}x Subscription` },
        models: [
          {
            slug: model,
            name: model,
            isCustom: false,
            capabilities: {
              optionDescriptors: [
                {
                  type: "select",
                  id: "serviceTier",
                  label: "Speed",
                  options: tiers.map((tier) => ({ id: tier, label: tier })),
                },
              ],
            },
          },
        ],
      });
    const large = plan("large", 20, 80, ["priority", "ultrafast"]);
    const small = plan("small", 10, 10, ["priority"]);
    const selected = (value: string) => ({
      instanceId: large.instanceId,
      model,
      options: [{ id: "serviceTier", value }],
    });
    const start = (value: string) =>
      pickAccountForNewSession([large, small], selected(value), { now: NOW })?.instanceId ??
      large.instanceId;
    expect(start("ultrafast")).toBe(large.instanceId);
    expect(start("priority")).toBe(small.instanceId);
    // A setting neither account's catalog describes (left from another model, or from a
    // harness that passes options through) is no reason to stop balancing.
    expect(
      pickAccountForNewSession(
        [large, small],
        { instanceId: large.instanceId, model, options: [{ id: "leftover", value: "x" }] },
        { now: NOW },
      )?.instanceId,
    ).toBe(small.instanceId);
    // Asked for on the account that lacks the speed, it starts where the speed exists.
    expect(
      pickAccountForNewSession(
        [large, small],
        {
          instanceId: small.instanceId,
          model,
          options: [{ id: "serviceTier", value: "ultrafast" }],
        },
        { now: NOW },
      )?.instanceId,
    ).toBe(large.instanceId);
  });

  it("a disabled seed or a failed catalog entry cannot win on quota", () => {
    const full = account("one", [weekly(10, 48)]);
    const busy = account("two", [weekly(80, 48)]);
    expect(
      pick([full, busy], "one", opus, (provider) => provider.instanceId !== "one")?.instanceId,
    ).toBe("two");
    for (const broken of [
      { ...full, status: "error" as const },
      {
        ...full,
        models: full.models.map((entry) => ({ ...entry, unavailableReason: "Model removed." })),
      },
    ]) {
      expect(pick([busy, broken], "two", opus)?.instanceId ?? "two").toBe("two");
    }
  });

  it("spends what would expire first", () => {
    const expiring = account("one", [weekly(60, 3)]);
    const fresh = account("two", [weekly(10, 100)]);
    expect(pick([expiring, fresh], "two")?.instanceId).toBe("one");
  });

  it("weighs plans by their size", () => {
    const plan = (instanceId: string, label: string, used: number, hoursLeft: number) =>
      account(instanceId, [weekly(used, hoursLeft)], {
        driver: ProviderDriverKind.make("codex"),
        continuation: { groupKey: "codex:home:/synthetic/.codex" },
        auth: { status: "authenticated", label },
      });
    const small = plan("one", "ChatGPT Pro 10x Subscription", 47, 144);
    // Half the share left, but of twice the plan.
    expect(
      pick([small, plan("two", "ChatGPT Pro 20x Subscription", 60, 144)], "one")?.instanceId,
    ).toBe("two");
    expect(
      pick([small, plan("two", "ChatGPT Pro 20x Subscription", 80, 144)], "two")?.instanceId,
    ).toBe("one");
    // Without a known size the shares compare as they are.
    expect(pick([small, plan("two", "Team", 60, 144)], "one")?.instanceId).toBe("one");
  });

  it("sizes plans by the allowance their names state, not by what they cost", () => {
    const plan = (instanceId: string, label: string, used: number) =>
      account(instanceId, [weekly(used, 100)], { auth: { status: "authenticated", label } });
    // Max 20x costs twice Max 5x and allows four times as much: 10% of it is more than 30%.
    const five = plan("one", "Claude Max 5x Subscription", 70);
    const twenty = plan("two", "Claude Max 20x Subscription", 90);
    expect(pick([five, twenty], "one")?.instanceId).toBe("two");
    // Ultra is the 20x plan under its new name.
    expect(pick([five, plan("two", "Claude Ultra Subscription", 90)], "one")?.instanceId).toBe(
      "two",
    );
  });

  it("passes over an account close to its session limit", () => {
    const busy = account("two", [weekly(7, 53), session(90)]);
    expect(pick([first, busy], "two")?.instanceId).toBe("one");
    expect(reason([first, busy], "two")).toBe("Max 2 has 10% of its Session limit left");
  });

  it("counts a part-used session limit against its account", () => {
    const even = account("one", [weekly(50, 80)]);
    const withSession = (used: number) => account("two", [weekly(50, 80), session(used)]);
    // Same weekly room: the account that cannot be cut short keeps the session.
    expect(pick([even, withSession(10)], "two")?.instanceId).toBe("one");
    // More weekly room makes up for a session limit with plenty left.
    const roomy = account("two", [weekly(10, 80), session(10)]);
    expect(pick([even, roomy], "one")?.instanceId).toBe("two");
  });

  it("leaves an account that is out or nearly out", () => {
    const out = account("one", [weekly(40, 50), { ...weeklyFable(100, 50), limited: true }]);
    expect(pick([out, second], "one")?.instanceId).toBe("two");
    expect(reason([out, second], "one")).toBe("Max 1 reached its Weekly · Fable limit");
    // The limit is Fable's own: another model still runs there.
    expect(pick([out, account("two", [weekly(90, 50)])], "one", opus)?.instanceId).toBe("one");

    const nearlyOut = account("one", [weekly(40, 2), weeklyFable(97, 2)]);
    expect(pick([nearlyOut, second], "one")?.instanceId).toBe("two");
    expect(reason([nearlyOut, second], "one")).toBe(
      "Max 1 has 3% of its Weekly · Fable limit left",
    );
  });

  it("counts an account as refilled once its reset time has passed", () => {
    // The reading is from before the reset: at its limit then, whole again now.
    const reset = account("one", [{ ...weekly(100, -1), limited: true }]);
    const partUsed = account("two", [weekly(60, 100)]);
    const picked = pick([partUsed, reset], "two");
    expect(picked?.instanceId).toBe("one");
    expect(picked?.standings.find((entry) => entry.instanceId === "one")).toMatchObject({
      state: "open",
      limit: { label: "Weekly", remainingPercent: 100, resetsAt: inHours(167) },
    });
    // A session limit that has reset no longer holds the account back.
    const rested = account("one", [weekly(10, 100), session(95, -0.5)]);
    expect(pick([rested, account("two", [weekly(50, 100)])], "two")?.instanceId).toBe("one");
  });

  it("stays put when every account is out", () => {
    const out = (instanceId: string) => account(instanceId, [weekly(100, 50)]);
    expect(pick([out("one"), out("two")], "one")?.instanceId).toBe("one");
    expect(pick([out("one"), out("two")], "two")?.instanceId).toBe("two");
    // Both refuse work while their last figures still show room: nothing says which is better.
    const refusing = (instanceId: string, used: number) =>
      account(instanceId, [weekly(used, 50)], {
        recentFailure: {
          kind: "usage_limit",
          message: "Usage limit reached.",
          occurredAt: inHours(-1),
          resetAt: inHours(2),
        },
      });
    expect(pick([refusing("one", 70), refusing("two", 10)], "one")?.instanceId).toBe("one");
  });

  it("holds an account with only a session limit to that limit", () => {
    const weeklyOnly = account("two", [weekly(10, 100)]);
    // Nearly out of its session: passed over although the session resets soon.
    expect(pick([account("one", [session(90, 1)]), weeklyOnly], "one")?.instanceId).toBe("two");
    // With room in its session it is paced by it, and a session refills within hours.
    expect(pick([account("one", [session(40, 4)]), weeklyOnly], "two")?.instanceId).toBe("one");
  });

  it("leaves an account that is refusing work, even without limit figures", () => {
    const refusing = account("one", null, {
      recentFailure: {
        kind: "usage_limit",
        message: "Usage limit reached.",
        occurredAt: inHours(-1),
        resetAt: inHours(2),
      },
    });
    expect(pick([refusing, account("two", null)], "one")?.instanceId).toBe("two");
    expect(reason([refusing, account("two", null)], "one")).toBe("Max 1 reached its usage limit");
    // The limit has reset since.
    const recovered = account("one", null, {
      recentFailure: {
        kind: "usage_limit",
        message: "Usage limit reached.",
        occurredAt: inHours(-3),
        resetAt: inHours(-1),
      },
    });
    expect(pick([recovered, account("two", null)], "one")?.instanceId).toBe("one");
  });

  it("prefers known room over an account that reports no limits", () => {
    const silent = account("one", null);
    expect(pick([silent, second], "one")?.instanceId).toBe("two");
    expect(reason([silent, second], "one")).toBe("it has room");
    expect(pick([second, silent], "two")?.instanceId).toBe("two");
    expect(pick([silent, account("two", null)], "one")?.instanceId).toBe("one");
  });

  it("says an account with no more left is ahead for its sooner reset", () => {
    // Two Grok plans as they stood on 2026-11-17: 98% and 97% left, three days apart.
    const later = account("one", [weekly(2, 151)]);
    const sooner = account("two", [weekly(3, 79)]);
    expect(pick([later, sooner], "one")?.instanceId).toBe("two");
    expect(reason([later, sooner], "one")).toBe(
      "its limit resets sooner, so what is left on it is used first",
    );
    // More left and a sooner reset: having more is the reason that reads true on the rows.
    const fuller = account("two", [weekly(3, 79)]);
    const emptier = account("one", [weekly(60, 151)]);
    expect(reason([emptier, fuller], "one")).toBe("it has the most left to use before its reset");
  });

  it("does not call an account out while its provider still allows requests", () => {
    const refused = account("one", [{ ...weekly(100, 50), limited: true }]);
    const allowed = account("two", [{ ...weekly(100, 50), limited: false }]);
    const picked = pick([refused, allowed], "one");
    expect(picked?.instanceId).toBe("two");
    expect(picked?.standings.map((standing) => standing.state)).toEqual(["out", "tight"]);
  });

  it("keeps the account asked for on a near tie", () => {
    const left = account("one", [weekly(50, 80)]);
    const right = account("two", [weekly(48, 80)]);
    expect(pick([left, right], "one")?.instanceId).toBe("one");
    expect(pick([left, right], "two")?.instanceId).toBe("two");
  });

  it("says why new sessions start where they do, whichever account was asked for", () => {
    const summary = (providers: ReadonlyArray<ServerProvider>, instanceId: string) => {
      const picked = pick(providers, instanceId);
      return picked === null ? null : accountPickSummary(picked, (id) => names[id] ?? id);
    };
    expect(summary([first, second], "one")).toBe("it has the most left to use before its reset");
    expect(summary([second, first], "two")).toBe("it has the most left to use before its reset");
    const out = account("one", [weekly(40, 50), { ...weeklyFable(100, 50), limited: true }]);
    expect(summary([second, out], "two")).toBe("Max 1 reached its Weekly · Fable limit");
    const left = account("one", [weekly(50, 80)]);
    const right = account("two", [weekly(48, 80)]);
    expect(summary([left, right], "one")).toBe(
      "both have about the same to use per hour until their resets",
    );
    expect(summary([first], "one")).toBeNull();
  });

  it("only considers accounts that share the chat and can run the model", () => {
    const other = (overrides: Partial<ServerProvider>) =>
      account("two", [weekly(1, 100)], overrides);
    expect(pick([first], "one")).toBeNull();
    expect(
      pick([first, other({ continuation: { groupKey: "claude:home:/elsewhere" } })], "one"),
    ).toBeNull();
    expect(pick([first, other({ driver: ProviderDriverKind.make("codex") })], "one")).toBeNull();
    expect(pick([first, other({ enabled: false })], "one")).toBeNull();
    expect(pick([first, other({ auth: { status: "unauthenticated" } })], "one")).toBeNull();
    expect(pick([first, other({ models: [] })], "one")).toBeNull();
    expect(pick([first, second], "one", fable, () => false)).toBeNull();
    expect(pick([first, second], "missing")).toBeNull();
  });
});

describe("accountSwitchTip", () => {
  const nameOf = (instanceId: string) => (instanceId === "one" ? "Max 1" : "Max 2");
  const tip = (providers: ReadonlyArray<ServerProvider>, instanceId = "one") =>
    accountSwitchTip(providers, { instanceId, model: fable }, { now: NOW, nameOf });

  it("offers the other account when this one is nearly out for the chat's model", () => {
    expect(
      tip([
        account("one", [weekly(60, 30), weeklyFable(97, 30)]),
        account("two", [weekly(10, 60), weeklyFable(15, 60)]),
      ]),
    ).toEqual({
      fromInstanceId: "one",
      toInstanceId: "two",
      reason: "Max 1 has 3% of its Weekly · Fable limit left",
    });
  });

  it("offers it when this account reached a limit", () => {
    expect(tip([account("one", [weekly(100, 30)]), account("two", [weekly(10, 60)])])?.reason).toBe(
      "Max 1 reached its Weekly limit",
    );
  });

  it("offers it once a tenth or less of a long limit is left", () => {
    expect(tip([account("one", [weekly(92, 30)]), account("two", [weekly(10, 60)])])?.reason).toBe(
      "Max 1 has 8% of its Weekly limit left",
    );
    // The other account must have clearly more: 30% against 8% is not worth a re-read.
    expect(tip([account("one", [weekly(92, 30)]), account("two", [weekly(70, 60)])])).toBeNull();
  });

  it("stays quiet when this account resets before it would run out", () => {
    // New chats stay here too: what is left must be used within the hour or it is lost.
    expect(tip([account("one", [weekly(92, 1)]), account("two", [weekly(10, 100)])])).toBeNull();
  });

  it("stays quiet while this account still has working room, however much more the other has", () => {
    // New chats would start on the second account, but moving a running chat re-reads it.
    const providers = [account("one", [weekly(75, 30)]), account("two", [weekly(5, 60)])];
    expect(
      pickAccountForNewSession(providers, { instanceId: "one", model: fable }, { now: NOW }),
    ).toMatchObject({ instanceId: "two" });
    expect(tip(providers)).toBeNull();
  });

  it("stays quiet when the other account is no better off, or reports no limits", () => {
    expect(tip([account("one", [weekly(97, 30)]), account("two", [weekly(98, 60)])])).toBeNull();
    expect(tip([account("one", [weekly(97, 30)]), account("two", null)])).toBeNull();
  });

  it("has nothing to offer a chat on a provider with one account", () => {
    expect(tip([account("one", [weekly(100, 30)])])).toBeNull();
  });
});

describe("newSessionAccountKeys", () => {
  const first = account("one", [weekly(75, 27)]);
  const second = account("two", [weekly(7, 53)]);
  const alone = account("solo", [weekly(10, 50)], {
    continuation: { groupKey: "claude:home:/elsewhere" },
  });
  const machine = (settings?: { balanceAccounts: boolean }) =>
    new Map([
      [
        EnvironmentId.make("mac"),
        {
          entry: { target: { label: "Mac" } },
          serverConfig: { providers: [first, second, alone], ...(settings ? { settings } : {}) },
        },
      ],
    ]);

  it("marks the account new sessions start on, for providers with more than one", () => {
    expect([...newSessionAccountKeys(machine({ balanceAccounts: true }), NOW)]).toEqual([
      "mac:two",
    ]);
  });

  it("omits a model hidden on the roomier account from the default-model marker", () => {
    const env = EnvironmentId.make("mac");
    const entry = machine().get(env)!;
    const settings = {
      balanceAccounts: true,
      providerModelPreferences: {
        [second.instanceId]: {
          hiddenModels: [fable],
          modelOrder: [],
        },
      },
    };
    const selected = new Map([
      [env, { ...entry, serverConfig: { ...entry.serverConfig, settings } }],
    ]);
    expect(newSessionAccountKeys(selected, NOW)).not.toContain("mac:two");
  });

  it("marks nothing where balancing is off", () => {
    expect(newSessionAccountKeys(machine(), NOW).size).toBe(0);
    expect(newSessionAccountKeys(machine({ balanceAccounts: false }), NOW).size).toBe(0);
    expect(newSessionAccountKeys(machine({ balanceAccounts: true }), NOW).size).toBe(1);
  });
});

describe("accountAcceptsModel", () => {
  const project = ProjectId.make("project-a");
  const one = account("one", null);
  const two = account("two", null);

  it("leaves out an account disabled for the project or with the model hidden", () => {
    const accepts = accountAcceptsModel(
      {
        providerInstances: {
          [one.instanceId]: { driver: one.driver },
          [two.instanceId]: { driver: two.driver },
        },
        projectSettingsOverrides: {
          [project]: { providerInstances: { [two.instanceId]: { enabled: false } } },
        },
        providerModelPreferences: { [one.instanceId]: { hiddenModels: [opus] } },
      } as unknown as Parameters<typeof accountAcceptsModel>[0],
      project,
    );
    expect(accepts(one, fable)).toBe(true);
    expect(accepts(one, opus)).toBe(false);
    expect(accepts(two, fable)).toBe(false);
  });

  it("accepts everything without settings to go by", () => {
    expect(accountAcceptsModel(null, null)(one, fable)).toBe(true);
  });
});

it("judges a scoped refusal only for its covered model", () => {
  const first = account("claudeAgent", [weekly(10, 48)], {
    recentFailure: {
      kind: "usage_limit",
      modelIds: [fable],
      message: "Limit reached.",
      occurredAt: inHours(-1),
      resetAt: inHours(48),
    },
  });
  const second = account("claudeAgent_work", [weekly(60, 48)]);
  const pick = (model: string) =>
    pickAccountForNewSession(
      [first, second],
      { instanceId: first.instanceId, model },
      { now: NOW },
    );
  expect(pick(opus)?.instanceId).toBe(first.instanceId);
  expect(pick(opus)?.standings[0]?.state).toBe("open");
  expect(pick(fable)?.instanceId).toBe(second.instanceId);
  expect(pick(fable)?.standings[0]?.state).toBe("out");
});

describe("what holds an account back", () => {
  const nameOf = (id: string) => names[id] ?? id;
  const other = account("two", [weekly(60, 48)]);

  it("names the session limit when that is the one that crossed its threshold", () => {
    // 9% of the weekly limit is above its 5% threshold; 12% of the session is under its 15%.
    const held = account("one", [weekly(91, 48), session(88, 3)]);
    expect(reason([held, other], "one")).toBe("Max 1 has 12% of its Session limit left");
    // Both short: the limit that takes longest to come back is the one to name.
    const short = account("one", [weekly(97, 48), session(88, 3)]);
    expect(reason([short, other], "one")).toBe("Max 1 has 3% of its Weekly limit left");
  });

  it("does not call trouble with the account a usage limit", () => {
    const troubled = (kind: NonNullable<ServerProvider["recentFailure"]>["kind"]) =>
      account("one", [weekly(10, 48)], {
        recentFailure: {
          kind,
          message: "Refused.",
          occurredAt: inHours(-0.1),
          resetAt: inHours(1),
        },
      });
    expect(reason([troubled("authentication_error"), other], "one")).toBe("Max 1 is signed out");
    expect(reason([troubled("billing_error"), other], "one")).toBe("Max 1 has a billing problem");
    expect(reason([troubled("subscription_error"), other], "one")).toBe(
      "Max 1's plan was turned down by the provider",
    );
    expect(reason([troubled("usage_limit"), other], "one")).toBe("Max 1 reached its usage limit");
    expect(pick([troubled("authentication_error"), other], "one")?.standings[0]).toMatchObject({
      state: "out",
      refusal: "sign-in",
      blockedBy: null,
    });
  });

  it("offers a running chat its other account when its own refuses work on a roomy reading", () => {
    const refusing = account("one", [weekly(10, 48)], {
      recentFailure: {
        kind: "usage_limit",
        message: "Usage limit reached.",
        occurredAt: inHours(-0.1),
        resetAt: inHours(2),
      },
    });
    expect(
      accountSwitchTip(
        [refusing, other],
        { instanceId: "one", model: fable },
        { now: NOW, nameOf },
      ),
    ).toEqual({
      fromInstanceId: "one",
      toInstanceId: "two",
      reason: "Max 1 reached its usage limit",
    });
  });

  it("gives a chat not sent yet no tip to leave the account new sessions start on", () => {
    // 15% that expires in four hours is used first; the other account keeps its 80% for six days.
    const expiring = [account("one", [weekly(85, 4)]), account("two", [weekly(20, 144)])];
    const selection = { instanceId: "one", model: fable };
    expect(pick(expiring, "one")?.instanceId).toBe("one");
    expect(betterPlanTip(expiring, selection)?.toInstanceId).toBe("two");
    expect(betterPlanTip(expiring, selection, { now: NOW })).toBeNull();
    // Picked by hand on the account new sessions leave: the tip points where they go.
    const pinned = [account("one", [weekly(85, 100)]), account("two", [weekly(20, 144)])];
    expect(pick(pinned, "one")?.instanceId).toBe("two");
    expect(betterPlanTip(pinned, selection, { now: NOW })?.toInstanceId).toBe("two");
  });
});
