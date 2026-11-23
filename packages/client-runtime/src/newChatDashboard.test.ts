import { describe, expect, it } from "vite-plus/test";
import { HARNESS_MASCOTS } from "@t3tools/shared/harnessMascots";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  buildNewChatActivity,
  chatBackdropMood,
  chatBackdropPalette,
  chatBackdropTint,
  chatPaceChart,
  formatChatDelta,
  formatQuotaReset,
  newChatAccounts,
  newChatUsageWindows,
  selectHappeningNow,
} from "./newChatDashboard.ts";
import {
  presentThreadShell,
  type EnvironmentThreadShell,
  type ThreadRuntimeSummary,
} from "./state/models.ts";
import { v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";

const environmentId = EnvironmentId.make("machine-a");
const now = Date.parse("2026-11-07T12:00:00-05:00");
function chat(
  id: string,
  createdAt: string,
  overrides: Partial<Parameters<typeof buildNewChatActivity>[0][number]> = {},
) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt,
    deletedAt: null,
    visibleItemCount: 1,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    ...overrides,
  };
}

describe("new chat activity", () => {
  it("keeps 26 Sunday-first weeks, with future days blank", () => {
    const activity = buildNewChatActivity(
      [],
      environmentId,
      Date.parse("2026-11-04T12:00:00-05:00"),
    );
    expect(activity.days).toHaveLength(182);
    expect(activity.days[0]?.date).toBe("2026-05-10");
    expect(activity.days.at(-1)?.date).toBe("2026-11-07");
    expect(activity.days.filter((day) => day.future).map((day) => day.date)).toEqual([
      "2026-11-05",
      "2026-11-06",
      "2026-11-07",
    ]);
    expect(activity.total).toBe(0);
  });

  it("buckets by Eastern calendar day across the fall DST change", () => {
    const activity = buildNewChatActivity(
      [
        chat("late", "2026-11-01T03:59:00Z"),
        chat("early", "2026-11-01T04:00:00Z"),
        chat("first-1am", "2026-11-01T05:30:00Z"),
        chat("second-1am", "2026-11-01T06:30:00Z"),
      ],
      environmentId,
      now,
    );
    expect(activity.days.find((day) => day.date === "2026-10-31")?.count).toBe(1);
    expect(activity.days.find((day) => day.date === "2026-11-01")?.count).toBe(3);
    expect(activity.month).toEqual({ chats: 3, activeDays: 1 });
    // Oct 31 is past the same seven days of October, so it does not count against November.
    expect(activity.delta).toEqual({ chats: 3, activeDays: 1 });
  });

  it("does not lose the spring DST day", () => {
    const activity = buildNewChatActivity(
      [
        chat("before", "2026-03-08T06:59:00Z"),
        chat("after", "2026-03-08T07:01:00Z"),
        chat("next", "2026-03-09T04:00:00Z"),
      ],
      environmentId,
      Date.parse("2026-03-10T12:00:00Z"),
    );
    expect(activity.days.find((day) => day.date === "2026-03-08")?.count).toBe(2);
    expect(activity.days.find((day) => day.date === "2026-03-09")?.count).toBe(1);
    expect(activity.activeDays).toBe(2);
  });

  it("counts a chat once and excludes empty, deleted, child-agent and other-machine shells", () => {
    const valid = chat("valid", "2026-11-03T14:00:00Z");
    const activity = buildNewChatActivity(
      [
        valid,
        valid,
        chat("empty", valid.createdAt, { visibleItemCount: 0 }),
        chat("deleted", valid.createdAt, { deletedAt: valid.createdAt }),
        chat("child", valid.createdAt, {
          lineage: {
            parentThreadId: valid.id,
            relationshipToParent: "subagent",
            rootThreadId: valid.id,
          },
        }),
        chat("elsewhere", valid.createdAt, {
          environmentId: EnvironmentId.make("machine-b"),
        }),
        chat("invalid", "bad-date"),
        chat("future", "2027-01-01T12:00:00Z"),
        chat("old", "2025-01-01T12:00:00Z"),
      ],
      environmentId,
      now,
    );
    expect(activity.total).toBe(1);
    expect(activity.month).toEqual({ chats: 1, activeDays: 1 });
    expect(buildNewChatActivity([valid], null, now).total).toBe(0);
  });

  it("compares January so far with the same days of December", () => {
    const activity = buildNewChatActivity(
      [
        chat("dec-2-a", "2025-12-02T15:00:00Z"),
        chat("dec-2-b", "2025-12-02T18:00:00Z"),
        chat("dec-31", "2025-12-31T17:00:00Z"),
        chat("dec-31-late", "2026-01-01T04:59:00Z"),
        chat("jan", "2026-01-01T05:00:00Z"),
      ],
      environmentId,
      Date.parse("2026-01-03T12:00:00Z"),
    );
    expect(activity.month).toEqual({ chats: 1, activeDays: 1 });
    expect(activity.delta).toEqual({ chats: -1, activeDays: 0 });
  });

  it("includes leap day and the exact heatmap boundary", () => {
    const empty = buildNewChatActivity([], environmentId, Date.parse("2024-03-02T12:00:00Z"));
    const activity = buildNewChatActivity(
      [
        chat("boundary", `${empty.days[0]!.date}T12:00:00Z`),
        chat("leap", "2024-02-29T12:00:00Z"),
        chat("march", "2024-03-01T12:00:00Z"),
      ],
      environmentId,
      Date.parse("2024-03-02T12:00:00Z"),
    );
    expect(activity.total).toBe(3);
    expect(activity.days[0]?.count).toBe(1);
    // March 1–2 against February 1–2: leap day is outside the compared days.
    expect(activity.delta.chats).toBe(1);
  });

  it("shades the heatmap by the user's own busy days", () => {
    const busy = Array.from({ length: 8 }, (_, day) =>
      Array.from({ length: day + 1 }, (_, index) =>
        chat(`d${day}-${index}`, `2026-10-${String(day + 10).padStart(2, "0")}T15:0${index}:00Z`),
      ),
    ).flat();
    const activity = buildNewChatActivity(busy, environmentId, now);
    const levels = activity.days
      .filter((day) => day.count > 0)
      .map((day) => [day.count, day.level]);
    expect(levels).toEqual([
      [1, 1],
      [2, 1],
      [3, 2],
      [4, 2],
      [5, 3],
      [6, 3],
      [7, 4],
      [8, 4],
    ]);
    const steady = buildNewChatActivity(busy.slice(0, 1), environmentId, now);
    expect(steady.days.find((day) => day.count > 0)?.level).toBe(3);
  });

  it("keeps running totals for this month to today and for the same days of last month", () => {
    const activity = buildNewChatActivity(
      [
        chat("oct-1", "2026-10-01T15:00:00Z"),
        chat("oct-3a", "2026-10-03T15:00:00Z"),
        chat("oct-3b", "2026-10-03T16:00:00Z"),
        chat("oct-31", "2026-10-31T15:00:00Z"),
        chat("nov-2", "2026-11-02T15:00:00Z"),
        chat("nov-7a", "2026-11-07T15:00:00Z"),
        chat("nov-7b", "2026-11-07T16:00:00Z"),
      ],
      environmentId,
      now,
    );
    expect(activity.pace.month).toBe("Nov");
    expect(activity.pace.previousMonth).toBe("Oct");
    expect(activity.pace.daysInMonth).toBe(30);
    // Nov 1 to 7, today included.
    expect(activity.pace.current).toEqual([0, 1, 1, 1, 1, 1, 3]);
    // October is cut at November's 30 days, so its 31st stays out.
    expect(activity.pace.previous).toHaveLength(30);
    expect(activity.pace.previous.slice(0, 4)).toEqual([1, 1, 3, 3]);
    expect(activity.pace.previous.at(-1)).toBe(3);
    // The gap on today is the stated delta.
    expect(activity.pace.current[6]! - activity.pace.previous[6]!).toBe(activity.delta.chats);
  });

  it("draws both months on one scale, with a dot on today", () => {
    const chart = chatPaceChart(
      {
        daysInMonth: 30,
        current: [0, 2, 4],
        previous: Array.from({ length: 30 }, (_, index) => index),
        month: "Nov",
        previousMonth: "Oct",
      },
      300,
      60,
    );
    // Last month ends at the top right corner of the inset box; this month starts bottom left.
    expect(chart.previous.endsWith("L296.0 4.0")).toBe(true);
    expect(chart.current.startsWith("M4.0 56.0")).toBe(true);
    expect(chart.today.x).toBeCloseTo(4 + (2 / 29) * 292, 5);
    expect(chart.today.y).toBeCloseTo(56 - (4 / 29) * 52, 5);
    expect(chart.area.endsWith("Z")).toBe(true);
    // Last month's total is labelled where its line ends.
    expect(chart.previousEnd).toEqual({ x: 296, y: 4, total: 29 });
  });

  it("drops last month's label once today's dot reaches it", () => {
    const month = Array.from({ length: 30 }, (_, index) => index + 1);
    expect(
      chatPaceChart(
        {
          daysInMonth: 30,
          current: month.slice(0, 28),
          previous: month,
          month: "Nov",
          previousMonth: "Oct",
        },
        300,
        60,
      ).previousEnd,
    ).toBeNull();
  });

  it("draws an empty first day of a month without an area or a divide by zero", () => {
    const chart = chatPaceChart(
      { daysInMonth: 31, current: [0], previous: [], month: "Dec", previousMonth: "Nov" },
      300,
      60,
    );
    expect(chart.current).toBe("M4.0 56.0");
    expect(chart.previous).toBe("");
    expect(chart.area).toBe("");
    expect(chart.today).toEqual({ x: 4, y: 56 });
    expect(chart.previousEnd).toBeNull();
  });

  it("formats signed deltas without dividing by an empty previous month", () => {
    expect([3, 0, -4].map(formatChatDelta)).toEqual(["+3", "0", "\u22124"]);
  });

  it("formats resets in Eastern 12-hour time and handles missing dates", () => {
    expect(formatQuotaReset("2026-07-01T16:05:00Z")).toBe("Jul 1, 12:05 PM ET");
    expect(formatQuotaReset("2026-12-01T16:05:00Z")).toBe("Dec 1, 11:05 AM ET");
    expect(formatQuotaReset(undefined)).toBe("Not reported");
    expect(formatQuotaReset("invalid")).toBe("Not reported");
  });

  it("uses reported quota windows for the selected provider without inventing usage", () => {
    const config = {
      usageLimitSources: [],
      providers: [
        {
          instanceId: ProviderInstanceId.make("codex"),
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          installed: true,
          version: null,
          status: "ready" as const,
          auth: { status: "authenticated" as const },
          checkedAt: "2026-11-07T12:00:00Z",
          models: [],
          slashCommands: [],
          skills: [],
          usageLimits: {
            checkedAt: "2026-11-07T12:00:00Z",
            windows: [
              {
                id: "session",
                kind: "session" as const,
                label: "Session",
                usedPercent: 38,
                resetsAt: "2026-11-07T16:00:00Z",
              },
            ],
          },
        },
      ],
    };
    const [window] = newChatUsageWindows(config, environmentId, "codex");
    expect(window?.usedPercent).toBe(38);
    const tighter = {
      ...config,
      providers: config.providers.map((provider) => ({
        ...provider,
        usageLimits: {
          ...provider.usageLimits,
          windows: [
            ...provider.usageLimits.windows,
            {
              id: "weekly",
              kind: "weekly" as const,
              label: "Weekly",
              usedPercent: 91,
              resetsAt: "2026-11-09T16:00:00Z",
            },
          ],
        },
      })),
    };
    expect(newChatUsageWindows(tighter, environmentId, "codex").map((entry) => entry.id)).toEqual([
      "weekly",
      "session",
    ]);
    expect(window?.resetsAt).toBe("2026-11-07T16:00:00Z");
    expect(newChatUsageWindows(config, environmentId, "claudeAgent")).toEqual([]);
    expect(newChatUsageWindows(null, environmentId, null)).toEqual([]);
  });

  it("shows the limits of the account the selected model runs on", () => {
    const account = (instanceId: string, displayName: string, email: string, used: number) => ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make("claudeAgent"),
      displayName,
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const, email },
      checkedAt: "2026-11-16T12:00:00Z",
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: {
        checkedAt: "2026-11-16T12:00:00Z",
        windows: [
          {
            id: "seven_day",
            kind: "weekly" as const,
            label: "Weekly",
            usedPercent: used,
            resetsAt: "2026-11-18T12:00:00Z",
          },
        ],
      },
    });
    const config = {
      providers: [
        account("claudeAgent", "Claude", "first@example.com", 93),
        account("claudeAgent_work", "Max-2", "second@example.com", 4),
      ],
    };
    const shown = (instanceId: string | null) =>
      newChatUsageWindows(config, environmentId, "claudeAgent", instanceId).map(
        (entry) => `${entry.accountLabel} ${entry.usedPercent}`,
      );

    expect(shown("claudeAgent_work")).toEqual(["Max-2 4"]);
    expect(shown("claudeAgent")).toEqual(["Claude 93"]);
    // No account chosen, or one with no limits of its own: the provider's accounts, tightest first.
    expect(shown(null)).toEqual(["Claude 93", "Max-2 4"]);
    expect(shown("claudeAgent_other")).toEqual(["Claude 93", "Max-2 4"]);
  });
});

describe("chat backdrop identity", () => {
  it.each([
    ["claudeAgent", "claude-acp"],
    ["codex", "codex-acp"],
    ["opencode", "opencode"],
  ])("keeps %s and its registry alias consistent", (driver, agentId) => {
    expect(chatBackdropTint("acpRegistry", agentId)).toBe(chatBackdropTint(driver));
  });
  it("keeps every harness hue visibly apart, Qwen included", () => {
    // OKLab distance: about 0.02 is a just-noticeable difference.
    const oklab = (hex: string) => {
      const [r, g, b] = [1, 3, 5].map((index) => {
        const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      }) as [number, number, number];
      const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
      const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
      const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
      return [
        0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
      ];
    };
    const harnesses = Object.values(HARNESS_MASCOTS)
      .filter((mascot) => !("modelFamilyOnly" in mascot))
      .map((mascot) =>
        chatBackdropTint(mascot.driver, "agentIds" in mascot ? mascot.agentIds[0] : null),
      );
    // Qwen Code is one of the harnesses now; asked for by agent it gets that same hue.
    expect(harnesses).toContain(chatBackdropTint("acpRegistry", "qwen-code"));
    const hues = harnesses.map(oklab);
    for (const [index, hue] of hues.entries()) {
      for (const other of hues.slice(index + 1)) {
        expect(Math.hypot(...hue.map((value, channel) => value - other[channel]!))).toBeGreaterThan(
          0.08,
        );
      }
    }
    expect(chatBackdropTint(null)).toBe(chatBackdropTint("acpRegistry", "unknown"));
    expect(chatBackdropTint("qwenCode")).toBe(chatBackdropTint("acpRegistry", " qwen-code "));
  });
  it("runs the rim hotter than the glow on each theme", () => {
    const luminance = (hex: string) =>
      [1, 3, 5].reduce((sum, index) => sum + Number.parseInt(hex.slice(index, index + 2), 16), 0);
    const palette = chatBackdropPalette("claudeAgent");
    expect(palette.glow).toBe(chatBackdropTint("claudeAgent"));
    expect(luminance(palette.rimDark)).toBeGreaterThan(luminance(palette.glow));
    expect(luminance(palette.rimLight)).toBeLessThan(luminance(palette.glow));
  });
});

describe("happening now", () => {
  const away = EnvironmentId.make("machine-away");
  const running: ThreadRuntimeSummary = {
    status: "running",
    activeRunId: null,
    providerInstanceId: v2ThreadShell.providerInstanceId,
    providerName: null,
    lastError: null,
    updatedAt: "2026-11-07T16:00:00.000Z",
  };
  const shell = (
    id: string,
    overrides: Partial<EnvironmentThreadShell> = {},
  ): EnvironmentThreadShell => ({
    ...presentThreadShell(environmentId, {
      ...v2ThreadShell,
      id: ThreadId.make(id),
      title: id,
      lineage: {
        rootThreadId: ThreadId.make(id),
        parentThreadId: null,
        relationshipToParent: null,
      },
    }),
    ...overrides,
  });
  const select = (threads: ReadonlyArray<EnvironmentThreadShell>) =>
    selectHappeningNow(threads, {
      now,
      connectionPhase: (id) => (id === away ? "offline" : "connected"),
    });

  it("lists what waits on the user before what is working, and nothing else", () => {
    const result = select([
      shell("idle"),
      shell("working", { runtime: running }),
      shell("approval", { hasPendingApprovals: true }),
      shell("question", { runtime: running, hasPendingUserInput: true }),
    ]);
    expect(result.entries.map((entry) => entry.thread.id).slice(-1)).toEqual(["working"]);
    expect(new Set(result.entries.map((entry) => entry.thread.id))).toEqual(
      new Set(["approval", "question", "working"]),
    );
    expect(result).toMatchObject({ needsYou: 2, working: 1 });
    expect(result.entries.at(-1)?.box).toMatchObject({ tone: "working", mascot: "working" });
  });

  it("leaves out subagents, archived, deleted and snoozed chats", () => {
    const parent = ThreadId.make("parent");
    const result = select([
      shell("subagent", {
        runtime: running,
        lineage: { rootThreadId: parent, parentThreadId: parent, relationshipToParent: "subagent" },
      }),
      shell("archived", { runtime: running, archivedAt: "2026-11-07T10:00:00.000Z" }),
      shell("deleted", { runtime: running, deletedAt: "2026-11-07T10:00:00.000Z" }),
      shell("snoozed", {
        hasActionableProposedPlan: true,
        snoozedUntil: "2026-11-09T10:00:00.000Z",
        snoozedAt: "2026-11-07T10:00:00.000Z",
      }),
    ]);
    expect(result).toEqual({ entries: [], needsYou: 0, working: 0 });
  });

  it("does not call cached work on a disconnected machine running, but keeps its requests", () => {
    const result = select([
      shell("cached", { environmentId: away, runtime: running }),
      shell("asked", { environmentId: away, runtime: running, hasPendingUserInput: true }),
    ]);
    expect(result.entries.map((entry) => entry.thread.id)).toEqual(["asked"]);
    expect(result).toMatchObject({ needsYou: 1, working: 0 });
  });
});

describe("chat backdrop mood", () => {
  it("follows the mascot's turn states and rests through its other moments", () => {
    expect(["working", "waiting", "done", "failed"].map(chatBackdropMood)).toEqual([
      "working",
      "waiting",
      "done",
      "failed",
    ]);
    expect(["idle", "greet", "idea", ""].map(chatBackdropMood)).toEqual([
      "idle",
      "idle",
      "idle",
      "idle",
    ]);
  });
});

describe("newChatAccounts", () => {
  const model = "claude-fable-5-2";
  const account = (instanceId: string, displayName: string, usedPercent: number) => ({
    instanceId,
    driver: "claudeAgent",
    displayName,
    continuation: { groupKey: "claude:home:/synthetic/.claude" },
    enabled: true,
    installed: true,
    auth: { status: "authenticated" },
    models: [{ slug: model, name: "Fable 5.2" }],
    usageLimits: {
      checkedAt: "2026-11-07T12:00:00Z",
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          usedPercent,
          resetsAt: "2026-11-09T16:00:00Z",
          windowDurationMins: 10_080,
        },
      ],
    },
  });
  const config = {
    providers: [account("claudeAgent", "Max 1", 94), account("claudeAgent_work", "Max 2", 9)],
  } as unknown as Parameters<typeof newChatAccounts>[0];

  it("lists the user's accounts as equals, the roomiest first, and marks this chat's", () => {
    const onSecond = newChatAccounts(config, { instanceId: "claudeAgent_work", model }, now);
    expect(onSecond?.rows).toEqual([
      {
        instanceId: "claudeAgent_work",
        name: "Max 2",
        limit: { label: "Weekly", usedPercent: 9, resetsAt: "2026-11-09T16:00:00Z" },
        current: true,
      },
      {
        instanceId: "claudeAgent",
        name: "Max 1",
        limit: { label: "Weekly", usedPercent: 94, resetsAt: "2026-11-09T16:00:00Z" },
        current: false,
      },
    ]);
    expect(onSecond?.note).toBe(
      "New chats start on Max 2: it has the most left to use before its reset.",
    );
    // Picked by hand: the rows hold still and the note still says where new chats start.
    const onFirst = newChatAccounts(config, { instanceId: "claudeAgent", model }, now);
    expect(onFirst?.rows.map((row) => [row.name, row.current])).toEqual([
      ["Max 2", false],
      ["Max 1", true],
    ]);
    expect(onFirst?.note).toBe(onSecond?.note);
  });

  it("is null for a model on a single account", () => {
    const single = { providers: [config!.providers[0]!] } as typeof config;
    expect(newChatAccounts(single, { instanceId: "claudeAgent", model }, now)).toBeNull();
    expect(newChatAccounts(config, null, now)).toBeNull();
    expect(newChatAccounts(null, { instanceId: "claudeAgent", model }, now)).toBeNull();
  });
});
