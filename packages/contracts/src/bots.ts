import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * Bots: personal agents the user talks to in plain English. Each bot has a home chat it
 * runs from, a short memory and the chats it watches. Off by default; while off nothing
 * about bots reaches any agent and the server does no bot work.
 */

/** Avatar colors, from the app's accent family. Read through `botColor`. */
export const BOT_COLORS = [
  "blue",
  "indigo",
  "violet",
  "pink",
  "red",
  "orange",
  "green",
  "teal",
] as const;
export type BotColor = (typeof BOT_COLORS)[number];

/** Names a new bot is offered, skipping ones already used. */
export const BOT_NAME_SUGGESTIONS = ["Pip", "Juno", "Kit", "Ivy", "Rio", "Otto"] as const;

export const BOT_NAME_MAX = 24;
export const BOT_PERSONALITY_MAX = 500;
export const BOT_MEMORY_ENTRY_MAX = 300;
/** The newest memory a turn sees. */
export const BOT_MEMORY_PROMPT_CHARS = 1_500;
export const BOT_MESSAGE_MAX = 600;
export const BOT_WATCH_MAX = 20;
export const BOT_SEND_NOTE_MAX = 600;

/** What a chat event can wake a bot for. */
export const BOT_WATCH_EVENTS = ["finished", "failed", "question", "message"] as const;
export type BotWatchEvent = (typeof BOT_WATCH_EVENTS)[number];

const flag = (value: boolean) =>
  Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(value)));

export const BotPermissions = Schema.Struct({
  /** Start, message, rename and tidy up (settle) chats for the user. */
  manageChats: flag(true),
  /** Answer other chats' questions without asking the user. */
  answerQuestions: flag(false),
  /** Hand work to other models. */
  startSubagents: flag(true),
  /** Notify the user's phone when it has something to say. */
  messageFirst: flag(true),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type BotPermissions = typeof BotPermissions.Type;

export const DEFAULT_BOT_PERMISSIONS: BotPermissions = {
  manageChats: true,
  answerQuestions: false,
  startSubagents: true,
  messageFirst: true,
};

export const Bot = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  /** One of `BOT_COLORS`; anything else reads as the first. */
  color: Schema.String,
  /** The model the home chat started on. */
  target: ModelSelection,
  personality: Schema.optionalKey(Schema.String),
  permissions: BotPermissions,
  /** The bot's home chat. Clients leave it out of chat lists, search and counts. */
  threadId: ThreadId,
  paused: Schema.optionalKey(Schema.Boolean),
  createdAt: Schema.String,
});
export type Bot = typeof Bot.Type;

export const BotsSettings = Schema.Struct({
  enabled: flag(false),
  list: Schema.Array(Bot).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
}).pipe(Schema.withDecodingDefault(Effect.succeed({})));
export type BotsSettings = typeof BotsSettings.Type;

export function botColor(value: string | undefined): BotColor {
  return BOT_COLORS.find((color) => color === value) ?? BOT_COLORS[0];
}

export interface BotsView {
  readonly enabled: boolean;
  readonly list: ReadonlyArray<Bot>;
  /** On with at least one bot: the only state in which bots cost anything. */
  readonly active: boolean;
}

const OFF: BotsView = { enabled: false, list: [], active: false };

/** Settings > Bots as clients and the server read it. Off unless explicitly turned on. */
export function botsSettings(
  settings: { readonly bots?: Partial<BotsSettings> | undefined } | null | undefined,
): BotsView {
  const bots = settings?.bots;
  if (bots?.enabled !== true) return { ...OFF, list: bots?.list ?? [] };
  const list = bots.list ?? [];
  return { enabled: true, list, active: list.length > 0 };
}

/** A bot whose home chat is this thread, when bots are on. */
export function botForThread(view: BotsView, threadId: string | null | undefined): Bot | undefined {
  if (!view.active || threadId == null) return undefined;
  return view.list.find((bot) => bot.threadId === threadId);
}

/**
 * Every bot home chat, for leaving them out of chat lists. Includes bots kept while Bots
 * are off: their chats stay hidden and come back with their memory when turned on again.
 */
export function botThreadIds(view: BotsView): ReadonlySet<string> {
  return new Set(view.list.map((bot) => bot.threadId));
}

export const BotMemoryEntry = Schema.Struct({
  id: Schema.String,
  /** The day it was written, YYYY-MM-DD. */
  at: Schema.String,
  text: Schema.String,
});
export type BotMemoryEntry = typeof BotMemoryEntry.Type;

export const BotWatch = Schema.Struct({
  threadId: ThreadId,
  events: Schema.Array(Schema.String),
  until: Schema.optionalKey(Schema.String),
});
export type BotWatch = typeof BotWatch.Type;

/** What the server knows about one bot beyond its settings. */
export const BotRuntimeState = Schema.Struct({
  botId: Schema.String,
  memory: Schema.Array(BotMemoryEntry),
  watching: Schema.Array(BotWatch),
  /** Updates held while the bot is paused. */
  waiting: Schema.Int,
});
export type BotRuntimeState = typeof BotRuntimeState.Type;

export const BotsState = Schema.Struct({
  bots: Schema.Array(BotRuntimeState),
});
export type BotsState = typeof BotsState.Type;

const BotPermissionsPatch = Schema.Struct({
  manageChats: Schema.optionalKey(Schema.Boolean),
  answerQuestions: Schema.optionalKey(Schema.Boolean),
  startSubagents: Schema.optionalKey(Schema.Boolean),
  messageFirst: Schema.optionalKey(Schema.Boolean),
});

export const BotOperation = Schema.Union([
  /** Makes the bot's folder and home chat, then saves it. */
  Schema.Struct({
    type: Schema.Literal("create"),
    name: Schema.String,
    color: Schema.String,
    target: ModelSelection,
    personality: Schema.optionalKey(Schema.String),
    permissions: Schema.optionalKey(BotPermissionsPatch),
  }),
  Schema.Struct({
    type: Schema.Literal("update"),
    botId: Schema.String,
    name: Schema.optionalKey(Schema.String),
    color: Schema.optionalKey(Schema.String),
    target: Schema.optionalKey(ModelSelection),
    personality: Schema.optionalKey(Schema.String),
    permissions: Schema.optionalKey(BotPermissionsPatch),
  }),
  /** Paused bots hold their updates; resuming delivers them as one note. */
  Schema.Struct({ type: Schema.Literal("pause"), botId: Schema.String, paused: Schema.Boolean }),
  /** Removes the bot, its home chat and its folder. */
  Schema.Struct({ type: Schema.Literal("delete"), botId: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("memory"),
    botId: Schema.String,
    add: Schema.optionalKey(Schema.String),
    replace: Schema.optionalKey(Schema.Struct({ id: Schema.String, text: Schema.String })),
    remove: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    type: Schema.Literal("unwatch"),
    botId: Schema.String,
    threadIds: Schema.Array(ThreadId),
  }),
  /** "Send to <bot>…" from a chat's menu: the chat's link and an optional note. */
  Schema.Struct({
    type: Schema.Literal("send"),
    botId: Schema.String,
    threadId: ThreadId,
    note: Schema.optionalKey(Schema.String),
  }),
]);
export type BotOperation = typeof BotOperation.Type;

export const BotOperationResult = Schema.Struct({
  bot: Schema.optionalKey(Bot),
});
export type BotOperationResult = typeof BotOperationResult.Type;

export class BotsError extends Schema.TaggedError<BotsError>()("BotsError", {
  reason: Schema.Literals(["off", "notFound", "invalid", "write", "unavailable"]),
  message: Schema.String,
}) {}
