import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  botsEnabledPatch,
  botStatus,
  parkedBotForThread,
  serverBotsView,
  serverSupportsBots,
} from "@t3tools/client-runtime/state/bots";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import {
  AuthSettingsWriteScope,
  WS_METHODS,
  type BotRuntimeState,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useCallback, useMemo, useState } from "react";

import { connectionAtomRuntime } from "../../connection/runtime";
import { threadNeedsYou } from "../../lib/thread-summaries";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { environmentServerConfigsAtom, serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  activeBotEntries,
  botThreadKeys,
  sameEntries,
  sameKeys,
  withoutBotThreads,
  type BotEntry,
} from "./botVisibility";

/** Memory, watches and held updates. Opened only while that machine has Bots on with a bot. */
export const botsState = createEnvironmentRpcSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "mobile:bots:state",
  tag: WS_METHODS.botsSubscribe,
  idleTtlMs: 15_000,
});
export const mutateBots = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "mobile:bots:mutate",
  tag: WS_METHODS.botsMutate,
  concurrency: { mode: "serial", key: ({ environmentId }) => environmentId },
});

const EMPTY_ENTRIES: ReadonlyArray<BotEntry> = [];
let previousEntries = EMPTY_ENTRIES;
/** Every bot on a machine with Bots on. Stable across config pushes that change no bot. */
export const botEntriesAtom = Atom.make((get): ReadonlyArray<BotEntry> => {
  const next = activeBotEntries(get(environmentServerConfigsAtom));
  if (sameEntries(previousEntries, next)) return previousEntries;
  previousEntries = next.length === 0 ? EMPTY_ENTRIES : next;
  return previousEntries;
}).pipe(Atom.withLabel("mobile:bots:entries"));

let previousKeys: ReadonlySet<string> = new Set();
/** Bot home chats, left out of every chat list, search and count, also while Bots are off. */
export const botThreadKeysAtom = Atom.make((get): ReadonlySet<string> => {
  const next = botThreadKeys(get(environmentServerConfigsAtom));
  if (sameKeys(previousKeys, next)) return previousKeys;
  previousKeys = next;
  return next;
}).pipe(Atom.withLabel("mobile:bots:thread-keys"));

export function useBotEntries(): ReadonlyArray<BotEntry> {
  return useAtomValue(botEntriesAtom);
}

export function useBotThreadKeys(): ReadonlySet<string> {
  return useAtomValue(botThreadKeysAtom);
}

/** The list without bot home chats; the same array while no bot chat is in it. */
export function useWithoutBotThreads<
  T extends { readonly environmentId: string; readonly id: string },
>(threads: ReadonlyArray<T>): ReadonlyArray<T> {
  const keys = useBotThreadKeys();
  return useMemo(() => withoutBotThreads(threads, keys), [threads, keys]);
}

/** The bot whose home chat this is, while its machine has Bots on. */
export function useBotForThread(
  environmentId: EnvironmentId,
  threadId: ThreadId | string,
): BotEntry | null {
  const entries = useBotEntries();
  return (
    entries.find(
      (entry) => entry.environmentId === environmentId && entry.bot.threadId === threadId,
    ) ?? null
  );
}

/**
 * The bot whose home chat this is while its machine has Bots off: the chat still opens (a link,
 * a notification, the back stack) and reads as the bot's, but takes no messages.
 */
export function useParkedBotForThread(
  environmentId: EnvironmentId,
  threadId: ThreadId | string,
): BotEntry | null {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const bot = parkedBotForThread(serverBotsView(configs.get(environmentId) ?? null), threadId);
  return useMemo(() => (bot === undefined ? null : { environmentId, bot }), [bot, environmentId]);
}

/** A bot by route params; null when it is gone, Bots are off, or no bot was named. */
export function useBotEntry(
  environmentId: string | null | undefined,
  botId: string | null | undefined,
): BotEntry | null {
  const entries = useBotEntries();
  if (!environmentId || !botId) return null;
  return (
    entries.find((entry) => entry.environmentId === environmentId && entry.bot.id === botId) ?? null
  );
}

/** What the server knows about one bot. Subscribes only while that machine has an active bot. */
export function useBotRuntime(entry: BotEntry | null): BotRuntimeState | undefined {
  const query = useEnvironmentQuery(
    entry === null ? null : botsState({ environmentId: entry.environmentId, input: {} }),
  );
  return query.data?.bots.find((runtime) => runtime.botId === entry?.bot.id);
}

/** The muted line under a bot's name: its home chat's run and questions plus held updates. */
export function useBotStatus(entry: BotEntry, runtime: BotRuntimeState | undefined) {
  return (
    useOptionalBotStatus(entry, runtime) ??
    botStatus({ bot: entry.bot, runtime, working: false, needsYou: false })
  );
}

export function useOptionalBotStatus(
  entry: BotEntry | null,
  runtime: BotRuntimeState | undefined,
): ReturnType<typeof botStatus> | null {
  const shell = useThreadShell(
    entry === null ? null : scopeThreadRef(entry.environmentId, entry.bot.threadId),
  );
  if (entry === null) return null;
  return botStatus({
    bot: entry.bot,
    runtime,
    working: shell !== null && isThreadWorking(shell),
    needsYou: shell !== null && threadNeedsYou(shell),
  });
}

/**
 * Settings > Bots' switch. A change goes to every connected machine that knows Bots, like
 * Settings > Agents, so the Mac and the phone agree. Shows the change at once.
 */
export function useBotsEnabled(): {
  readonly enabled: boolean;
  readonly setEnabled: (enabled: boolean) => void;
  readonly writable: boolean;
  readonly targets: ReadonlyArray<EnvironmentId>;
} {
  const configs = useAtomValue(environmentServerConfigsAtom);
  const save = useAtomCommand(serverEnvironment.updateSettings, {
    label: "bots switch update",
    reportFailure: true,
  });
  const targets = useMemo(
    () =>
      [...configs]
        .filter(([, config]) => serverSupportsBots(config))
        .map(([environmentId]) => environmentId),
    [configs],
  );
  const writableTargets = useEnvironmentsWithScope(
    targets.map((environmentId) => ({ environmentId })),
    AuthSettingsWriteScope,
  );
  const synced = targets.some((id) => serverBotsView(configs.get(id)).enabled);
  const [pending, setPending] = useState<{
    readonly value: boolean;
    readonly from: boolean;
  } | null>(null);
  if (pending !== null && pending.from !== synced) setPending(null);
  const setEnabled = useCallback(
    (value: boolean) => {
      const entry = { value, from: synced };
      setPending(entry);
      const writes = targets
        .filter((environmentId) => readEnvironmentScope(environmentId, AuthSettingsWriteScope))
        .map((environmentId) => save({ environmentId, input: { patch: botsEnabledPatch(value) } }));
      void Promise.all(writes).then((results) => {
        if (results.every((result) => result._tag === "Failure"))
          setPending((current) => (current === entry ? null : current));
      });
    },
    [save, synced, targets],
  );
  return {
    enabled: pending?.value ?? synced,
    setEnabled,
    writable: targets.some((id) => writableTargets.has(id)),
    targets,
  };
}
