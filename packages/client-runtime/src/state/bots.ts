/**
 * Bots: what the Mac and the phone both draw. Copy, the avatar's palette and geometry, the
 * one-line status under a bot's name, and the quiet label a bot turn's tool activity folds
 * into. Bots live in each server's settings; their memory and watches come from
 * `bots.subscribe`, which clients open only while bots are on.
 */
import {
  BOT_COLORS,
  BOT_NAME_MAX,
  BOT_NAME_SUGGESTIONS,
  botColor,
  botsSettings,
  botThreadIds,
  type EnvironmentId,
  type Bot,
  type BotColor,
  type BotPermissions,
  type BotRuntimeState,
  type BotWatchEvent,
  type BotsView,
  type ServerConfig,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { parseBotSend, parseBotWake, type BotWakeItem } from "@t3tools/shared/bots";
import { formatDayShort } from "@t3tools/shared/usageFormat";
import { resolveT3McpToolId } from "@t3tools/shared/t3McpToolPresentation";
import { Atom } from "effect/reactivity";

import type { ThreadSearchResultsState } from "./threadSearch.ts";

export const BOTS_TITLE = "Bots";
export const BOTS_NOTE =
  "Personal agents you talk to in plain English. A bot can start, check and tidy your chats, and your chats can message it. Off by default. Uses no tokens while off.";
export const NEW_BOT_LABEL = "New bot";
export const CREATE_BOT_LABEL = "Create";
export const BOT_PERSONALITY_PLACEHOLDER = "Friendly and to the point";
export const BOT_STARTERS = [
  "What's running right now?",
  "Tidy up finished chats",
  "Every morning, tell me what happened",
] as const;

export const botGreeting = (name: string) => `Hi, I'm ${name}.`;
export const botComposerPlaceholder = (name: string) => `Message ${name}`;
/** Stands in for the composer of a bot chat opened while Bots are off. */
export const botsOffNote = (name: string) => `Bots are off. Turn them on to talk to ${name}.`;
export const BOTS_OFF_SETTINGS_LABEL = "Open Settings";
export const sendToBotLabel = (name: string) => `Send to ${name}…`;
export const deleteBotConfirm = (name: string) =>
  `Delete ${name}? Its chat, memory and routines are removed. Your other chats stay.`;

export const BOT_PERMISSION_ROWS: ReadonlyArray<{
  readonly key: keyof BotPermissions;
  readonly title: string;
  readonly copy: string;
}> = [
  {
    key: "manageChats",
    title: "Manage chats",
    copy: "Start, message, rename and tidy up chats for you",
  },
  {
    key: "answerQuestions",
    title: "Answer questions",
    copy: "Answer other chats' questions without asking you",
  },
  {
    key: "startSubagents",
    title: "Use subagents",
    copy: "Hand work to other models when it helps",
  },
];

/** Info panel section titles, in order. */
export const BOT_INFO_SECTIONS = {
  memory: "Memory",
  watching: "Watching",
  routines: "Routines",
  permissions: "Permissions",
  model: "Model",
} as const;
export const BOT_MEMORY_EMPTY = "Nothing yet. Tell your bot something to remember.";
export const BOT_WATCHING_EMPTY = "Not watching any chats.";
export const BOT_ROUTINES_EMPTY = 'None yet. Try "Every morning at 9, tell me what happened."';

/**
 * Avatar fills, from the app's accent family. White eyes keep at least 3:1 against every
 * fill, measured at the top of the eyes where the gradient is lightest; each fill also keeps
 * 3.5:1 against both the light and the dark app background.
 */
export const BOT_PALETTE: Readonly<
  Record<BotColor, { readonly fill: string; readonly top: string }>
> = {
  blue: { fill: "#3b82f6", top: "#5391f7" },
  indigo: { fill: "#6366f1", top: "#7678f3" },
  violet: { fill: "#8b5cf6", top: "#9970f7" },
  pink: { fill: "#ec4899", top: "#ee5ea5" },
  red: { fill: "#ef4444", top: "#f15a5a" },
  orange: { fill: "#ea580c", top: "#ed6c29" },
  green: { fill: "#15994a", top: "#31a560" },
  teal: { fill: "#0d9488", top: "#2aa196" },
};
export const BOT_COLOR_KEYS: ReadonlyArray<BotColor> = BOT_COLORS;
/** The "needs you" dot, the sidebar's waiting amber. */
export const BOT_NEEDS_YOU_COLOR = "#f59e0b";

export const botPalette = (color: string | undefined) => BOT_PALETTE[botColor(color)];

/**
 * The face, as fractions of the avatar's diameter: two rounded white eyes centered at 36% and
 * 64% across and 46% down, and a faint highlight up and to the left. No mouth.
 */
export const BOT_AVATAR_GEOMETRY = {
  eyeWidth: 0.14,
  eyeHeight: 0.22,
  eyeCenterY: 0.46,
  eyeCentersX: [0.36, 0.64],
  /** Corner radius; half the width makes a soft pill. */
  eyeRadius: 0.07,
  highlight: { cx: 0.33, cy: 0.27, rx: 0.22, ry: 0.14, opacity: 0.22 },
  /** Gaze shifts while working and when it needs the user, as fractions of the diameter. */
  glanceX: 0.05,
  lookUpY: -0.06,
  /** The "needs you" dot: diameter and center. */
  needsYouDot: { size: 0.3, cx: 0.85, cy: 0.15 },
} as const;
export const BOT_AVATAR_MOTION = {
  blinkEveryMs: 6_000,
  blinkMs: 120,
  blinkScaleY: 0.1,
  /** One left-right glance cycle while working. */
  glanceMs: 2_400,
} as const;

/** The first suggested name not in use, else the first with a number. */
export function nextBotName(list: ReadonlyArray<Pick<Bot, "name">>): string {
  const used = new Set(list.map((bot) => bot.name.trim().toLowerCase()));
  const free = BOT_NAME_SUGGESTIONS.find((name) => !used.has(name.toLowerCase()));
  if (free) return free;
  for (let n = 2; ; n++) {
    const name = `${BOT_NAME_SUGGESTIONS[0]} ${n}`;
    if (!used.has(name.toLowerCase())) return name;
  }
}

export function cleanBotName(name: string): string {
  return name.replace(/\s+/gu, " ").trim().slice(0, BOT_NAME_MAX);
}

/** A color the list doesn't use yet, so a second bot looks different from the first. */
export function nextBotColor(list: ReadonlyArray<Pick<Bot, "color">>): BotColor {
  const used = new Set(list.map((bot) => botColor(bot.color)));
  return (
    BOT_COLORS.find((color) => !used.has(color)) ?? BOT_COLORS[list.length % BOT_COLORS.length]!
  );
}

export type BotStatusKind = "paused" | "needsYou" | "working" | "watching" | "idle";

const plural = (count: number, one: string, many = `${one}s`) =>
  `${count} ${count === 1 ? one : many}`;

export const botWaitingLabel = (count: number) => `${plural(count, "update")} waiting`;

/**
 * The muted line under a bot's name. "Needs you" wins over working, since the bot is stuck
 * until the user answers; paused wins over everything, since nothing wakes it.
 */
export function botStatus(input: {
  readonly bot: Pick<Bot, "paused">;
  readonly runtime?: Pick<BotRuntimeState, "watching" | "waiting"> | undefined;
  /** Its home chat has a run going. */
  readonly working: boolean;
  /** Its home chat is waiting on the user's answer or approval. */
  readonly needsYou: boolean;
}): { readonly kind: BotStatusKind; readonly label: string } {
  if (input.bot.paused) {
    const waiting = input.runtime?.waiting ?? 0;
    return {
      kind: "paused",
      label: waiting > 0 ? `Paused · ${botWaitingLabel(waiting)}` : "Paused",
    };
  }
  if (input.needsYou) return { kind: "needsYou", label: "Needs you" };
  if (input.working) return { kind: "working", label: "Working…" };
  const watching = input.runtime?.watching.length ?? 0;
  if (watching > 0) return { kind: "watching", label: `Watching ${plural(watching, "chat")}` };
  return { kind: "idle", label: "Ready" };
}

/** How a tool's calls read in a bot turn's fold, in plain words. */
const ACTIVITY: Readonly<Record<string, { readonly verb: string; readonly noun: string }>> = {
  t3_thread_list: { verb: "Checked", noun: "chat list" },
  t3_thread_read: { verb: "Checked", noun: "chat" },
  t3_thread_wait: { verb: "Checked", noun: "chat" },
  t3_thread_send: { verb: "Messaged", noun: "chat" },
  t3_thread_update: { verb: "Updated", noun: "chat" },
  t3_thread_interrupt: { verb: "Stopped", noun: "chat" },
  create_threads: { verb: "Started", noun: "chat" },
  delegate_task: { verb: "Started", noun: "subagent" },
  task_status: { verb: "Checked", noun: "subagent" },
  schedule_task: { verb: "Set up", noun: "routine" },
  watch_chats: { verb: "Watched", noun: "chat" },
  unwatch_chats: { verb: "Stopped watching", noun: "chat" },
  bot_memory: { verb: "Updated", noun: "note" },
  t3_pending_request_respond: { verb: "Answered", noun: "question" },
  t3_project_list: { verb: "Checked", noun: "project list" },
};

/**
 * One quiet line for a bot turn's tool calls: "Checked 4 chats", or "Checked 4 chats,
 * messaged 1". Calls are counted, not distinct chats; tools outside the list read as steps.
 */
export function botActivityLabel(toolNames: ReadonlyArray<string>): string {
  if (toolNames.length === 0) return "";
  const counts = new Map<string, { verb: string; noun: string; count: number }>();
  let other = 0;
  for (const name of toolNames) {
    const id = resolveT3McpToolId(name) ?? name;
    const activity = ACTIVITY[id];
    if (activity === undefined) {
      other++;
      continue;
    }
    const key = `${activity.verb} ${activity.noun}`;
    const entry = counts.get(key) ?? { ...activity, count: 0 };
    entry.count++;
    counts.set(key, entry);
  }
  const parts = [...counts.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, 2)
    .map((entry) =>
      entry.noun.includes(" ") && entry.count === 1
        ? `${entry.verb} the ${entry.noun}`
        : `${entry.verb} ${plural(entry.count, entry.noun)}`,
    );
  if (parts.length === 0) return `Took ${plural(other, "step")}`;
  return parts
    .map((part, index) => (index === 0 ? part : part[0]!.toLowerCase() + part.slice(1)))
    .join(", ");
}

/** The Settings > Bots switch. The list is written by the server through `bots.mutate`. */
export function botsEnabledPatch(enabled: boolean): ServerSettingsPatch {
  return { bots: { enabled } };
}

/**
 * Servers from before Bots don't advertise them, and calling bots.* there drops the
 * connection, so clients show nothing about Bots for those servers.
 */
export function serverSupportsBots(
  serverConfig:
    | { readonly environment: { readonly capabilities: { readonly bots?: boolean } } }
    | null
    | undefined,
): boolean {
  return serverConfig?.environment.capabilities.bots === true;
}

const BOTS_OFF: BotsView = { enabled: false, list: [], active: false };

/** A server's Bots as clients show them: off for a server that doesn't run them. */
export function serverBotsView(serverConfig: ServerConfig | null | undefined): BotsView {
  return serverSupportsBots(serverConfig) ? botsSettings(serverConfig?.settings) : BOTS_OFF;
}

/**
 * The bot whose home chat this is while Bots are off (it is kept, so its chat still opens from a
 * link, a notification or the back stack). The chat reads as the bot's but takes no messages.
 */
export function parkedBotForThread(
  view: BotsView,
  threadId: string | null | undefined,
): Bot | undefined {
  if (view.active || threadId == null) return undefined;
  return view.list.find((bot) => bot.threadId === threadId);
}

const NO_BOT_THREADS: ReadonlySet<string> = new Set();

/**
 * Each server's bot home chats, for `createEnvironmentThreadShellAtoms`'s `hiddenThreadIdsAtom`:
 * bot chats keep their point reads and leave every chat list, search and count, also while
 * Bots are off. The set keeps its identity until the ids change, so lists don't rebuild on
 * unrelated settings writes.
 */
export function createBotThreadIdsAtom(
  settingsAtom: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<Parameters<typeof botsSettings>[0] | null>,
) {
  return Atom.family((environmentId: EnvironmentId) => {
    let previous = NO_BOT_THREADS;
    return Atom.make((get): ReadonlySet<string> => {
      const next = botThreadIds(botsSettings(get(settingsAtom(environmentId))));
      if (next.size === previous.size && [...next].every((id) => previous.has(id))) {
        return previous;
      }
      previous = next.size === 0 ? NO_BOT_THREADS : next;
      return previous;
    }).pipe(Atom.withLabel(`bots:thread-ids:${environmentId}`));
  });
}

/** Search results without bot home chats, keeping the same array when none were found. */
export function withoutBotThreads<
  T extends { readonly environmentId: string; readonly threadId: string },
>(
  matches: ReadonlyArray<T>,
  hiddenIds: (environmentId: T["environmentId"]) => ReadonlySet<string>,
): ReadonlyArray<T> {
  return matches.some((match) => hiddenIds(match.environmentId).has(match.threadId))
    ? matches.filter((match) => !hiddenIds(match.environmentId).has(match.threadId))
    : matches;
}

/**
 * Chat search results without bot home chats, for every surface that searches chats (lists,
 * sidebars, palettes, chat mentions): bot chats show only in the Bots area.
 */
export function createVisibleThreadSearchResultsAtomFamily(input: {
  readonly resultsAtom: (key: string) => Atom.Atom<ThreadSearchResultsState>;
  readonly hiddenThreadIdsAtom: (environmentId: EnvironmentId) => Atom.Atom<ReadonlySet<string>>;
  readonly labelPrefix: string;
}) {
  return Atom.family((key: string) =>
    Atom.make((get): ThreadSearchResultsState => {
      const result = get(input.resultsAtom(key));
      const matches = withoutBotThreads(result.matches, (environmentId) =>
        get(input.hiddenThreadIdsAtom(environmentId)),
      );
      return matches === result.matches ? result : { ...result, matches };
    }).pipe(Atom.withLabel(`${input.labelPrefix}:visible:${key}`)),
  );
}

/**
 * The card tool (`show_card`), under any MCP prefix. A bot's fold never takes its calls: the
 * card stays where the timeline draws it.
 */
export function isShowCardTool(toolName: string | null | undefined): boolean {
  if (toolName == null) return false;
  return resolveT3McpToolId(toolName) === "show_card" || /(?:^|__|[.:/])show_card$/u.test(toolName);
}

/**
 * A message in a bot's chat that came from SSHCode or another chat (a wake note, or "Send to
 * <bot>…"), as the notes to draw; null for anything the user typed.
 */
export function botInboundNote(text: string): ReadonlyArray<BotWakeItem> | null {
  const wake = parseBotWake(text);
  if (wake !== null) return wake;
  const sent = parseBotSend(text);
  return sent === null
    ? null
    : [{ kind: "message", threadId: sent.threadId, title: sent.title, text: sent.note }];
}

const BOT_WAKE_MESSAGE_PREFIX = "message:bot:";

/**
 * A bot chat's wake notes by the run each one started. A wake reaches the timeline as a
 * notification that keeps only a one-line summary; the run's message keeps the full note.
 */
export function botWakeNotesByRun(
  runs: ReadonlyArray<{ readonly id: string; readonly userMessageId: string }>,
  messages: ReadonlyArray<{ readonly id: string; readonly text: string }>,
): ReadonlyMap<string, ReadonlyArray<BotWakeItem>> {
  const notes = new Map<string, ReadonlyArray<BotWakeItem>>();
  const wakeText = new Map<string, string>();
  for (const message of messages) {
    if (message.id.startsWith(BOT_WAKE_MESSAGE_PREFIX)) wakeText.set(message.id, message.text);
  }
  if (wakeText.size === 0) return notes;
  for (const run of runs) {
    const text = wakeText.get(run.userMessageId);
    const items = text === undefined ? null : parseBotWake(text);
    if (items !== null) notes.set(run.id, items);
  }
  return notes;
}

/** How a watched chat's event reads after its title: "Phone build finished". */
export const BOT_EVENT_PHRASES: Readonly<Record<BotWatchEvent, string>> = {
  finished: "finished",
  failed: "failed",
  question: "has a question",
  message: "got a message",
};

/** A memory entry's `YYYY-MM-DD` day for people: "Nov 27", with the year once it is not this year. */
export function botMemoryDayLabel(day: string, currentYear: number): string {
  const year = Number(day.slice(0, 4));
  const label = formatDayShort(day);
  return Number.isInteger(year) && year !== currentYear ? `${label}, ${year}` : label;
}
