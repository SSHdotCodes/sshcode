import {
  AGENT_QUESTION_LEVELS,
  AGENT_REPLY_LEVELS,
  AGENT_SUBAGENT_LEVELS,
  AGENT_TOKEN_LEVELS,
  AGENT_VERIFICATION_LEVELS,
  DEFAULT_AGENT_BEHAVIOR,
  ServerSettingsPatch,
  type AgentBehaviorLevels,
} from "@t3tools/contracts";
import {
  AGENT_TOKEN_ESTIMATES,
  AGENT_TOKEN_ESTIMATES_SHOWN,
} from "@t3tools/shared/agentTokenEstimates";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  AGENT_BEHAVIOR_RESET_PATCH,
  AGENT_BEHAVIOR_SLIDERS,
  agentBehaviorOnMachines,
  agentBehaviorPatch,
  agentBehaviorSliderState,
  agentBehaviorSummary,
  agentBehaviorSyncPatch,
  agentTokenCostLine,
  agentTokenHarness,
  subagentsOffInSettings,
  syncedAgentBehavior,
  weeklyChatsByHarness,
} from "./agentBehavior.ts";

const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);

describe("Settings > Agents sliders", () => {
  it("draws every contract level once, in order, with Default where today's behavior is", () => {
    expect(AGENT_BEHAVIOR_SLIDERS.map((slider) => slider.title)).toEqual([
      "Token use",
      "Subagents",
      "Questions",
      "Checking work",
      "Replies",
    ]);
    const contract = {
      tokens: AGENT_TOKEN_LEVELS,
      subagents: AGENT_SUBAGENT_LEVELS,
      questions: AGENT_QUESTION_LEVELS,
      verification: AGENT_VERIFICATION_LEVELS,
      replies: AGENT_REPLY_LEVELS,
    };
    for (const slider of AGENT_BEHAVIOR_SLIDERS) {
      expect(slider.levels.map((option) => option.level)).toEqual(contract[slider.key]);
      const state = agentBehaviorSliderState(slider, DEFAULT_AGENT_BEHAVIOR);
      expect(state.index).toBe(state.defaultIndex);
      expect(state.option.label).toBe("Default");
    }
  });

  it("maps a stored level to its stop, and anything unknown to Default", () => {
    const subagents = AGENT_BEHAVIOR_SLIDERS[1]!;
    expect(
      agentBehaviorSliderState(subagents, { ...DEFAULT_AGENT_BEHAVIOR, subagents: "none" }),
    ).toMatchObject({ index: 0, defaultIndex: 2, option: { label: "None" } });
    expect(
      agentBehaviorSliderState(subagents, { ...DEFAULT_AGENT_BEHAVIOR, subagents: "high" }),
    ).toMatchObject({ index: 3, option: { label: "High", hint: "Uses more usage" } });
    // A level written by a newer client reads as Default here, through the contract helper.
    expect(
      syncedAgentBehavior(
        new Map([
          [
            "mac",
            { settings: { agentBehavior: { ...DEFAULT_AGENT_BEHAVIOR, subagents: "most" } } },
          ],
        ]),
      ),
    ).toEqual(DEFAULT_AGENT_BEHAVIOR);
  });

  it("summarizes the levels that differ from Default for the Settings row", () => {
    expect(agentBehaviorSummary(DEFAULT_AGENT_BEHAVIOR)).toBe("Default");
    expect(
      agentBehaviorSummary({ ...DEFAULT_AGENT_BEHAVIOR, tokens: "high", subagents: "low" }),
    ).toBe("High tokens · Subagents low");
    expect(
      agentBehaviorSummary({
        tokens: "low",
        subagents: "none",
        questions: "fewer",
        verification: "thorough",
        replies: "short",
      }),
    ).toBe("Low tokens · No subagents · Fewer questions · Thorough checks · Short replies");
  });

  it("writes one level on the Mac, all five from the phone, and the full default on reset", () => {
    expect(decodePatch(agentBehaviorPatch("tokens", "high"))).toEqual({
      agentBehavior: { tokens: "high" },
    });
    const shown = { ...DEFAULT_AGENT_BEHAVIOR, tokens: "high" as const };
    expect(decodePatch(agentBehaviorSyncPatch(shown, "replies", "short"))).toEqual({
      agentBehavior: { ...DEFAULT_AGENT_BEHAVIOR, tokens: "high", replies: "short" },
    });
    expect(decodePatch(AGENT_BEHAVIOR_RESET_PATCH)).toEqual({
      agentBehavior: {
        tokens: "default",
        subagents: "default",
        questions: "default",
        verification: "default",
        replies: "default",
      },
    });
  });

  it("shows the most recent choice when servers disagree", () => {
    const mac = {
      settings: {
        agentBehavior: { ...DEFAULT_AGENT_BEHAVIOR, tokens: "high" },
        agentBehaviorChangedAt: 20,
      },
    };
    const stale = {
      settings: {
        agentBehavior: { ...DEFAULT_AGENT_BEHAVIOR, replies: "short" },
        agentBehaviorChangedAt: 10,
      },
    };
    const untouched = { settings: { agentBehavior: DEFAULT_AGENT_BEHAVIOR } };
    expect(syncedAgentBehavior(new Map())).toBeNull();
    expect(syncedAgentBehavior(new Map([["other", untouched]]))).toEqual(DEFAULT_AGENT_BEHAVIOR);
    type Config =
      Parameters<typeof syncedAgentBehavior>[0] extends ReadonlyMap<string, infer V> ? V : never;
    const orders: ReadonlyArray<ReadonlyArray<readonly [string, Config]>> = [
      [
        ["stale", stale],
        ["mac", mac],
        ["other", untouched],
      ],
      [
        ["other", untouched],
        ["mac", mac],
        ["stale", stale],
      ],
    ];
    for (const order of orders) {
      expect(syncedAgentBehavior(new Map(order))).toEqual({
        ...DEFAULT_AGENT_BEHAVIOR,
        tokens: "high",
      });
    }
  });

  it("shows the phone the choice on machines it can write to, never an offline machine's", () => {
    const machine = (
      environmentId: string,
      phase: "connected" | "offline",
      subagents: AgentBehaviorLevels["subagents"],
      agentBehaviorChangedAt: number,
      threadAutoSettlement = true,
    ) => ({
      environmentId,
      connection: { phase },
      serverConfig: {
        environment: { capabilities: { threadAutoSettlement } },
        settings: {
          agentBehavior: { ...DEFAULT_AGENT_BEHAVIOR, subagents },
          agentBehaviorChangedAt,
        },
      },
    });
    const laptop = machine("laptop", "connected", "low", 10);
    const offline = machine("offline", "offline", "none", 20);
    const oldServer = machine("old", "connected", "high", 30, false);

    const { targets, levels } = agentBehaviorOnMachines([offline, laptop, oldServer]);
    expect(targets).toEqual([laptop]);
    expect(levels.subagents).toBe("low");
    expect(agentBehaviorOnMachines([offline]).levels).toEqual(DEFAULT_AGENT_BEHAVIOR);
  });

  it("turns every chat's Subagents switch off only at None", () => {
    expect(subagentsOffInSettings(null)).toBe(false);
    for (const level of AGENT_SUBAGENT_LEVELS) {
      expect(
        subagentsOffInSettings({ agentBehavior: { ...DEFAULT_AGENT_BEHAVIOR, subagents: level } }),
      ).toBe(level === "none");
    }
  });
});

describe("Token use cost line", () => {
  it("shows nothing until a level has a measured number", () => {
    for (const level of AGENT_TOKEN_LEVELS) {
      expect(agentTokenCostLine(level, { codex: 3 }, {})).toBeNull();
      // The shipped table only names levels it measured, and shows nothing while hidden.
      expect(agentTokenCostLine(level, {}) === null).toBe(
        !AGENT_TOKEN_ESTIMATES_SHOWN ||
          Object.keys(AGENT_TOKEN_ESTIMATES[level] ?? {}).length === 0,
      );
    }
  });

  it("appears once entries exist, naming the harness with the most chats this week", () => {
    const measured = (tokensPct: number, usagePct: number, runs = 6) => ({
      tokensPct,
      usagePct,
      measuredAt: "2026-11-26",
      runs,
    });
    const estimates = {
      high: {
        claudeCode: measured(38, 25, 15),
        codex: measured(9, 4.6, 6),
        grok: measured(20, 14, 8),
      },
      low: { codex: measured(-8, -22, 6), antigravity: measured(15, 10, 6) },
    };
    const nowMs = Date.parse("2026-11-26T20:00:00Z");
    const chats = weeklyChatsByHarness(
      [
        { harness: agentTokenHarness("codex"), activeAt: "2026-11-25T12:00:00Z" },
        { harness: agentTokenHarness("codex"), activeAt: "2026-11-24T12:00:00Z" },
        { harness: agentTokenHarness("claudeAgent"), activeAt: "2026-11-26T12:00:00Z" },
        // Older than a week, or a harness without numbers, never counts.
        { harness: agentTokenHarness("claudeAgent"), activeAt: "2026-11-10T12:00:00Z" },
        { harness: agentTokenHarness("claudeAgent"), activeAt: "2026-11-01T12:00:00Z" },
        { harness: agentTokenHarness("cursor"), activeAt: "2026-11-26T12:00:00Z" },
      ],
      nowMs,
    );
    expect(chats).toEqual({ codex: 2, claudeCode: 1 });

    // Both within ±10% collapses to "About the same as <harness> alone".
    const high = agentTokenCostLine("high", chats, estimates);
    expect(high?.shown).toMatchObject({
      harness: "codex",
      label: "Codex",
      tokens: "about the same",
      usage: "about the same",
      summary: "About the same as Codex alone",
      measuredLabel: "6 runs · 2026-11-26",
    });
    expect(high?.rows.map((row) => `${row.label} | ${row.summary} | ${row.measuredLabel}`)).toEqual(
      [
        "Claude Code | About +38% tokens vs Claude Code alone · about +25% of plan usage | 15 runs · 2026-11-26",
        "Codex | About the same as Codex alone | 6 runs · 2026-11-26",
        "Grok | About +20% tokens vs Grok alone · about +14% of plan usage | 8 runs · 2026-11-26",
      ],
    );
    // With no chats this week the first measured harness is named.
    expect(agentTokenCostLine("high", {}, estimates)?.shown.harness).toBe("claudeCode");

    // Clearly negative usage reads "about 22% less plan usage", while ±10% tokens reads "about the same".
    const low = agentTokenCostLine("low", chats, estimates);
    expect(low?.shown).toMatchObject({
      tokens: "about the same",
      usage: "22% less",
      summary: "About the same tokens vs Codex alone · about 22% less plan usage",
      measuredLabel: "6 runs · 2026-11-26",
    });
    // Positive tokens (>10%) with usage within ±10% reads "about the same plan usage".
    expect(low?.rows[1]).toMatchObject({
      label: "Antigravity",
      tokens: "+15%",
      usage: "about the same",
      summary: "About +15% tokens vs Antigravity alone · about the same plan usage",
    });
    expect(agentTokenCostLine("default", chats, estimates)).toBeNull();
  });

  it("names Devin only for its registry agent", () => {
    expect(agentTokenHarness("acpRegistry", "devin")).toBe("devin");
    expect(agentTokenHarness("acpRegistry", "kimi")).toBeNull();
    expect(agentTokenHarness("antigravity")).toBe("antigravity");
    expect(agentTokenHarness(undefined)).toBeNull();
  });
});
