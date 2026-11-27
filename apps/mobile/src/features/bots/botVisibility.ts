import { serverBotsView } from "@t3tools/client-runtime/state/bots";
import { botThreadIds, type Bot, type EnvironmentId, type ServerConfig } from "@t3tools/contracts";

/** A bot and the machine whose settings hold it. */
export interface BotEntry {
  readonly environmentId: EnvironmentId;
  readonly bot: Bot;
}

/** Each machine's config. A server that doesn't advertise Bots shows none and gets no bots.* calls. */
type BotsConfigs = ReadonlyMap<EnvironmentId, ServerConfig | null>;

const threadKey = (environmentId: string, threadId: string) => `${environmentId}:${threadId}`;

/** Every bot on a machine where Bots are on, in each machine's own order. Empty while off. */
export function activeBotEntries(configs: BotsConfigs): ReadonlyArray<BotEntry> {
  const entries: BotEntry[] = [];
  for (const [environmentId, config] of configs) {
    const view = serverBotsView(config);
    if (!view.active) continue;
    for (const bot of view.list) entries.push({ environmentId, bot });
  }
  return entries;
}

/** `environmentId:threadId` keys of every bot home chat, to leave out of chat lists and counts. */
export function botThreadKeys(configs: BotsConfigs): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const [environmentId, config] of configs) {
    for (const threadId of botThreadIds(serverBotsView(config)))
      keys.add(threadKey(environmentId, threadId));
  }
  return keys;
}

export function isBotThreadKey(
  keys: ReadonlySet<string>,
  ref: { readonly environmentId: string; readonly threadId: string },
): boolean {
  return keys.size > 0 && keys.has(threadKey(ref.environmentId, ref.threadId));
}

/** Chats without bot home chats. Returns the same array when nothing is left out. */
export function withoutBotThreads<
  T extends { readonly environmentId: string; readonly id: string },
>(threads: ReadonlyArray<T>, keys: ReadonlySet<string>): ReadonlyArray<T> {
  if (keys.size === 0) return threads;
  const kept = threads.filter((thread) => !keys.has(threadKey(thread.environmentId, thread.id)));
  return kept.length === threads.length ? threads : kept;
}

/** Search hits outside bot home chats. Returns the same array when nothing is left out. */
export function withoutBotMatches<
  T extends { readonly environmentId: string; readonly threadId: string },
>(matches: ReadonlyArray<T>, keys: ReadonlySet<string>): ReadonlyArray<T> {
  if (keys.size === 0) return matches;
  const kept = matches.filter((match) => !isBotThreadKey(keys, match));
  return kept.length === matches.length ? matches : kept;
}

export function sameKeys(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const key of left) if (!right.has(key)) return false;
  return true;
}

export function sameEntries(
  left: ReadonlyArray<BotEntry>,
  right: ReadonlyArray<BotEntry>,
): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => {
      const other = right[index];
      // Settings re-decode on every config push; a few small bots compare cheaply by value.
      return (
        other !== undefined &&
        entry.environmentId === other.environmentId &&
        (entry.bot === other.bot || JSON.stringify(entry.bot) === JSON.stringify(other.bot))
      );
    })
  );
}
