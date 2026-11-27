/**
 * Settings > Agents: the five sliders both clients draw, their copy, and how a level is
 * written. Levels live in each server's settings. The Mac writes its own server; the phone
 * writes every server it can and shows the most recent choice.
 */
import {
  agentBehaviorLevels,
  DEFAULT_AGENT_BEHAVIOR,
  type AgentBehaviorLevels,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  AGENT_TOKEN_ESTIMATES,
  AGENT_TOKEN_ESTIMATES_SHOWN,
  type AgentTokenEstimate,
  type AgentTokenHarness,
  type AgentTokenLevel,
} from "@t3tools/shared/agentTokenEstimates";

import { supportsSharedSettingsSync } from "./sharedSettings.ts";

export type AgentBehaviorKey = keyof AgentBehaviorLevels;

interface SliderOf<K extends AgentBehaviorKey> {
  readonly key: K;
  readonly title: string;
  readonly levels: ReadonlyArray<{
    readonly level: AgentBehaviorLevels[K];
    readonly label: string;
    readonly copy: string;
    /** A short cost hint where the cost is real; only Token use shows numbers. */
    readonly hint?: string;
  }>;
}

export type AgentBehaviorSlider = { [K in AgentBehaviorKey]: SliderOf<K> }[AgentBehaviorKey];
export type AgentBehaviorLevelOption = AgentBehaviorSlider["levels"][number];

export const AGENT_BEHAVIOR_TITLE = "Agents";
export const AGENT_BEHAVIOR_NOTE =
  "How agents work in every chat. Changes apply to new turns and sync to all your devices.";
export const AGENT_BEHAVIOR_RESET_LABEL = "Reset all to Default";
/** Shown on a chat's Subagents switch while the Subagents level is None. */
export const SUBAGENTS_OFF_IN_SETTINGS = "Off in Settings › Agents";

const USES_MORE = "Uses more usage";

export const AGENT_BEHAVIOR_SLIDERS: ReadonlyArray<AgentBehaviorSlider> = [
  {
    key: "tokens",
    title: "Token use",
    levels: [
      {
        level: "low",
        label: "Low",
        copy: "Closest to the native app. SSHCode's extra tools load only when an agent needs them, and its instructions are trimmed. Chats, subagents, cards, the phone and limits all still work.",
      },
      { level: "default", label: "Default", copy: "SSHCode as it is today." },
      {
        level: "high",
        label: "High",
        copy: "Live progress: each working agent shows its stages, time left and short updates. Agents spend a little more to report them.",
      },
    ],
  },
  {
    key: "subagents",
    title: "Subagents",
    levels: [
      {
        level: "none",
        label: "None",
        copy: "Agents do all the work themselves: no subagents of any kind and no councils.",
      },
      {
        level: "low",
        label: "Low",
        copy: "Only when you ask, when an agent lacks a needed capability, or when its quota runs out.",
      },
      { level: "default", label: "Default", copy: "Agents decide, as today." },
      {
        level: "high",
        label: "High",
        copy: "Agents split more work across other models and get more second opinions, for the best result. Uses more of your other plans.",
        hint: USES_MORE,
      },
    ],
  },
  {
    key: "questions",
    title: "Questions",
    levels: [
      {
        level: "fewer",
        label: "Fewer",
        copy: "Agents decide on their own and ask only before spending money, deleting work or changing direction.",
      },
      { level: "default", label: "Default", copy: "As today." },
      {
        level: "more",
        label: "More",
        copy: "Agents check with you before big or ambiguous choices.",
      },
    ],
  },
  {
    key: "verification",
    title: "Checking work",
    levels: [
      {
        level: "light",
        label: "Light",
        copy: "Quick checks: typecheck and the tests that changed.",
      },
      { level: "default", label: "Default", copy: "As today." },
      {
        level: "thorough",
        label: "Thorough",
        copy: "Full test runs, a look at the real screen or output, and a second model's review before big work is called done. Takes longer.",
        hint: USES_MORE,
      },
    ],
  },
  {
    key: "replies",
    title: "Replies",
    levels: [
      {
        level: "short",
        label: "Short",
        copy: "A few lines: what changed and anything you need to do.",
      },
      { level: "default", label: "Default", copy: "As today." },
      {
        level: "detailed",
        label: "Detailed",
        copy: "Fuller explanations with the reasoning and evidence.",
      },
    ],
  },
];

/** Where a slider sits: its stops, the current one, and Default's, for the marker above it. */
export function agentBehaviorSliderState(slider: AgentBehaviorSlider, levels: AgentBehaviorLevels) {
  const current = levels[slider.key];
  const options: ReadonlyArray<AgentBehaviorLevelOption> = slider.levels;
  const index = Math.max(
    0,
    options.findIndex((option) => option.level === current),
  );
  return {
    options,
    index,
    option: options[index]!,
    defaultIndex: options.findIndex((option) => option.level === "default"),
  };
}

const SUMMARY_LABELS: { readonly [K in AgentBehaviorKey]: (label: string) => string } = {
  tokens: (label) => `${label} tokens`,
  subagents: (label) => (label === "None" ? "No subagents" : `Subagents ${label.toLowerCase()}`),
  questions: (label) => `${label} questions`,
  verification: (label) => `${label} checks`,
  replies: (label) => `${label} replies`,
};

/** The Settings row's subtitle: the levels that differ from Default, or "Default". */
export function agentBehaviorSummary(levels: AgentBehaviorLevels): string {
  const changed = AGENT_BEHAVIOR_SLIDERS.flatMap((slider) => {
    const { option } = agentBehaviorSliderState(slider, levels);
    return option.level === "default" ? [] : [SUMMARY_LABELS[slider.key](option.label)];
  });
  return changed.length === 0 ? "Default" : changed.join(" · ");
}

/** One level for one server: patches deep-merge, so the other levels keep their stored value. */
export function agentBehaviorPatch<K extends AgentBehaviorKey>(
  key: K,
  level: AgentBehaviorLevels[K],
): ServerSettingsPatch {
  return { agentBehavior: { [key]: level } };
}

/** The levels with one changed. */
export function withAgentBehaviorLevel<K extends AgentBehaviorKey>(
  levels: AgentBehaviorLevels,
  key: K,
  level: AgentBehaviorLevels[K],
): AgentBehaviorLevels {
  return { ...levels, [key]: level };
}

/**
 * The phone's write to every server: all five levels as it shows them, so servers that had
 * drifted apart agree again after any change made on the phone.
 */
export function agentBehaviorLevelsPatch(levels: AgentBehaviorLevels): ServerSettingsPatch {
  return { agentBehavior: { ...levels } };
}

export function agentBehaviorSyncPatch<K extends AgentBehaviorKey>(
  shown: AgentBehaviorLevels,
  key: K,
  level: AgentBehaviorLevels[K],
): ServerSettingsPatch {
  return agentBehaviorLevelsPatch(withAgentBehaviorLevel(shown, key, level));
}

export const AGENT_BEHAVIOR_RESET_PATCH = agentBehaviorLevelsPatch(DEFAULT_AGENT_BEHAVIOR);

/** The most recent choice across servers; null before any server's settings load. */
export function syncedAgentBehavior(
  configs: ReadonlyMap<
    string,
    { readonly settings: Pick<ServerSettings, "agentBehavior" | "agentBehaviorChangedAt"> }
  >,
): AgentBehaviorLevels | null {
  let latest: Pick<ServerSettings, "agentBehavior"> | null = null;
  let latestAt = -1;
  for (const { settings } of configs.values()) {
    const changedAt = settings.agentBehaviorChangedAt ?? 0;
    if (changedAt > latestAt) {
      latest = settings;
      latestAt = changedAt;
    }
  }
  return latest === null ? null : agentBehaviorLevels(latest.agentBehavior);
}

/**
 * What the phone shows and writes to: the connected machines that sync settings, and the most
 * recent choice among them. An offline machine's newer choice is in force nowhere the phone can
 * reach, so it never shows.
 */
export function agentBehaviorOnMachines<
  T extends Parameters<typeof supportsSharedSettingsSync>[0] & {
    readonly environmentId: string;
    readonly serverConfig: {
      readonly settings: Pick<ServerSettings, "agentBehavior" | "agentBehaviorChangedAt">;
    } | null;
  },
>(environments: ReadonlyArray<T>): { readonly targets: T[]; readonly levels: AgentBehaviorLevels } {
  const targets = environments.filter(supportsSharedSettingsSync);
  const configs = new Map(
    targets.flatMap((target) =>
      target.serverConfig === null ? [] : [[target.environmentId, target.serverConfig] as const],
    ),
  );
  return { targets, levels: syncedAgentBehavior(configs) ?? DEFAULT_AGENT_BEHAVIOR };
}

/** True while this server's Subagents level is None, which turns every chat's switch off. */
export function subagentsOffInSettings(
  settings: Pick<ServerSettings, "agentBehavior"> | null | undefined,
): boolean {
  return agentBehaviorLevels(settings?.agentBehavior).subagents === "none";
}

export const AGENT_TOKEN_HARNESS_LABELS: { readonly [H in AgentTokenHarness]: string } = {
  claudeCode: "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  grok: "Grok",
  devin: "Devin",
  opencode: "OpenCode",
};

const HARNESS_ORDER = Object.keys(AGENT_TOKEN_HARNESS_LABELS) as ReadonlyArray<AgentTokenHarness>;

/** The harness a provider instance runs, as the estimates name it; null for others. */
export function agentTokenHarness(
  driver: string | null | undefined,
  agentId?: string | null,
): AgentTokenHarness | null {
  switch (driver) {
    case "claudeAgent":
      return "claudeCode";
    case "codex":
    case "antigravity":
    case "grok":
    case "opencode":
      return driver;
    case "acpRegistry":
      return agentId?.trim() === "devin" ? "devin" : null;
    default:
      return null;
  }
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Chats active in the last seven days, per harness: the cost line names the busiest one. */
export function weeklyChatsByHarness(
  chats: Iterable<{ readonly harness: AgentTokenHarness | null; readonly activeAt: string | null }>,
  nowMs: number,
): Partial<Record<AgentTokenHarness, number>> {
  const counts: Partial<Record<AgentTokenHarness, number>> = {};
  for (const chat of chats) {
    if (chat.harness === null || chat.activeAt === null) continue;
    const at = Date.parse(chat.activeAt);
    if (!Number.isFinite(at) || nowMs - at > WEEK_MS) continue;
    counts[chat.harness] = (counts[chat.harness] ?? 0) + 1;
  }
  return counts;
}

const SAME_THRESHOLD_PCT = 10;

export interface AgentTokenCostRow {
  readonly harness: AgentTokenHarness;
  readonly label: string;
  /** Compact table display for tokens: "+38%", "22% less", or "about the same". */
  readonly tokens: string;
  /** Compact table display for plan usage: "+25%", "22% less", or "about the same". */
  readonly usage: string;
  /** Sentence prefix before the interactive harness name. */
  readonly lineBeforeHarness: string;
  /** Sentence suffix after the interactive harness name. */
  readonly lineAfterHarness: string;
  /** Full plain-text cost line. */
  readonly summary: string;
  /** Sample count and measured date for the hover/table. */
  readonly measuredLabel: string;
  readonly runs: number;
  readonly measuredAt: string;
}

function isAboutSame(value: number): boolean {
  return Math.abs(Math.round(value)) <= SAME_THRESHOLD_PCT;
}

function formatCellPercent(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) <= SAME_THRESHOLD_PCT) return "about the same";
  return rounded < 0 ? `${Math.abs(rounded)}% less` : `+${rounded}%`;
}

function formatTokensLead(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) <= SAME_THRESHOLD_PCT) return "About the same tokens vs ";
  return rounded < 0
    ? `About ${Math.abs(rounded)}% less tokens vs `
    : `About +${rounded}% tokens vs `;
}

function formatUsageClause(value: number): string {
  const rounded = Math.round(value);
  if (Math.abs(rounded) <= SAME_THRESHOLD_PCT) return "about the same plan usage";
  return rounded < 0
    ? `about ${Math.abs(rounded)}% less plan usage`
    : `about +${rounded}% of plan usage`;
}

function costRow(harness: AgentTokenHarness, estimate: AgentTokenEstimate): AgentTokenCostRow {
  const label = AGENT_TOKEN_HARNESS_LABELS[harness];
  const bothSame = isAboutSame(estimate.tokensPct) && isAboutSame(estimate.usagePct);
  const lineBeforeHarness = bothSame ? "About the same as " : formatTokensLead(estimate.tokensPct);
  const lineAfterHarness = bothSame ? " alone" : ` alone · ${formatUsageClause(estimate.usagePct)}`;
  const runsText = estimate.runs === 1 ? "1 run" : `${estimate.runs} runs`;
  return {
    harness,
    label,
    tokens: formatCellPercent(estimate.tokensPct),
    usage: formatCellPercent(estimate.usagePct),
    lineBeforeHarness,
    lineAfterHarness,
    summary: `${lineBeforeHarness}${label}${lineAfterHarness}`,
    measuredLabel: `${runsText} · ${estimate.measuredAt}`,
    runs: estimate.runs,
    measuredAt: estimate.measuredAt,
  };
}

export interface AgentTokenCostLine {
  /** The harness named in the line: the one with the most chats this week that has a number. */
  readonly shown: AgentTokenCostRow;
  /** Every measured harness, for the table behind "vs <harness>". */
  readonly rows: ReadonlyArray<AgentTokenCostRow>;
}

/**
 * Token use's cost line for one level, rounding anything within ±10% to "about the same"
 * so small-sample noise never displays as a precise claim. Null when nothing was measured
 * for the level, so no line and no placeholder.
 */
export function agentTokenCostLine(
  level: AgentTokenLevel,
  chatsByHarness: Partial<Record<AgentTokenHarness, number>>,
  estimates: typeof AGENT_TOKEN_ESTIMATES = AGENT_TOKEN_ESTIMATES_SHOWN
    ? AGENT_TOKEN_ESTIMATES
    : {},
): AgentTokenCostLine | null {
  const measured = estimates[level];
  const rows = HARNESS_ORDER.flatMap((harness) => {
    const estimate = measured?.[harness];
    return estimate ? [costRow(harness, estimate)] : [];
  });
  let shown = rows[0];
  if (shown === undefined) return null;
  for (const row of rows) {
    if ((chatsByHarness[row.harness] ?? 0) > (chatsByHarness[shown.harness] ?? 0)) shown = row;
  }
  return { shown, rows };
}
