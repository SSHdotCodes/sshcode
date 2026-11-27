import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  accountsByRoom,
  accountPinAfterPick,
  accountResetLabel,
  accountRoomLabel,
  accountRouteStep,
  rankAccountRoutes,
  accountStandings,
  routeStanding,
  sameAccountPool,
} from "./accountRoutes.ts";
import {
  type ModelRouteSource,
  defaultModelRoute,
  groupModelsByMaker,
  rememberChosenModelRoute,
} from "./modelMakers.ts";

// Reset labels read the viewer's clock; pin one that is not New York's.
vi.stubEnv("TZ", "America/Los_Angeles");

const NOW = Date.parse("2026-11-17T08:00:00.000Z");
const model = "claude-fable-5-2";

function account(instanceId: string, displayName: string, usedPercent: number): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName,
    continuation: { groupKey: "claude:home:/synthetic/.claude" },
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-17T08:00:00.000Z",
    models: [{ slug: model, name: "Fable 5.2", isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-11-17T08:00:00.000Z",
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent,
          resetsAt: "2026-11-19T08:00:00.000Z",
          windowDurationMins: 10_080,
        },
      ],
    },
  };
}

const first = account("claudeAgent", "Max 1", 90);
const second = account("claudeAgent_work", "Max 2", 10);
const gateway: ServerProvider = {
  ...account("opencode", "OpenCode", 0),
  driver: ProviderDriverKind.make("opencode"),
  continuation: { groupKey: "opencode:instance:opencode" },
};
const providers = [first, second, gateway];

const sources = providers.map((provider): ModelRouteSource => ({
  instanceId: provider.instanceId,
  driver: provider.driver,
  instanceName: provider.displayName ?? provider.instanceId,
  slug: model,
  name: "Fable 5.2",
  isLegacy: false,
}));
const fable = groupModelsByMaker(sources)[0]!.models[0]!;
const routeOn = (instanceId: string) =>
  fable.routes.find((route) => route.source.instanceId === instanceId)!;

describe("accountRouteStep", () => {
  it("opens a new chat's model on the account with the most to spare", () => {
    const route = defaultModelRoute(fable, { account: accountRouteStep(providers, { now: NOW }) });
    expect(route?.source.instanceId).toBe("claudeAgent_work");
    // Without the step the first account is the default.
    expect(defaultModelRoute(fable)?.source.instanceId).toBe("claudeAgent");
  });

  it("keeps a selected option on its capable account even when search begins on the sibling", () => {
    const pool = [first, second].map((provider) => ({
      ...provider,
      models: provider.models.map((entry) => ({
        ...entry,
        capabilities: {
          optionDescriptors: [
            {
              type: "select" as const,
              id: "speed",
              label: "Speed",
              options: (provider === first ? ["standard", "fast"] : ["standard"]).map((id) => ({
                id,
                label: id,
              })),
            },
          ],
        },
      })),
    }));
    const selection = {
      instanceId: first.instanceId,
      model,
      options: [{ id: "speed", value: "fast" }],
    };
    const session = { now: NOW, selection };
    const step = accountRouteStep(pool, session);
    expect(step(routeOn(second.instanceId), fable.routes)?.source.instanceId).toBe(
      first.instanceId,
    );
    const standings = accountStandings(pool, selection, NOW);
    expect([...standings.byInstance.keys()]).toEqual([first.instanceId, second.instanceId]);
    expect(standings.newChatNote).toBeNull();
  });

  it("keeps a running chat on its own account", () => {
    const step = accountRouteStep(providers, { now: NOW, instanceId: "claudeAgent" });
    expect(defaultModelRoute(fable, { account: step })?.source.instanceId).toBe("claudeAgent");
    const onSecond = accountRouteStep(providers, { now: NOW, instanceId: "claudeAgent_work" });
    expect(defaultModelRoute(fable, { account: onSecond })?.source.instanceId).toBe(
      "claudeAgent_work",
    );
    // A chat on another harness has no say between the accounts: its move to this provider
    // is a new session there, on the account with the most to spare.
    const elsewhere = accountRouteStep(providers, { now: NOW, instanceId: "opencode" });
    expect(defaultModelRoute(fable, { account: elsewhere })?.source.instanceId).toBe(
      "claudeAgent_work",
    );
  });

  it("moves nothing by the balance where accounts are picked by hand", () => {
    const off = accountRouteStep(providers, { now: NOW, balance: false });
    expect(defaultModelRoute(fable, { account: off })?.source.instanceId).toBe("claudeAgent");
    // An account picked by hand still holds.
    const pinned = accountRouteStep(providers, {
      now: NOW,
      balance: false,
      instanceId: "claudeAgent_work",
    });
    expect(defaultModelRoute(fable, { account: pinned })?.source.instanceId).toBe(
      "claudeAgent_work",
    );
  });

  it("chooses by the balance when the kept account's route cannot run", () => {
    const route = defaultModelRoute(fable, {
      isAvailable: (candidate) => candidate.source.instanceId !== "claudeAgent",
      account: accountRouteStep(providers, { now: NOW, instanceId: "claudeAgent" }),
    });
    expect(route?.source.instanceId).toBe("claudeAgent_work");
  });

  it("only moves to an account whose route can run", () => {
    const route = defaultModelRoute(fable, {
      isAvailable: (candidate) => candidate.source.instanceId !== "claudeAgent_work",
      account: accountRouteStep(providers, { now: NOW }),
    });
    expect(route?.source.instanceId).toBe("claudeAgent");
  });
});

describe("sameAccountPool", () => {
  const same = sameAccountPool(providers);
  const ref = (instanceId: string) => ({ instanceId, slug: model });

  it("knows the user's accounts of one provider from other harnesses", () => {
    expect(same(ref("claudeAgent"), ref("claudeAgent_work"))).toBe(true);
    expect(same(ref("claudeAgent"), ref("opencode"))).toBe(false);
    expect(same(ref("claudeAgent"), ref("claudeAgent"))).toBe(false);
  });

  it("does not remember an account picked over the other", () => {
    const memory = { [fable.key]: ref("opencode") };
    expect(
      rememberChosenModelRoute(memory, fable, ref("claudeAgent_work"), undefined, same),
    ).toEqual({});
    // Another harness picked over the default is still remembered.
    expect(
      rememberChosenModelRoute({}, fable, ref("opencode"), undefined, same)[fable.key],
    ).toMatchObject(ref("opencode"));
    expect(routeOn("opencode").source.instanceId).toBe("opencode");
  });
});

describe("accountStandings", () => {
  it("gives each account's room and the one a new chat would take", () => {
    const standings = accountStandings(
      providers,
      { instanceId: "claudeAgent", model },
      NOW,
      (instanceId) =>
        providers.find((provider) => provider.instanceId === instanceId)!.displayName!,
    );
    expect(standings.pickedInstanceId).toBe("claudeAgent_work");
    expect(standings.newChatNote).toBe(
      "New chats start on Max 2: it has the most left to use before its reset.",
    );
    expect(accountRoomLabel(standings.byInstance.get("claudeAgent"))).toBe("10% left");
    expect(accountRoomLabel(standings.byInstance.get("claudeAgent_work"))).toBe("90% left");
    expect(accountRoomLabel(standings.byInstance.get("opencode"))).toBeNull();
  });

  it("is empty for a model on a single account", () => {
    const standings = accountStandings(providers, { instanceId: "opencode", model }, NOW);
    expect(standings.pickedInstanceId).toBeNull();
    expect(standings.byInstance.size).toBe(0);
    expect(standings.newChatNote).toBeNull();
  });
});

it("ranks two account pools independently when one model runs on both harnesses", () => {
  const gateway2 = { ...gateway, instanceId: ProviderInstanceId.make("opencode_work") };
  const busy = { ...gateway, usageLimits: first.usageLimits! };
  const pool = [first, busy, second, gateway2];
  const routes = pool.map((provider) => {
    const source = { ...sources[0]!, instanceId: provider.instanceId, driver: provider.driver };
    return {
      key: provider.instanceId,
      source,
      sources: [source],
      label: provider.displayName!,
    };
  });
  const ranked = rankAccountRoutes(
    routes,
    pool,
    { instanceId: first.instanceId, model },
    NOW,
    () => true,
  );
  expect(ranked.routes.map((route) => route.key)).toEqual([
    second.instanceId,
    gateway2.instanceId,
    first.instanceId,
    busy.instanceId,
  ]);
  expect(ranked.byRoute.size).toBe(4);
  expect(ranked.newChatNote).toContain("Max 2");
});

describe("accountsByRoom", () => {
  const rows = ["gateway", "claudeAgent", "claudeAgent_work"];
  const idOf = (row: string) => row;

  it("lists the account with the most room first and leaves other routes in place", () => {
    const { byInstance } = accountStandings(
      providers,
      { instanceId: first.instanceId, model },
      NOW,
    );
    expect(accountsByRoom(rows, idOf, byInstance)).toEqual([
      "gateway",
      "claudeAgent_work",
      "claudeAgent",
    ]);
  });

  it("keeps the same order whichever account the chat is on", () => {
    // About the same left on both: the pick keeps the account asked for, the list does not move.
    const close = [account("claudeAgent", "Max 1", 12), account("claudeAgent_work", "Max 2", 10)];
    const from = (instanceId: string) =>
      accountsByRoom(
        ["claudeAgent", "claudeAgent_work"],
        idOf,
        accountStandings(close, { instanceId, model }, NOW).byInstance,
      );
    expect(
      accountStandings(close, { instanceId: "claudeAgent", model }, NOW).pickedInstanceId,
    ).toBe("claudeAgent");
    expect(from("claudeAgent")).toEqual(["claudeAgent_work", "claudeAgent"]);
    expect(from("claudeAgent_work")).toEqual(from("claudeAgent"));
  });

  it("leaves a list without two accounts alone", () => {
    expect(accountsByRoom(rows, idOf, new Map())).toBe(rows);
    expect(accountsByRoom(rows, idOf, null)).toBe(rows);
  });
});

describe("accountPinAfterPick", () => {
  const after = (
    pinned: boolean,
    previousInstanceId: string | null,
    nextInstanceId: string,
    accountPick = false,
  ) => accountPinAfterPick({ pinned, previousInstanceId, nextInstanceId, accountPick });

  it("pins an account picked by name, also the one balancing would choose", () => {
    expect(after(false, "claudeAgent_work", "claudeAgent", true)).toBe(true);
    expect(after(false, "claudeAgent_work", "claudeAgent_work", true)).toBe(true);
    expect(after(false, null, "claudeAgent", true)).toBe(true);
  });

  it("never pins on a model picked alone", () => {
    expect(after(false, "claudeAgent", "claudeAgent")).toBe(false);
    expect(after(false, "claudeAgent", "claudeAgent_work")).toBe(false);
  });

  it("holds while later models stay on the pinned account, and ends when one leaves it", () => {
    expect(after(true, "claudeAgent", "claudeAgent")).toBe(true);
    expect(after(true, "claudeAgent", "opencode")).toBe(false);
    // The pinned account keeps the next model: a pin the balance agrees with is still a pin.
    const step = accountRouteStep(providers, { now: NOW, instanceId: "claudeAgent" });
    expect(defaultModelRoute(fable, { account: step })?.source.instanceId).toBe("claudeAgent");
  });
});

describe("accountRoomLabel", () => {
  const standings = accountStandings(providers, { instanceId: "claudeAgent", model }, NOW);

  it("names the reset beside the room when given the time", () => {
    // The fixture resets two days on, at midnight Pacific starting a Thursday.
    expect(accountRoomLabel(standings.byInstance.get("claudeAgent"), NOW)).toBe(
      "10% left · resets Thu",
    );
    expect(accountRoomLabel(standings.byInstance.get("claudeAgent"))).toBe("10% left");
  });

  it("names trouble with the account instead of a limit", () => {
    const out = {
      instanceId: "claudeAgent",
      state: "out",
      spare: 0,
      limit: { label: "Weekly", remainingPercent: 90, resetsAt: "2026-11-19T08:00:00.000Z" },
      blockedBy: null,
      sessionRemainingPercent: null,
      pace: null,
    } as const;
    expect(accountRoomLabel({ ...out, refusal: "sign-in" }, NOW)).toBe("Signed out");
    expect(accountRoomLabel({ ...out, refusal: "billing" }, NOW)).toBe("Billing problem");
    expect(accountRoomLabel({ ...out, refusal: "plan" }, NOW)).toBe("Plan turned down");
    expect(accountRoomLabel({ ...out, refusal: "limit" }, NOW)).toBe("At limit · resets Thu");
  });

  it("gives the hour within the day and the date past the week, on the viewer's clock", () => {
    expect(accountResetLabel("2026-11-17T12:00:00.000Z", NOW)).toBe("4 AM");
    expect(accountResetLabel("2026-11-17T23:51:00.000Z", NOW)).toBe("3:51 PM");
    expect(accountResetLabel("2026-11-20T23:51:00.000Z", NOW)).toBe("Fri");
    expect(accountResetLabel("2026-12-10T12:00:00.000Z", NOW)).toBe("Dec 10");
    expect(accountResetLabel("2026-11-17T07:00:00.000Z", NOW)).toBeNull();
    expect(accountResetLabel(undefined, NOW)).toBeNull();
  });
});

describe("accountStandings with accounts a chat cannot use", () => {
  it("leaves them out of the rows and the note", () => {
    const standings = accountStandings(
      providers,
      { instanceId: "claudeAgent", model },
      NOW,
      undefined,
      (provider) => provider.instanceId !== "claudeAgent_work",
    );
    expect(standings.byInstance.size).toBe(0);
    expect(standings.newChatNote).toBeNull();
  });
});

describe("routeStanding", () => {
  it("reads a plan outside the pool by the limit that counts the model", () => {
    const google: ServerProvider = {
      ...account("antigravity", "Google Ultra", 0),
      driver: ProviderDriverKind.make("antigravity"),
      continuation: { groupKey: "antigravity:instance:antigravity" },
      models: [
        { slug: "claude-opus-5-5", name: "Claude Opus 5.5", isCustom: false, capabilities: null },
        { slug: "gemini-4-neon", name: "Gemini 4 Neon", isCustom: false, capabilities: null },
      ],
      usageLimits: {
        checkedAt: "2026-11-17T08:00:00.000Z",
        windows: [
          {
            id: "3p-weekly",
            kind: "weekly",
            label: "Claude & GPT (shared) · Weekly",
            usedPercent: 25,
            modelIds: ["claude-opus-5-5"],
          },
          {
            id: "gemini-weekly",
            kind: "weekly",
            label: "Gemini · Weekly",
            usedPercent: 80,
            modelIds: ["gemini-4-neon"],
          },
        ],
      },
    };
    const providers = [first, google];
    expect(accountRoomLabel(routeStanding(providers, "antigravity", "claude-opus-5-5", NOW))).toBe(
      "75% left",
    );
    expect(accountRoomLabel(routeStanding(providers, "antigravity", "gemini-4-neon", NOW))).toBe(
      "20% left",
    );
    expect(routeStanding(providers, "missing", "claude-opus-5-5", NOW)).toBeUndefined();
  });
});
