import { BOT_WATCH_EVENTS, type BotMemoryEntry, type BotWatch } from "@t3tools/contracts";
import type { BotWakeItem } from "@t3tools/shared/bots";
import * as Schema from "effect/Schema";

/**
 * A bot's folder, `<userdata>/bots/<id>/`: `memory.md`, dated notes the user can also read
 * and edit by hand, and `watches.json`, the chats it watches plus updates not yet delivered.
 */
export const MEMORY_FILE = "memory.md";
export const WATCHES_FILE = "watches.json";
/** Oldest entries go first once a bot keeps this many. */
export const MEMORY_MAX_ENTRIES = 200;

const MEMORY_HEADER = "# Memory\n\nNotes your bot keeps. Each line: - [id] date: note\n";
const MEMORY_LINE = /^- \[(?<id>[A-Za-z0-9_-]{1,32})\] (?<at>\d{4}-\d{2}-\d{2}): (?<text>.+)$/u;

export function parseMemory(text: string): ReadonlyArray<BotMemoryEntry> {
  const entries: BotMemoryEntry[] = [];
  for (const line of text.split("\n")) {
    const groups = MEMORY_LINE.exec(line.trim())?.groups;
    if (groups) entries.push({ id: groups.id!, at: groups.at!, text: groups.text!.trim() });
  }
  return entries;
}

export function formatMemory(entries: ReadonlyArray<BotMemoryEntry>): string {
  return [
    MEMORY_HEADER,
    ...entries.map((entry) => `- [${entry.id}] ${entry.at}: ${entry.text}`),
    "",
  ].join("\n");
}

const WatchEvent = Schema.Literals(BOT_WATCH_EVENTS);
const StoredWatch = Schema.Struct({
  threadId: Schema.String,
  events: Schema.Array(WatchEvent),
  until: Schema.optionalKey(Schema.String),
});
const StoredItem = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("event"),
    threadId: Schema.String,
    title: Schema.String,
    event: WatchEvent,
    count: Schema.optionalKey(Schema.Number),
    detail: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("message"),
    threadId: Schema.String,
    title: Schema.String,
    text: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("routine"), text: Schema.String }),
]);
const StoredWatches = Schema.Struct({
  version: Schema.Literal(1),
  watches: Schema.Array(StoredWatch),
  /** Updates not delivered yet: waiting out the batch window, or held while paused. */
  held: Schema.Array(StoredItem),
});

export interface WatchFile {
  readonly watches: ReadonlyArray<BotWatch>;
  readonly held: ReadonlyArray<BotWakeItem>;
}

export const EMPTY_WATCH_FILE: WatchFile = { watches: [], held: [] };

const decodeWatches = Schema.decodeUnknownOption(Schema.fromJsonString(StoredWatches));

/** A file that can't be read starts the bot with nothing watched, rather than failing. */
export function parseWatches(text: string): WatchFile {
  const decoded = decodeWatches(text);
  if (decoded._tag === "None") return EMPTY_WATCH_FILE;
  return {
    watches: decoded.value.watches as ReadonlyArray<BotWatch>,
    held: decoded.value.held,
  };
}

export function formatWatches(file: WatchFile): string {
  return `${JSON.stringify({ version: 1, watches: file.watches, held: file.held }, null, 2)}\n`;
}
