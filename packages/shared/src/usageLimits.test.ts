import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { newSessionAccountKeys } from "./accountBalance.ts";
import { poolForecast } from "./usageLimitForecast.ts";

import {
  type LimitAccount,
  isUsageLimitsCommand,
  collectProviderUsageLimits,
  sameUsageLimitCommandCoverage,
  withUsageLimitsCommands,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  displayLimitWindows,
  displayProviderUsageWindows,
  elapsedShare,
  formatAsOf,
  formatResetsIn,
  limitsClock,
  limitsNotice,
  olderReadingAt,
  paceOf,
  providersWithLimits,
  recentUseBySource,
  remainingPercent,
  remainingPercentLabel,
  usedPercentLabel,
  isUsageWindowLimited,
  usesChatGptSharing,
} from "./usageLimits.ts";

const now = Date.parse("2026-09-03T12:00:00.000Z");

const window = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-03T11:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

describe("pace", () => {
  it.each([
    ["2026-09-03T12:01:00.000Z", "resets in 1m"],
    ["2026-09-03T12:00:59.999Z", "Resets momentarily"],
    ["2026-09-03T12:00:00.001Z", "Resets momentarily"],
    ["2026-09-03T12:00:00.000Z", "reset time passed"],
    ["2026-09-03T11:59:59.999Z", "reset time passed"],
  ])("formats the reset boundary at %s", (resetsAt, label) => {
    expect(formatResetsIn({ ...window, resetsAt }, now)).toBe(label);
  });

  it("ignores invalid reset timestamps", () => {
    expect(formatResetsIn({ ...window, resetsAt: "invalid" }, now)).toBeNull();
  });

  it("places the clock three fifths through a five-hour window with two hours left", () => {
    expect(elapsedShare(window, now)).toBeCloseTo(0.6);
    expect(paceOf(window, now)).toBe("under");
    expect(paceOf({ ...window, usedPercent: 62 }, now)).toBe("on");
    expect(paceOf({ ...window, usedPercent: 80 }, now)).toBe("ahead");
  });

  it("has no pace without a reset or a duration", () => {
    expect(paceOf({ ...window, resetsAt: undefined }, now)).toBeNull();
    expect(paceOf({ ...window, windowDurationMins: undefined }, now)).toBeNull();
    expect(formatResetsIn({ ...window, resetsAt: undefined }, now)).toBeNull();
  });

  it("phrases the reset as a countdown", () => {
    expect(formatResetsIn(window, now)).toBe("resets in 2h 0m");
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-06T15:30:00.000Z" }, now)).toBe(
      "resets in 3d 3h",
    );
    expect(formatResetsIn({ ...window, resetsAt: "2026-09-03T11:00:00.000Z" }, now)).toBe(
      "reset time passed",
    );
  });
});

describe("limitsNotice", () => {
  it("explains empty bars and passes provider messages through", () => {
    const checkedAt = "2026-09-03T11:00:00.000Z";
    expect(limitsNotice({ checkedAt, windows: [window] })).toBeNull();
    expect(limitsNotice({ checkedAt, windows: [] })).toBe("No limits reported.");
    expect(limitsNotice({ checkedAt, windows: [], unavailable: { reason: "unsupported" } })).toBe(
      "This account has no subscription limits.",
    );
    expect(
      limitsNotice({
        checkedAt,
        windows: [],
        unavailable: { reason: "probeFailed", message: "Codex timed out." },
      }),
    ).toBe("Codex timed out.");
  });
});

describe("providersWithLimits", () => {
  it("keeps only usable providers whose driver reports limits at all", () => {
    const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
    const codex = provider({ usageLimits: limits });
    expect(
      providersWithLimits([
        codex,
        provider({
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
        }),
        provider({
          instanceId: ProviderInstanceId.make("off"),
          enabled: false,
          usageLimits: limits,
        }),
        provider({
          instanceId: ProviderInstanceId.make("gone"),
          installed: false,
          usageLimits: limits,
        }),
        provider({
          instanceId: ProviderInstanceId.make("shadow"),
          availability: "unavailable",
          usageLimits: limits,
        }),
      ]),
    ).toEqual([codex]);
  });
});

describe("pools", () => {
  it("merges a local Antigravity login with its hub account by Google account fingerprint", () => {
    const antigravity = ProviderDriverKind.make("antigravity");
    const local = provider({
      driver: antigravity,
      instanceId: ProviderInstanceId.make("antigravity"),
      auth: { status: "authenticated" },
      usageLimits: {
        checkedAt,
        credentialFingerprint: "google-key",
        windows: [{ ...window, id: "gemini-weekly", usedPercent: 20 }],
      },
    });
    const hubAccount = {
      id: "antigravity-g@example.com.json",
      driver: antigravity,
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        credentialFingerprint: "google-key",
        windows: [{ ...window, id: "gemini-weekly", usedPercent: 30 }],
      },
    };
    const accounts = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("env-a"),
          {
            ...laptop,
            serverConfig: {
              providers: [local],
              usageLimitSources: [{ ...source, accounts: [hubAccount] }],
            },
          },
        ],
      ]),
    );
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(30);
  });

  const checkedAt = "2026-09-03T11:00:00.000Z";
  const weekly = {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
    resetsAt: "2026-09-06T12:00:00.000Z",
  } as const;
  const claude = ProviderDriverKind.make("claudeAgent");
  const source = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "hub",
    checkedAt,
  };
  const laptop = { entry: { target: { label: "Laptop" } } };

  it("merges one account reported natively on two environments and by a hub into one entry", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "Same@example.com" },
      usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 40 }] },
    });
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [native] } }],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: {
            providers: [
              {
                ...native,
                usageLimits: {
                  checkedAt: "2026-09-03T11:30:00.000Z",
                  windows: [{ ...window, usedPercent: 55 }],
                },
              },
            ],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "claude-same@example.com.json",
                    driver: claude,
                    email: "same@example.com",
                    plan: "Claude Subscription",
                    usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 10 }] },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      key: "env-a:claude",
      sourceLabel: null,
      // Desktop's read is fresher, so its credits and its redeem are the ones on show.
      redeem: { environmentId: "env-b", input: { instanceId: "claude" } },
      environments: [
        { environmentId: "env-a", label: "Laptop" },
        { environmentId: "env-b", label: "Desktop" },
      ],
    });
    // The fresher native snapshot wins; the hub row is pre-filtered by email.
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(55);
  });

  it("merges OpenCode Go limits from machines with the same API key", () => {
    const go = provider({
      driver: ProviderDriverKind.make("opencode"),
      instanceId: ProviderInstanceId.make("opencode"),
      auth: { status: "authenticated" },
      usageLimits: {
        checkedAt,
        credentialFingerprint: "shared-go-key",
        windows: [{ ...window, id: "go_rolling", usedPercent: 3 }],
      },
    });
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [go] } }],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: {
            providers: [
              {
                ...go,
                usageLimits: {
                  ...go.usageLimits!,
                  checkedAt: "2026-09-03T11:30:00.000Z",
                  windows: [{ ...window, id: "go_rolling", usedPercent: 4 }],
                },
              },
            ],
          },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.environments).toEqual([
      { environmentId: "env-a", label: "Laptop" },
      { environmentId: "env-b", label: "Desktop" },
    ]);
    expect(collectLimitPools(accounts, now)[0]?.windows[0]?.members).toHaveLength(1);
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(4);

    const differentKey = {
      ...go,
      usageLimits: { ...go.usageLimits!, credentialFingerprint: "other-go-key" },
    };
    input.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: { providers: [differentKey] },
    });
    expect(collectLimitAccounts(input)).toHaveLength(2);

    input.set(EnvironmentId.make("env-a"), {
      ...laptop,
      serverConfig: {
        providers: [{ ...go, auth: { status: "authenticated", email: "same@example.com" } }],
      },
    });
    input.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: {
        providers: [
          { ...differentKey, auth: { status: "authenticated", email: "SAME@example.com" } },
        ],
      },
    });
    expect(collectLimitAccounts(input)).toHaveLength(1);
  });

  it("takes windows from a fresher hub read but credits and redeem from the native instance", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt,
        windows: [{ ...window, usedPercent: 40 }],
        resetCredits: { availableCount: 2 },
      },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [native],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "claude-same@example.com.json",
                    driver: claude,
                    email: "same@example.com",
                    usageLimits: {
                      checkedAt: "2026-09-03T11:30:00.000Z",
                      windows: [{ ...window, usedPercent: 55 }],
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.windows[0]?.usedPercent).toBe(55);
    expect(account?.limits.resetCredits?.availableCount).toBe(2);
    expect(account?.redeem).toEqual({ environmentId: "env-a", input: { instanceId: "claude" } });
    expect(account?.environments).toEqual([{ environmentId: "env-a", label: "Laptop" }]);
  });

  it("redeems through the hub when it holds a credit, even with a fresher native read", () => {
    const native = provider({
      driver: claude,
      instanceId: ProviderInstanceId.make("claude"),
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [{ ...window, usedPercent: 40 }],
        resetCredits: { availableCount: 3, nextCreditId: "native-credit" },
      },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [native],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "claude-same@example.com.json",
                    driver: claude,
                    email: "same@example.com",
                    usageLimits: {
                      checkedAt,
                      windows: [{ ...window, usedPercent: 55 }],
                      resetCredits: { availableCount: 2, nextCreditId: "hub-credit" },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    // Only the hub path clears the routing cooldown it holds for this account.
    expect(account?.redeem).toEqual({
      environmentId: "env-a",
      input: { sourceId: "hub", accountId: "claude-same@example.com.json", creditId: "hub-credit" },
    });
    // The fresher native balance is still the one shown.
    expect(account?.limits.resetCredits?.availableCount).toBe(3);
  });

  it("redeems on the environment whose snapshot supplied the credits on show", () => {
    const stale = provider({
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: {
        checkedAt,
        windows: [window],
        resetCredits: { availableCount: 0 },
      },
    });
    const fresh = {
      ...stale,
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 2 },
      },
    };
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [stale] } }],
      [
        EnvironmentId.make("env-b"),
        { entry: { target: { label: "Desktop" } }, serverConfig: { providers: [fresh] } },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.resetCredits?.availableCount).toBe(2);
    expect(account?.redeem).toEqual({ environmentId: "env-b", input: { instanceId: "codex" } });
  });

  it("uses the freshest hub credit and its environment even when the account is also native", () => {
    const native = provider({
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: { checkedAt, windows: [window], resetCredits: { availableCount: 1 } },
    });
    const hubAccount = {
      id: "codex-same.json",
      driver: native.driver,
      email: "same@example.com",
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 2, nextCreditId: "credit-2" },
      },
    };
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { providers: [native] } }],
      [
        EnvironmentId.make("env-b"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [{ ...source, accounts: [hubAccount] }],
          },
        },
      ],
    ]);
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.resetCredits?.availableCount).toBe(2);
    expect(account?.redeem).toEqual({
      environmentId: "env-b",
      input: { sourceId: "hub", accountId: "codex-same.json", creditId: "credit-2" },
    });
    hubAccount.usageLimits.resetCredits.availableCount = 0;
    expect(collectLimitAccounts(input)[0]?.limits.resetCredits?.availableCount).toBe(0);
  });

  it("keeps distinct hub accounts redeemable through their own source", () => {
    const hubAccounts = ["first", "second"].map((id) => ({
      id,
      driver: ProviderDriverKind.make("codex"),
      email: `${id}@example.com`,
      usageLimits: {
        checkedAt,
        windows: [window],
        resetCredits: { availableCount: 2, nextCreditId: `${id}-credit` },
      },
    }));
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [{ ...source, accounts: hubAccounts }],
          },
        },
      ],
    ]);
    expect(collectLimitAccounts(input).map((account) => account.redeem)).toEqual(
      hubAccounts.map((account) => ({
        environmentId: "env-a",
        input: { sourceId: "hub", accountId: account.id, creditId: `${account.id}-credit` },
      })),
    );
  });

  it("does not give old credits the timestamp of a newer window-only read", () => {
    const snapshots = [
      { checkedAt, windows: [window], resetCredits: { availableCount: 2 } },
      { checkedAt: "2026-09-03T12:00:00.000Z", windows: [window] },
      {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 1 },
      },
    ];
    const input = new Map(
      snapshots.map((usageLimits, i) => [
        EnvironmentId.make(`env-${i}`),
        {
          ...laptop,
          serverConfig: {
            providers: [
              provider({
                auth: { status: "authenticated", email: "same@example.com" },
                usageLimits,
              }),
            ],
          },
        },
      ]),
    );
    const [account] = collectLimitAccounts(input);
    expect(account?.limits.checkedAt).toBe("2026-09-03T12:00:00.000Z");
    expect(account?.limits.resetCredits?.availableCount).toBe(1);
    expect(account?.redeem?.environmentId).toBe("env-2");
  });

  it("keeps one email in two workspaces apart while merging each workspace's duplicates", () => {
    const login = (instanceId: string, workspaceId: string, usedPercent: number) =>
      provider({
        instanceId: ProviderInstanceId.make(instanceId),
        auth: { status: "authenticated", email: "same@example.com", workspaceId },
        usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent }] },
      });
    const hubAccount = (id: string, workspaceId?: string) => ({
      id,
      driver: ProviderDriverKind.make("codex"),
      email: "same@example.com",
      ...(workspaceId ? { workspaceId } : {}),
      usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent: 50 }] },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [login("business", "ws-business", 8), login("personal", "ws-plus", 26)],
            usageLimitSources: [
              // A hub that names the workspace joins it; one that does not
              // cannot say which of the two it read, so it keeps its own row.
              { ...source, accounts: [hubAccount("plus.json", "ws-plus"), hubAccount("x.json")] },
            ],
          },
        },
      ],
      [
        EnvironmentId.make("env-b"),
        {
          entry: { target: { label: "Desktop" } },
          serverConfig: { providers: [login("personal", "ws-plus", 26)] },
        },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts.map((account) => account.key)).toEqual([
      "env-a:business",
      "env-a:personal",
      "hub:x.json",
    ]);
    expect(accounts[0]?.limits.windows[0]?.usedPercent).toBe(8);
    // One hub file name in two workspaces stays two accounts, even without an
    // email to tell them apart.
    const withoutEmail = (id: string, workspaceId: string) => {
      const { email: _email, ...account } = hubAccount(id, workspaceId);
      return account;
    };
    const sameFile = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            usageLimitSources: [{ ...source, accounts: [withoutEmail("a.json", "ws-1")] }],
          },
        },
      ],
      [
        EnvironmentId.make("env-b"),
        {
          ...laptop,
          serverConfig: {
            usageLimitSources: [{ ...source, accounts: [withoutEmail("a.json", "ws-2")] }],
          },
        },
      ],
    ]);
    expect(collectLimitAccounts(sameFile).map((account) => account.key)).toEqual([
      "hub:a.json:ws-1",
      "hub:a.json:ws-2",
    ]);
    expect(accounts[1]?.environments.map((environment) => environment.label)).toEqual([
      "Laptop",
      "Desktop",
    ]);
  });

  it("joins a report without a workspace to the only workspace signed in with its email", () => {
    const native = provider({
      driver: claude,
      auth: { status: "authenticated", email: "same@example.com", workspaceId: "org-a" },
      usageLimits: { checkedAt, windows: [window] },
    });
    const hubAccount = {
      id: "claude.json",
      driver: claude,
      email: "same@example.com",
      usageLimits: { checkedAt, windows: [window] },
    };
    const withOther = (other: ServerProvider) =>
      new Map([
        [
          EnvironmentId.make("env-a"),
          {
            ...laptop,
            serverConfig: {
              providers: [native, other],
              usageLimitSources: [{ ...source, accounts: [hubAccount] }],
            },
          },
        ],
      ]);
    const unrelated = provider({ instanceId: ProviderInstanceId.make("codex-2") });
    expect(collectLimitAccounts(withOther(unrelated)).map((account) => account.key)).toEqual([
      "env-a:codex",
    ]);
    // A second org whose limits could not be read still makes the hub ambiguous.
    const unreadable = provider({
      ...native,
      instanceId: ProviderInstanceId.make("team"),
      auth: { ...native.auth, workspaceId: "org-b" },
      usageLimits: { checkedAt, windows: [], unavailable: { reason: "probeFailed" } },
    });
    expect(collectLimitAccounts(withOther(unreadable)).map((account) => account.key)).toEqual([
      "env-a:codex",
      "hub:claude.json",
    ]);
  });

  it("names an environment once however many of its instances share the account", () => {
    const shared = provider({
      auth: { status: "authenticated", email: "same@example.com" },
      usageLimits: { checkedAt, windows: [window] },
    });
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [shared, { ...shared, instanceId: ProviderInstanceId.make("work") }],
          },
        },
      ],
    ]);
    expect(collectLimitAccounts(input)[0]?.environments).toEqual([
      { environmentId: "env-a", label: "Laptop" },
    ]);
  });

  it("keys a hub account without an email by hub, so two environments on one hub share it", () => {
    const seat = {
      id: "claude-team-seat.json",
      driver: claude,
      usageLimits: { checkedAt, windows: [window] },
    };
    const hub = { ...source, accounts: [seat] };
    const input = new Map([
      [EnvironmentId.make("env-a"), { ...laptop, serverConfig: { usageLimitSources: [hub] } }],
      [
        EnvironmentId.make("env-b"),
        { entry: { target: { label: "Desktop" } }, serverConfig: { usageLimitSources: [hub] } },
      ],
    ]);
    const accounts = collectLimitAccounts(input);
    expect(accounts.map((account) => account.key)).toEqual(["hub:claude-team-seat.json"]);
    expect(accounts[0]?.displayName).toBe("claude-team-seat");
  });

  it("pools Codex windows by kind, whichever slot reported them", () => {
    const codexAccount = (id: string, slots: readonly string[]) => ({
      id,
      driver: ProviderDriverKind.make("codex"),
      usageLimits: {
        checkedAt,
        windows: slots.map((slot) => ({ ...weekly, id: slot, usedPercent: 50 })),
      },
    });
    const pooled = (accounts: ReturnType<typeof codexAccount>[]) =>
      collectLimitPools(
        collectLimitAccounts(
          new Map([
            [
              EnvironmentId.make("env-a"),
              { ...laptop, serverConfig: { usageLimitSources: [{ ...source, accounts }] } },
            ],
          ]),
        ),
        now,
      )[0]?.windows ?? [];
    // A weekly-only plan reports weekly as `primary`. The pool keeps one id
    // whichever account sorts first.
    for (const order of [
      [codexAccount("business", ["primary"]), codexAccount("plus", ["secondary"])],
      [codexAccount("plus", ["secondary"]), codexAccount("business", ["primary"])],
    ]) {
      const windows = pooled(order);
      expect(windows.map((window) => window.id)).toEqual(["weekly"]);
      expect(windows[0]?.members).toHaveLength(2);
    }
    // A second window of the same kind on one account stays apart, with its own id.
    expect(
      pooled([codexAccount("a", ["secondary"]), codexAccount("b", ["primary", "secondary"])]).map(
        (window) => window.id,
      ),
    ).toEqual(["weekly", "weekly:secondary"]);
  });

  it("pools windows by id across accounts and orders resets by when they land", () => {
    const input = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [],
            usageLimitSources: [
              {
                ...source,
                accounts: [
                  {
                    id: "a",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [
                        { ...window, usedPercent: 80, resetsAt: "2026-09-03T13:00:00.000Z" },
                        { ...weekly, usedPercent: 20 },
                      ],
                    },
                  },
                  {
                    id: "b",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [{ ...window, usedPercent: 40 }],
                    },
                  },
                  {
                    id: "c",
                    driver: ProviderDriverKind.make("codex"),
                    usageLimits: { checkedAt, windows: [{ ...weekly, usedPercent: 50 }] },
                  },
                  {
                    id: "unsupported",
                    driver: claude,
                    usageLimits: {
                      checkedAt,
                      windows: [],
                      unavailable: { reason: "unsupported" as const },
                    },
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    const pools = collectLimitPools(collectLimitAccounts(input), now);
    expect(pools.map((pool) => [pool.driver, pool.accounts.length])).toEqual([
      ["claudeAgent", 2],
      ["codex", 1],
    ]);
    const [session, week] = pools[0]!.windows;
    // A member with no reset has no clock, so it does not vote on pace.
    const untimed = collectLimitPools(
      collectLimitAccounts(input).map((account) =>
        account.key === "hub:b"
          ? {
              ...account,
              limits: {
                ...account.limits,
                windows: account.limits.windows.map((w) => ({ ...w, resetsAt: undefined })),
              },
            }
          : account,
      ),
      now,
    );
    // Only a votes: 80% used, 80% elapsed.
    expect(untimed[0]?.windows[0]?.pace).toBe("on");
    // a is 80% through its window and b 60%: the pool is 70% elapsed, 60% used.
    expect(session).toMatchObject({
      id: "five_hour",
      remainingPercent: 40,
      usedPercent: 60,
      pace: "under",
    });
    expect(
      session?.resets.map((reset) => [reset.member.account.key, reset.restoresPercent]),
    ).toEqual([
      ["hub:a", 40],
      ["hub:b", 20],
    ]);
    expect(week).toMatchObject({ id: "seven_day", remainingPercent: 80, members: [{}] });
    // Codex reports `primary` for both its five-hour and (on Go) monthly window.
    const mixed = collectLimitPools(
      [
        ...collectLimitAccounts(input),
        {
          key: "go",
          sourceKeys: [],
          driver: claude,
          displayName: "Go",
          primary: false,
          email: undefined,
          plan: undefined,
          accentColor: undefined,
          environments: [],
          sourceLabel: null,
          redeem: null,
          limits: {
            checkedAt,
            windows: [
              {
                id: "five_hour",
                kind: "monthly",
                label: "Monthly",
                usedPercent: 82,
                windowDurationMins: 30 * 24 * 60,
                resetsAt: "2026-09-14T12:00:00.000Z",
              },
            ],
          },
        },
      ],
      now,
    );
    expect(mixed[0]?.windows.map((window) => [window.kind, window.members.length])).toEqual([
      ["session", 2],
      ["weekly", 1],
      ["monthly", 1],
    ]);
    // Session resets determine the account order for every row.
    expect(session?.members.map((member) => member.account.key)).toEqual(["hub:a", "hub:b"]);
    expect(pools[0]?.accounts.map((account) => account.key)).toEqual(["hub:a", "hub:b"]);
  });
});

describe("pooled account columns", () => {
  const weekly = {
    ...window,
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    windowDurationMins: 7 * 24 * 60,
  } as const;
  const account = (key: string, windows: LimitAccount["limits"]["windows"]): LimitAccount => ({
    key,
    sourceKeys: [],
    driver: ProviderDriverKind.make("claudeAgent"),
    displayName: key,
    primary: false,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: "Hub",
    redeem: null,
    limits: { checkedAt: "2026-09-03T11:00:00.000Z", windows },
  });
  const keys = (pool: ReturnType<typeof collectLimitPools>[number]) =>
    pool.windows.map((row) =>
      row.columns.map((member) => (member.window ? member.account.key : null)),
    );

  it("reads limits against the freshest reading when it is newer than the view's clock", () => {
    const fresh = {
      ...account("fresh", []),
      limits: { checkedAt: "2026-09-03T13:30:00.000Z", windows: [] },
    };
    // The view's clock is 12:00; a reading taken at 13:30 moves it forward.
    expect(limitsClock([account("a", []), fresh], now)).toBe(
      Date.parse("2026-09-03T13:30:00.000Z"),
    );
    // Older readings never move it back.
    expect(limitsClock([account("a", [])], now)).toBe(now);
    expect(limitsClock([], now)).toBe(now);
  });

  it("gives an added subscription its own section after the provider's own account", () => {
    // Real shapes: the default instance is named after its provider, the added
    // one carries the user's label, and each is signed in to its own account.
    const login = (instanceId: string, displayName: string, email: string, usedPercent: number) =>
      provider({
        driver: ProviderDriverKind.make("claudeAgent"),
        instanceId: ProviderInstanceId.make(instanceId),
        displayName,
        auth: { status: "authenticated", email },
        usageLimits: {
          checkedAt: "2026-09-03T11:00:00.000Z",
          // The added subscription resets sooner, and still comes second.
          windows: [
            {
              ...weekly,
              usedPercent,
              resetsAt:
                instanceId === "claudeAgent"
                  ? "2026-09-08T12:00:00.000Z"
                  : "2026-09-04T12:00:00.000Z",
            },
          ],
        },
      });
    const pools = collectLimitPools(
      collectLimitAccounts(
        new Map([
          [
            EnvironmentId.make("mac"),
            {
              entry: { target: { label: "Mac" } },
              serverConfig: {
                providers: [
                  login("claudeAgent_work", "Max-2", "second@example.com", 2),
                  login("claudeAgent", "Claude", "me@example.com", 65),
                ],
              },
            },
          ],
        ]),
      ),
      now,
    );
    // Nothing is added together: each plan keeps its own number.
    expect(
      pools.map((pool) => [
        pool.key,
        pool.label,
        pool.accounts.length,
        pool.windows[0]?.usedPercent,
      ]),
    ).toEqual([
      // Beside an added account the provider's own section goes by its own name too.
      ["claudeAgent", "Claude", 1, 65],
      ["claudeAgent:mac:claudeAgent_work", "Max-2", 1, 2],
    ]);
    // A provider whose only instance has another id (Grok Build) keeps the provider's name.
    const only = collectLimitPools(
      collectLimitAccounts(
        new Map([
          [
            EnvironmentId.make("mac"),
            {
              entry: { target: { label: "Mac" } },
              serverConfig: {
                providers: [login("claudeAgent_build", "Claude Build", "me@example.com", 10)],
              },
            },
          ],
        ]),
      ),
      now,
    );
    expect(only.map((pool) => [pool.key, pool.label])).toEqual([["claudeAgent", null]]);
  });

  it.each([
    ["claudeAgent", "claudeAgent", "claudeAgent_work"],
    ["codex", "codex", "codex_work"],
    ["grok", "grok_grok_build", "grok_work"],
  ])(
    "keeps %s accounts separate when another machine has only the second",
    (driver, firstId, secondId) => {
      const login = (id: string, usedPercent: number) =>
        provider({
          driver: ProviderDriverKind.make(driver),
          instanceId: ProviderInstanceId.make(id),
          displayName: id,
          auth: { status: "authenticated", email: `${id}@example.test` },
          usageLimits: {
            checkedAt: "2026-09-03T11:00:00.000Z",
            windows: [{ ...weekly, usedPercent }],
          },
        });
      const first = login(firstId, 90);
      const second = login(secondId, 10);
      const machine = (providers: readonly ServerProvider[]) => ({
        entry: { target: { label: "Machine" } },
        serverConfig: { providers },
      });
      const entries = [
        [EnvironmentId.make("a"), machine([first, second])],
        [EnvironmentId.make("b"), machine([second])],
      ] as const;
      for (const order of [entries, [entries[1], entries[0]]]) {
        const pools = collectLimitPools(collectLimitAccounts(new Map(order)), now);
        expect(pools).toHaveLength(2);
        expect(pools.map((pool) => pool.windows[0]?.usedPercent).sort((a, b) => a! - b!)).toEqual([
          10, 90,
        ]);
        expect(pools.every((pool) => pool.accounts.length === 1)).toBe(true);
      }
    },
  );

  it("marks the new-chat account through every merged machine and instance key", () => {
    const login = (id: string, email: string, usedPercent: number) =>
      provider({
        driver: ProviderDriverKind.make("claudeAgent"),
        instanceId: ProviderInstanceId.make(id),
        continuation: { groupKey: "claude:shared" },
        auth: { status: "authenticated", email },
        models: [
          { slug: "opus", name: "Opus", isDefault: true, isCustom: false, capabilities: null },
        ],
        usageLimits: {
          checkedAt: "2026-09-03T11:00:00.000Z",
          windows: [{ ...weekly, usedPercent }],
        },
      });
    const first = login("claudeAgent", "first@example.test", 90);
    const second = login("claudeAgent_work", "second@example.test", 10);
    const alias = { ...second, instanceId: ProviderInstanceId.make("claudeAgent") };
    const machine = (providers: readonly ServerProvider[], balanceAccounts: boolean) => ({
      entry: { target: { label: "Machine" } },
      serverConfig: { providers, settings: { balanceAccounts } },
    });
    const entries = [
      [EnvironmentId.make("b"), machine([alias], false)],
      [EnvironmentId.make("a"), machine([first, second], true)],
    ] as const;
    for (const order of [entries, [entries[1], entries[0]]]) {
      const presentations = new Map(order);
      const accounts = collectLimitAccounts(presentations);
      const starts = newSessionAccountKeys(presentations, now);
      expect(starts.has("a:claudeAgent_work")).toBe(true);
      const merged = accounts.find((entry) => entry.email === "second@example.test")!;
      expect(merged.sourceKeys).toEqual(
        expect.arrayContaining(["b:claudeAgent", "a:claudeAgent_work"]),
      );
      expect(accounts.filter((entry) => entry.sourceKeys.some((key) => starts.has(key)))).toEqual([
        merged,
      ]);
    }
  });

  it("keeps Grok Build first and Grok-2 separate when neither has the default id", () => {
    const grok = ProviderDriverKind.make("grok");
    const login = (id: string, displayName: string, usedPercent: number) =>
      provider({
        driver: grok,
        instanceId: ProviderInstanceId.make(id),
        displayName,
        auth: { status: "authenticated", email: `${id}@example.com` },
        usageLimits: {
          checkedAt: "2026-09-03T11:00:00.000Z",
          windows: [{ ...weekly, usedPercent }],
        },
      });
    const accounts = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("mac"),
          {
            entry: { target: { label: "Mac" } },
            serverConfig: {
              providers: [
                login("grok_grok_build", "Grok Build", 65),
                login("grok_second", "Grok-2", 2),
              ],
            },
          },
        ],
      ]),
    );
    expect(accounts.map((account) => account.primary)).toEqual([true, false]);
    const fallbackPools = collectLimitPools(
      accounts.map((account) => ({ ...account, primary: false })),
      now,
    );
    expect(fallbackPools.map((pool) => [pool.key, pool.label, pool.accounts.length])).toEqual([
      ["grok", "Grok Build", 1],
      ["grok:mac:grok_second", "Grok-2", 1],
    ]);
    expect(
      collectLimitPools(accounts, now).map((pool) => [
        pool.key,
        pool.label,
        pool.accounts.length,
        pool.windows[0]?.usedPercent,
      ]),
    ).toEqual([
      ["grok", "Grok Build", 1, 65],
      ["grok:mac:grok_second", "Grok-2", 1, 2],
    ]);
  });

  it("still adds up the accounts a hub rotates through, the provider's own first", () => {
    const own = {
      ...account("own", [{ ...weekly, usedPercent: 64, resetsAt: "2026-09-08T12:00:00.000Z" }]),
      primary: true,
      environments: [{ environmentId: EnvironmentId.make("mac"), label: "Mac" }],
    };
    const hub = account("hub", [
      { ...weekly, usedPercent: 1, resetsAt: "2026-09-04T12:00:00.000Z" },
    ]);
    const pools = collectLimitPools([hub, own], now);
    expect(pools).toHaveLength(1);
    expect(keys(pools[0]!)).toEqual([["own", "hub"]]);
  });

  it("keeps session columns across rows with opposite reset and usage orders", () => {
    const accounts = [
      account("a", [
        { ...weekly, usedPercent: 80, resetsAt: "2026-09-05T12:00:00.000Z" },
        { ...window, usedPercent: 10, resetsAt: "2026-09-03T15:00:00.000Z" },
      ]),
      account("b", [
        { ...weekly, usedPercent: 20, resetsAt: "2026-09-06T12:00:00.000Z" },
        { ...window, usedPercent: 90, resetsAt: "2026-09-03T13:00:00.000Z" },
      ]),
    ];
    const [pool] = collectLimitPools(accounts, now);
    expect(pool!.accounts.map((account) => account.key)).toEqual(["b", "a"]);
    expect(keys(pool!)).toEqual([
      ["b", "a"],
      ["b", "a"],
    ]);
    expect(pool!.windows[1]!.resets.map((reset) => reset.member.account.key)).toEqual(["a", "b"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(50);
    expect(keys(collectLimitPools(accounts.toReversed(), now)[0]!)).toEqual(keys(pool!));
  });

  it("preserves gaps without counting missing windows toward pooled quota", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [window]),
        account("b", [
          { ...window, resetsAt: "2026-09-03T15:00:00.000Z" },
          { ...weekly, usedPercent: 80 },
        ]),
        account("c", [weekly]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([
      ["a", "b", null],
      [null, "b", "c"],
    ]);
    expect(pool!.windows[1]!.members.map((member) => member.account.key)).toEqual(["b", "c"]);
    expect(pool!.windows[1]!.remainingPercent).toBe(40);
    expect(pool!.windows[1]!.resets.map((reset) => reset.restoresPercent)).toEqual([40, 20]);
  });

  it("falls back to weekly resets when no account reports a session", () => {
    const [pool] = collectLimitPools(
      [
        account("a", [{ ...weekly, resetsAt: "2026-09-06T12:00:00.000Z" }]),
        account("b", [{ ...weekly, resetsAt: "2026-09-05T12:00:00.000Z" }]),
      ],
      now,
    );
    expect(keys(pool!)).toEqual([["b", "a"]]);
  });

  it("sorts unknown resets last and breaks ties consistently", () => {
    const accounts = [
      account("z", [{ ...window, resetsAt: undefined }]),
      account("b", [window]),
      account("a", [window]),
      account("y", [{ ...window, resetsAt: "invalid" }]),
    ];
    expect(keys(collectLimitPools(accounts, now)[0]!)).toEqual([["a", "b", "y", "z"]]);
    expect(keys(collectLimitPools(accounts.toReversed(), now)[0]!)).toEqual([["a", "b", "y", "z"]]);
  });
});

describe("Cursor limit presentation", () => {
  const cursorAccount: LimitAccount = {
    key: "cursor",
    sourceKeys: [],
    driver: ProviderDriverKind.make("cursor"),
    displayName: "Cursor",
    primary: true,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: "Cursor",
    redeem: null,
    limits: {
      checkedAt: "2026-09-03T11:00:00.000Z",
      windows: [
        { id: "apiPercentUsed", kind: "monthly", label: "Other Models", usedPercent: 49 },
        { id: "autoPercentUsed", kind: "monthly", label: "Cursor Models", usedPercent: 9 },
        { id: "totalPercentUsed", kind: "monthly", label: "Overall", usedPercent: 15 },
      ],
    },
  };

  it("hides the combined percentage and orders the two pools", () => {
    const [pool] = collectLimitPools([cursorAccount], now);
    const display = displayLimitWindows(pool!);
    expect(display.map((window) => window.id)).toEqual(["autoPercentUsed", "apiPercentUsed"]);
  });

  it("keeps the combined percentage as a card if either allowance is missing", () => {
    const [pool] = collectLimitPools(
      [
        {
          ...cursorAccount,
          limits: {
            ...cursorAccount.limits,
            windows: cursorAccount.limits.windows.filter(
              (window) => window.id !== "apiPercentUsed",
            ),
          },
        },
      ],
      now,
    );
    const display = displayLimitWindows(pool!);
    expect(display.map((window) => window.id)).toEqual(["totalPercentUsed", "autoPercentUsed"]);
  });
});

describe("collectLimitNotices", () => {
  const checkedAt = "2026-09-03T11:00:00.000Z";
  const claude = ProviderDriverKind.make("claudeAgent");
  const laptop = { entry: { target: { label: "Laptop" } } };
  const hub = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "hub",
    checkedAt,
    accounts: [],
  };

  it("names hub failures and silence, leaves plan failures to their rows, and labels environments only when several", () => {
    const failed = provider({
      instanceId: ProviderInstanceId.make("claude"),
      driver: claude,
      displayName: "Claude Max",
      usageLimits: { checkedAt, windows: [], unavailable: { reason: "probeFailed" } },
    });
    const apiKey = provider({
      instanceId: ProviderInstanceId.make("api"),
      driver: claude,
      usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
    });
    const silent = provider({ usageLimits: { checkedAt, windows: [] } });
    const one = new Map([
      [
        EnvironmentId.make("env-a"),
        {
          ...laptop,
          serverConfig: {
            providers: [failed, apiKey, silent],
            usageLimitSources: [
              hub,
              { ...hub, id: UsageLimitSourceId.make("down"), label: "down", error: "ECONNREFUSED" },
            ],
          },
        },
      ],
    ]);
    expect(collectLimitNotices(one)).toEqual(["hub: No accounts reported.", "down: ECONNREFUSED"]);
    // The plans that read nothing are rows of their own; the API key has nothing to show.
    expect(
      collectLimitAccounts(one, { withNotices: true }).map((account) => [
        account.displayName ?? account.driver,
        account.notice,
      ]),
    ).toEqual([
      ["Claude Max", "Could not read limits."],
      ["codex", "No limits reported."],
    ]);
    expect(collectLimitAccounts(one)).toEqual([]);

    one.set(EnvironmentId.make("env-b"), {
      entry: { target: { label: "Desktop" } },
      serverConfig: { providers: [], usageLimitSources: [] },
    });
    expect(collectLimitNotices(one)[0]).toBe("hub on Laptop: No accounts reported.");
  });
});

describe("plans whose probe read nothing", () => {
  const antigravity = ProviderDriverKind.make("antigravity");
  const readAt = "2026-09-03T09:23:00.000Z";
  const failure = {
    reason: "probeFailed" as const,
    message: "Antigravity's limits show again the next time it runs.",
  };
  const ultra = (usageLimits: ServerProvider["usageLimits"]) =>
    provider({
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: antigravity,
      displayName: "Google Ultra",
      auth: { status: "authenticated", label: "Google AI Ultra" },
      usageLimits,
    });
  const pro = provider({
    instanceId: ProviderInstanceId.make("antigravity_pro"),
    driver: antigravity,
    displayName: "Google Pro",
    usageLimits: {
      checkedAt: "2026-09-03T11:55:00.000Z",
      windows: [{ ...window, id: "gemini-weekly", kind: "weekly", label: "Gemini · Weekly" }],
    },
  });
  const on = (...providers: ServerProvider[]) =>
    new Map([
      [
        EnvironmentId.make("mac"),
        { entry: { target: { label: "Mac" } }, serverConfig: { providers } },
      ],
    ]);
  const older = ultra({
    checkedAt: readAt,
    windows: [{ ...window, id: "gemini-weekly", kind: "weekly", label: "Gemini · Weekly" }],
    unavailable: failure,
  });

  it("dates an older reading and keeps it out of pace and forecasts", () => {
    expect(olderReadingAt(older.usageLimits!)).toBe(Date.parse(readAt));
    expect(olderReadingAt(pro.usageLimits!)).toBeNull();
    expect(olderReadingAt({ checkedAt: readAt, windows: [], unavailable: failure })).toBeNull();

    const pools = collectLimitPools(collectLimitAccounts(on(older, pro)), now);
    // Each plan keeps its own section, as when both read live; the default instance leads.
    expect(pools.map((pool) => [pool.label, pool.accounts.map((account) => account.asOf)])).toEqual(
      [
        ["Google Ultra", [Date.parse(readAt)]],
        ["Google Pro", [undefined]],
      ],
    );
    const ultraPool = pools.find((pool) => pool.label === "Google Ultra")!;
    expect(ultraPool.windows[0]?.usedPercent).toBe(40);
    expect(ultraPool.windows[0]?.pace).toBeNull();
    expect(poolForecast(ultraPool.windows, now)).toBeNull();
    expect(pools.find((pool) => pool.label === "Google Pro")?.windows[0]?.pace).toBe("under");
  });

  it("lists a plan with no numbers as its own row with its notice", () => {
    const unread = ultra({
      checkedAt: "2026-09-03T11:59:00.000Z",
      windows: [],
      unavailable: failure,
    });
    const pools = collectLimitPools(
      collectLimitAccounts(on(unread, pro), { withNotices: true }),
      now,
    );
    expect(
      pools.map((pool) => [
        pool.label,
        pool.windows.length,
        pool.unread.map((account) => [account.plan, account.notice]),
      ]),
    ).toEqual([
      ["Google Ultra", 0, [["Google AI Ultra", failure.message]]],
      ["Google Pro", 1, []],
    ]);
    // Views that only draw numbers never see it.
    expect(collectLimitPools(collectLimitAccounts(on(unread, pro)), now)).toHaveLength(1);
  });

  it("lists a signed-out plan with its sign-in notice in place of its last numbers", () => {
    const reason =
      "Signed out. Sign in again with `CLAUDE_CONFIG_DIR=/Users/me/.claude-work claude auth login`.";
    const signedOut = {
      ...older,
      recentFailure: {
        kind: "authentication_error" as const,
        message: reason,
        occurredAt: "2026-09-03T10:00:00.000Z",
      },
    };
    const pools = collectLimitPools(
      collectLimitAccounts(on(signedOut, pro), { withNotices: true }),
      now,
    );
    expect(
      pools.map((pool) => [
        pool.label,
        pool.windows.length,
        pool.unread.map((account) => [account.asOf, account.notice]),
      ]),
    ).toEqual([
      ["Google Ultra", 0, [[undefined, reason]]],
      ["Google Pro", 1, []],
    ]);
  });

  it("prefers a live reading of the same account over an older one or a notice, whatever their times", () => {
    const email = "same@example.com";
    const at = (id: string, usageLimits: ServerProvider["usageLimits"], environment: string) =>
      [
        EnvironmentId.make(environment),
        {
          entry: { target: { label: environment } },
          serverConfig: {
            providers: [
              provider({
                instanceId: ProviderInstanceId.make(id),
                auth: { status: "authenticated", email },
                usageLimits,
              }),
            ],
          },
        },
      ] as const;
    const live = { checkedAt: "2026-09-03T08:00:00.000Z", windows: [window] };
    const olderLimits = {
      checkedAt: "2026-09-03T09:00:00.000Z",
      windows: [{ ...window, usedPercent: 10 }],
      unavailable: failure,
    };
    const noticeLimits = {
      checkedAt: "2026-09-03T11:59:00.000Z",
      windows: [],
      unavailable: failure,
    };
    for (const order of [
      [at("codex", noticeLimits, "a"), at("codex", olderLimits, "b"), at("codex", live, "c")],
      [at("codex", live, "c"), at("codex", olderLimits, "b"), at("codex", noticeLimits, "a")],
    ]) {
      const [account] = collectLimitAccounts(new Map(order), { withNotices: true });
      expect(account?.limits.windows[0]?.usedPercent).toBe(40);
      expect(account?.asOf).toBeUndefined();
      expect(account?.notice).toBeUndefined();
      expect(account?.environments.map((environment) => environment.label).sort()).toEqual([
        "a",
        "b",
        "c",
      ]);
    }
    const [olderWins] = collectLimitAccounts(
      new Map([at("codex", noticeLimits, "a"), at("codex", olderLimits, "b")]),
      { withNotices: true },
    );
    expect(olderWins?.asOf).toBe(Date.parse(olderLimits.checkedAt));
    expect(olderWins?.notice).toBeUndefined();
  });

  it("says when an older reading was taken, with the date from another day", () => {
    const clock = () => "5:23 PM";
    expect(formatAsOf(Date.parse(readAt), Date.parse(readAt) + 60_000, clock)).toBe(
      "as of 5:23 PM",
    );
    expect(formatAsOf(Date.parse(readAt), Date.parse(readAt) + 3 * 86_400_000, clock)).toMatch(
      /^as of .+, 5:23 PM$/,
    );
  });
});

describe("/usage-limits", () => {
  const limits = { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] };
  const selected = provider({
    usageLimits: limits,
    auth: { status: "authenticated", email: "same@example.com" },
  });
  const sources = [
    {
      id: UsageLimitSourceId.make("hub"),
      kind: "cliproxy" as const,
      label: "Accounts",
      checkedAt: limits.checkedAt,
      accounts: [
        {
          id: "duplicate",
          driver: selected.driver,
          email: "SAME@example.com",
          usageLimits: limits,
        },
        { id: "oss", driver: selected.driver, plan: "Codex OSS", usageLimits: limits },
        { id: "other-provider", driver: ProviderDriverKind.make("claude"), usageLimits: limits },
      ],
    },
  ];

  it("uses hub credit balances and redemption targets in the composer, including native duplicates", () => {
    const hubs = sources.map((source) => ({
      ...source,
      accounts: source.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          resetCredits: { availableCount: 2, nextCreditId: `${account.id}-credit` },
        },
      })),
    }));
    const report = collectProviderUsageLimits(selected.instanceId, [selected], hubs, now);
    expect(report?.accounts[0]?.limits.resetCredits?.availableCount).toBe(2);
    expect(report?.accounts[0]?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "duplicate",
      creditId: "duplicate-credit",
    });
    expect(report?.accounts.find((account) => account.id === "hub:oss")?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "oss",
      creditId: "oss-credit",
    });
  });

  it("gives a hub credit to no native row when its email is signed in to two workspaces", () => {
    const workspaces = ["ws-a", "ws-b"].map((workspaceId) =>
      provider({
        instanceId: ProviderInstanceId.make(workspaceId),
        usageLimits: limits,
        auth: { status: "authenticated", email: "same@example.com", workspaceId },
      }),
    );
    const hub = [
      {
        ...sources[0]!,
        accounts: [
          {
            id: "duplicate",
            driver: selected.driver,
            email: "same@example.com",
            usageLimits: { ...limits, resetCredits: { availableCount: 2, nextCreditId: "c" } },
          },
        ],
      },
    ];
    const report = collectProviderUsageLimits(workspaces[0]!.instanceId, workspaces, hub, now);
    expect(report?.accounts.map((account) => account.resetCreditInput)).toEqual([
      { instanceId: "ws-a" },
      { instanceId: "ws-b" },
      { sourceId: "hub", accountId: "duplicate", creditId: "c" },
    ]);
  });

  it("redeems a native duplicate through the hub even when the native snapshot is fresher", () => {
    const fresher = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:30:00.000Z",
        windows: [window],
        resetCredits: { availableCount: 3, nextCreditId: "native-credit" },
      },
      auth: { status: "authenticated", email: "same@example.com" },
    });
    const stale = [
      {
        id: UsageLimitSourceId.make("hub"),
        kind: "cliproxy" as const,
        label: "Accounts",
        checkedAt: limits.checkedAt,
        accounts: [
          {
            id: "duplicate",
            driver: fresher.driver,
            email: "SAME@example.com",
            usageLimits: {
              ...limits,
              resetCredits: { availableCount: 2, nextCreditId: "hub-credit" },
            },
          },
        ],
      },
    ];
    const report = collectProviderUsageLimits(fresher.instanceId, [fresher], stale, now);
    // Only redeeming through the hub clears the routing cooldown it holds for
    // this account, so the hub wins the path even with a staler balance.
    expect(report?.accounts[0]?.resetCreditInput).toEqual({
      sourceId: "hub",
      accountId: "duplicate",
      creditId: "hub-credit",
    });
    // The fresher native balance is still the one shown.
    expect(report?.accounts[0]?.limits.resetCredits?.availableCount).toBe(3);
  });

  it("keeps accounts and custom instances separate, filtering by driver", () => {
    const report = collectProviderUsageLimits(
      selected.instanceId,
      [
        selected,
        provider({
          instanceId: ProviderInstanceId.make("codex-work"),
          displayName: "Work",
          usageLimits: { ...limits, resetCredits: { availableCount: 2 } },
        }),
        provider({
          driver: ProviderDriverKind.make("claude"),
          instanceId: ProviderInstanceId.make("claude"),
          usageLimits: limits,
        }),
      ],
      sources,
      now,
    );
    expect(report?.createdAt).toBe("2026-09-03T12:00:00.000Z");
    expect(report?.accounts.map((account) => account.id)).toEqual([
      "codex",
      "codex-work",
      "hub:oss",
    ]);
    expect(report?.accounts[0]).toMatchObject({
      instanceId: selected.instanceId,
      email: selected.auth.email,
    });
    expect(report?.accounts[1]).toMatchObject({
      displayName: "Work",
      limits: { resetCredits: { availableCount: 2 } },
    });
    expect(report?.accounts[2]).toMatchObject({
      label: "Accounts · oss",
      sourceLabel: "CLI Proxy",
      plan: "Codex OSS",
    });
    expect(report?.notices).toEqual([]);
  });

  it("supports a source-only provider and keeps duplicates when the native probe failed", () => {
    expect(
      collectProviderUsageLimits(selected.instanceId, [provider({})], sources, now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["hub:duplicate", "hub:oss"]);
    const failed = provider({ usageLimits: { ...limits, unavailable: { reason: "probeFailed" } } });
    expect(
      collectProviderUsageLimits(selected.instanceId, [failed], sources, now)?.accounts.map(
        (account) => account.id,
      ),
    ).toEqual(["codex", "hub:duplicate", "hub:oss"]);
    expect(collectProviderUsageLimits(selected.instanceId, [provider({})], [], now)).toBeNull();
    expect(
      collectProviderUsageLimits(
        selected.instanceId,
        [provider({ enabled: false, usageLimits: limits })],
        [],
        now,
      ),
    ).toBeNull();
  });

  it("surfaces source errors only for sources that carry the selected driver", () => {
    const failing = { ...sources[0]!, error: "token expired" };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [failing], now)?.notices,
    ).toEqual(["Accounts: token expired"]);
    const claudeOnly = { ...failing, accounts: failing.accounts.slice(2) };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [claudeOnly], now)?.notices,
    ).toEqual([]);
    // A read failure clears the accounts, so the error must not depend on a match.
    const unreadable = { ...failing, accounts: [] };
    expect(
      collectProviderUsageLimits(selected.instanceId, [selected], [unreadable], now)?.notices,
    ).toEqual(["Accounts: token expired"]);
    // A source-only provider still gets the report, carrying only the error.
    const sourceOnly = collectProviderUsageLimits(
      selected.instanceId,
      [provider({})],
      [unreadable],
      now,
    );
    expect(sourceOnly?.accounts).toEqual([]);
    expect(sourceOnly?.notices).toEqual(["Accounts: token expired"]);
  });

  it("advertises global and workspace commands only for providers present in Limits", () => {
    const withWorkspace = provider({
      workspaceSnapshots: [
        { cwd: "/tmp/project", checkedAt: limits.checkedAt, slashCommands: [], skills: [] },
      ],
    });
    const [supported] = withUsageLimitsCommands([withWorkspace], sources);
    expect(supported?.slashCommands.map((command) => command.name)).toEqual(["usage-limits"]);
    expect(
      supported?.workspaceSnapshots?.[0]?.slashCommands.map((command) => command.name),
    ).toEqual(["usage-limits"]);
    expect(withUsageLimitsCommands([withWorkspace], [])[0]?.slashCommands).toEqual([]);
    // A provider's own command of the same name is left alone without coverage.
    const ownCommand = provider({
      slashCommands: [{ name: "usage-limits", description: "Provider's own" }],
    });
    expect(withUsageLimitsCommands([ownCommand], [])[0]?.slashCommands).toEqual([
      { name: "usage-limits", description: "Provider's own" },
    ]);
    const unreadable = { ...sources[0]!, accounts: [], error: "token expired" };
    expect(
      withUsageLimitsCommands([withWorkspace], [unreadable])[0]?.slashCommands.map(
        (command) => command.name,
      ),
    ).toEqual(["usage-limits"]);
    expect(
      withUsageLimitsCommands([selected], [])[0]?.slashCommands.map((command) => command.name),
    ).toEqual(["usage-limits"]);
  });
});

describe("sameUsageLimitCommandCoverage", () => {
  const codexAccount = {
    id: "a",
    driver: ProviderDriverKind.make("codex"),
    usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [] },
  };
  const base = {
    id: UsageLimitSourceId.make("hub"),
    kind: "cliproxy" as const,
    label: "Accounts",
    checkedAt: "2026-09-03T11:00:00.000Z",
  };
  it("ignores quota movement but not the drivers offered the command", () => {
    const withCodex = [{ ...base, accounts: [codexAccount] }];
    const withCodexLater = [
      {
        ...base,
        accounts: [
          {
            ...codexAccount,
            usageLimits: { ...codexAccount.usageLimits, checkedAt: "2026-09-03T12:00:00.000Z" },
          },
        ],
      },
    ];
    expect(sameUsageLimitCommandCoverage(withCodex, withCodexLater)).toBe(true);
    expect(sameUsageLimitCommandCoverage(withCodex, [{ ...base, accounts: [] }])).toBe(false);
  });
  it("treats a failed read as a change in coverage, in both directions", () => {
    const empty = [{ ...base, accounts: [] }];
    const failed = [{ ...base, accounts: [], error: "token expired" }];
    expect(sameUsageLimitCommandCoverage(empty, failed)).toBe(false);
    expect(sameUsageLimitCommandCoverage(failed, empty)).toBe(false);
    expect(
      sameUsageLimitCommandCoverage(failed, [{ ...base, accounts: [], error: "still down" }]),
    ).toBe(true);
  });
});

describe("remainingPercent", () => {
  it.each([
    [99, undefined, 1, "1%", false],
    [99, false, 1, "1%", false],
    [99.1, undefined, 0.9, "<1%", false],
    [99.6, false, 0.4, "<1%", false],
    [100, false, 0, "<1%", false],
    [100, undefined, 0, "0%", true],
    [99.6, true, 0, "0%", true],
    [120, undefined, 0, "0%", true],
    [-20, undefined, 100, "100%", false],
  ] as const)(
    "formats %s used with verdict %s",
    (usedPercent, limited, remaining, label, reached) => {
      const amount = { usedPercent, limited };
      expect(remainingPercent(amount)).toBeCloseTo(remaining);
      expect(remainingPercentLabel(amount)).toBe(label);
      expect(isUsageWindowLimited(amount)).toBe(reached);
      if (label === "<1%") expect(usedPercentLabel(amount)).toBe("<1% left");
    },
  );

  it("keeps precise pooled headroom and the provider verdict", () => {
    const presentations = new Map([
      [
        EnvironmentId.make("edge"),
        {
          entry: { target: { label: "Edge" } },
          serverConfig: {
            providers: [
              provider({
                usageLimits: {
                  checkedAt: "2026-09-03T12:00:00.000Z",
                  windows: [{ ...window, usedPercent: 99.6, limited: false }],
                },
              }),
            ],
          },
        },
      ],
    ]);
    const pool = collectLimitPools(collectLimitAccounts(presentations), now)[0]!.windows[0]!;
    expect(pool.usedPercent).toBe(99.6);
    expect(pool.remainingPercent).toBeCloseTo(0.4);
    expect(remainingPercentLabel(pool)).toBe("<1%");
    expect(pool.limited).toBe(false);
  });

  it("inverts and clamps the reported usage", () => {
    expect(remainingPercent(window)).toBe(60);
    expect(remainingPercent({ ...window, usedPercent: 0 })).toBe(100);
    expect(remainingPercent({ ...window, usedPercent: 100 })).toBe(0);
    expect(remainingPercent({ ...window, usedPercent: 33.4 })).toBe(67);
  });
});

describe("isUsageLimitsCommand", () => {
  it("recognizes only the standalone local action", () => {
    expect(isUsageLimitsCommand("  /USAGE-LIMITS\n")).toBe(true);
    expect(isUsageLimitsCommand("/usage-limits explain")).toBe(false);
    expect(isUsageLimitsCommand("Explain /usage-limits")).toBe(false);
    expect(isUsageLimitsCommand("/usage")).toBe(false);
  });
});

describe("external usage settings", () => {
  it("deduplicates destinations across accounts and environments without inventing quota pools", () => {
    const managed = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [],
        unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
        externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" },
      },
    });
    const presentations = new Map([
      [
        EnvironmentId.make("a"),
        {
          entry: { target: { label: "A" } },
          serverConfig: {
            providers: [managed, { ...managed, instanceId: ProviderInstanceId.make("personal") }],
          },
        },
      ],
      [
        EnvironmentId.make("b"),
        { entry: { target: { label: "B" } }, serverConfig: { providers: [managed] } },
      ],
    ]);
    expect(collectExternalUsageLinks(presentations)).toEqual([
      {
        ...managed.usageLimits!.externalUsage,
        message: "Track usage in ChatGPT.",
        accounts: [`${managed.instanceId} on A`, "personal on A", `${managed.instanceId} on B`],
      },
    ]);
    expect(collectLimitAccounts(presentations)).toEqual([]);
    expect(collectLimitNotices(presentations)).toEqual([]);
  });
  it("omits disabled, uninstalled and signed-out providers", () => {
    const managed = provider({
      usageLimits: {
        checkedAt: "2026-09-03T11:00:00.000Z",
        windows: [],
        externalUsage: { label: "ChatGPT usage", url: "https://chatgpt.com/#settings/Usage" },
      },
    });
    const presentations = new Map([
      [
        EnvironmentId.make("a"),
        {
          entry: { target: { label: "A" } },
          serverConfig: {
            providers: [
              { ...managed, enabled: false },
              { ...managed, installed: false },
              { ...managed, auth: { status: "unauthenticated" as const } },
              provider({}),
            ],
          },
        },
      ],
    ]);
    expect(collectExternalUsageLinks(presentations)).toEqual([]);
  });
});

describe("ChatGPT sharing presentation", () => {
  it("requires verified sharing metadata rather than the Codex driver or login type", () => {
    const codex = provider({ auth: { status: "authenticated", type: "chatgpt" } });
    expect(usesChatGptSharing(codex)).toBe(false);
    expect(
      usesChatGptSharing({ ...codex, auth: { ...codex.auth, subscriptionSharing: true } }),
    ).toBe(true);
    expect(
      usesChatGptSharing({
        ...codex,
        auth: { status: "unauthenticated", subscriptionSharing: true },
      }),
    ).toBe(false);
  });
});

describe("Antigravity limit presentation", () => {
  it("keeps the shared Claude/GPT bucket separate from Gemini and pairs their windows", () => {
    const antigravity = provider({
      instanceId: ProviderInstanceId.make("antigravity"),
      driver: ProviderDriverKind.make("antigravity"),
      usageLimits: {
        checkedAt: "2026-10-09T12:00:00.000Z",
        windows: [
          { ...window, id: "3p-5h", label: "Claude & GPT (shared) · 5-hour", usedPercent: 90 },
          { ...window, id: "gemini-5h", label: "Gemini · 5-hour", usedPercent: 20 },
          {
            ...window,
            id: "3p-weekly",
            kind: "weekly",
            label: "Claude & GPT (shared) · Weekly",
            usedPercent: 100,
          },
          {
            ...window,
            id: "gemini-weekly",
            kind: "weekly",
            label: "Gemini · Weekly",
            usedPercent: 10,
          },
        ],
      },
    });
    const accounts = collectLimitAccounts(
      new Map([
        [
          EnvironmentId.make("a"),
          {
            entry: { target: { label: "Local" } },
            serverConfig: {
              providers: [
                provider({
                  usageLimits: { checkedAt: "2026-10-09T12:00:00.000Z", windows: [window] },
                }),
                antigravity,
              ],
            },
          },
        ],
      ]),
    );
    const pools = collectLimitPools(accounts, now);
    expect(pools.map((pool) => pool.driver)).toEqual(["codex", "antigravity"]);
    const windows = displayLimitWindows(pools[1]!);
    expect(windows.map((window) => window.id)).toEqual([
      "gemini-5h",
      "gemini-weekly",
      "3p-5h",
      "3p-weekly",
    ]);
    expect(windows.map((window) => window.remainingPercent)).toEqual([80, 90, 10, 0]);
    expect(
      displayProviderUsageWindows(antigravity.driver, antigravity.usageLimits!.windows).map(
        (window) => window.id,
      ),
    ).toEqual(["gemini-5h", "gemini-weekly", "3p-5h", "3p-weekly"]);
  });
});

describe("plans ordered by recent use", () => {
  const plan = (
    driver: string,
    instanceId: string,
    email: string,
    recentUse: number | undefined,
  ): ServerProvider =>
    provider({
      driver: ProviderDriverKind.make(driver),
      instanceId: ProviderInstanceId.make(instanceId),
      displayName: instanceId,
      auth: { status: "authenticated", email },
      usageLimits: { checkedAt: "2026-09-03T11:00:00.000Z", windows: [window] },
      ...(recentUse === undefined ? {} : { recentUse }),
    });
  // Listed the way a server lists them, which says nothing about use.
  const presentations = new Map([
    [
      EnvironmentId.make("mac"),
      {
        entry: { target: { label: "Mac" } },
        serverConfig: {
          providers: [
            plan("grok", "grok", "g@example.com", 6),
            plan("opencode", "opencode", "o@example.com", undefined),
            plan("codex", "codex", "c@example.com", 118),
            plan("claudeAgent", "claudeAgent", "u1@example.com", 96),
            plan("claudeAgent", "claudeAgent_work", "u2@example.com", 122),
          ],
        },
      },
    ],
  ]);
  const order = (use?: ReadonlyMap<string, number>) =>
    collectLimitPools(collectLimitAccounts(presentations), now, use).map((pool) => pool.key);

  it("reads each plan's hours by its source key", () => {
    expect([...recentUseBySource(presentations)]).toEqual([
      ["mac:grok", 6],
      ["mac:codex", 118],
      ["mac:claudeAgent", 96],
      ["mac:claudeAgent_work", 122],
    ]);
  });

  it("names a lone ACP registry plan after its agent, and a lone plan elsewhere not at all", () => {
    const devin = new Map([
      [
        EnvironmentId.make("mac"),
        {
          entry: { target: { label: "Mac" } },
          serverConfig: {
            providers: [
              {
                ...plan("acpRegistry", "acpRegistry_devin", "d@example.com", 1),
                displayName: "Devin",
              },
              { ...plan("codex", "codex", "c@example.com", 1), displayName: "Work" },
            ],
          },
        },
      ],
    ]);
    const labels = collectLimitPools(collectLimitAccounts(devin), now).map((pool) => [
      pool.key,
      pool.label,
    ]);
    expect(labels).toEqual(
      expect.arrayContaining([
        ["acpRegistry", "Devin"],
        ["codex", null],
      ]),
    );
  });

  it("puts the most used provider first, and its most used plan first", () => {
    expect(order(recentUseBySource(presentations))).toEqual([
      "claudeAgent:mac:claudeAgent_work",
      "claudeAgent",
      "codex",
      "grok",
      "opencode",
    ]);
  });

  it("keeps the listed order without use", () => {
    expect(order()).toEqual([
      "grok",
      "opencode",
      "codex",
      "claudeAgent",
      "claudeAgent:mac:claudeAgent_work",
    ]);
  });
});
