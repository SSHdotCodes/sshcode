/**
 * BotService - Settings > Bots on the server.
 *
 * A bot is a normal SSHCode chat (its home chat) plus a folder, `<userdata>/bots/<id>/`, with
 * its memory and the chats it watches. Bots are defined in server settings; this service
 * makes and removes their chats and folders, keeps their memory and watches, and wakes a bot
 * with one batched note when watched chats finish, fail or ask, or another chat messages it.
 *
 * While Bots are off, or on with no bots, it does nothing: no event subscription, no timers,
 * no tools and no instructions reach any agent.
 *
 * @module BotService
 */
import {
  BOT_MEMORY_ENTRY_MAX,
  BOT_MESSAGE_MAX,
  BOT_NAME_MAX,
  BOT_PERSONALITY_MAX,
  BOT_SEND_NOTE_MAX,
  BOT_WATCH_EVENTS,
  BOT_WATCH_MAX,
  type Bot,
  type BotMemoryEntry,
  type BotOperation,
  type BotOperationResult,
  BotsError,
  type BotsState,
  type BotsView,
  type BotWatch,
  type BotWatchEvent,
  botColor,
  botsSettings,
  CommandId,
  DEFAULT_BOT_PERMISSIONS,
  MessageId,
  type OrchestrationV2DomainEvent,
  ThreadId,
} from "@t3tools/contracts";
import {
  isBotThread,
  registerBotInstructions,
  registerBotThreadCheck,
  registerKnownBotThreadCheck,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import {
  type BotWakeItem,
  botSendText,
  botWakeSummary,
  botWakeText,
  clipText,
} from "@t3tools/shared/bots";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../config.ts";
import { registerEagerCardsCheck } from "../mcp/toolkits/cards/tools.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { botInstructions } from "./botInstructions.ts";
import {
  EMPTY_WATCH_FILE,
  formatMemory,
  formatWatches,
  MEMORY_FILE,
  MEMORY_MAX_ENTRIES,
  parseMemory,
  parseWatches,
  WATCHES_FILE,
} from "./botFiles.ts";
import {
  MANAGE_CHAT_TOOLS,
  registerBotRoutineGate,
  registerBotTools,
  registerBotToolGuard,
  setBotThreads,
  showCardAvailable,
} from "./botsRuntime.ts";

/** Updates wait this long for others to join them before they wake the bot. */
export const BOT_BATCH_WINDOW_MS = 60_000;
/** Least time between two batched wakes of one bot. Questions and failures skip both. */
export const BOT_MIN_WAKE_GAP_MS = 120_000;
/** Maximum held updates kept per bot (paused or waiting on a window); newest survive. */
export const BOT_HELD_MAX = 50;
/** Default events for a watch. */
const DEFAULT_WATCH_EVENTS: ReadonlyArray<BotWatchEvent> = ["finished", "failed", "question"];
/** Ids written into a wake note's message, so the bot's reply can be told apart from the user's turns. */
const WAKE_MESSAGE_PREFIX = "message:bot:";
const ROUTINE_MESSAGE_PREFIX = "scheduled-task-message:";
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/u;
/** Handled run and request ids per chat, so a repeated event can't wake twice. */
const SEEN_PER_THREAD = 32;

export interface BotWatchView extends BotWatch {
  readonly title: string;
}

export class BotService extends Context.Service<
  BotService,
  {
    readonly subscribe: () => Stream.Stream<BotsState, BotsError>;
    readonly mutate: (operation: BotOperation) => Effect.Effect<BotOperationResult, BotsError>;
    /** `bot_memory` from a bot's own chat. */
    readonly memory: (
      botThreadId: ThreadId,
      input: {
        readonly add?: string | undefined;
        readonly replace?: { readonly id: string; readonly text: string } | undefined;
        readonly remove?: string | undefined;
      },
    ) => Effect.Effect<ReadonlyArray<BotMemoryEntry>, BotsError>;
    /** `watch_chats` from a bot's own chat. */
    readonly watch: (
      botThreadId: ThreadId,
      input: {
        readonly threadIds: ReadonlyArray<string>;
        readonly events?: ReadonlyArray<BotWatchEvent> | undefined;
        readonly until?: string | undefined;
      },
    ) => Effect.Effect<ReadonlyArray<BotWatchView>, BotsError>;
    readonly unwatch: (
      botThreadId: ThreadId,
      threadIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<BotWatchView>, BotsError>;
    /** `message_bot` from any other chat. */
    readonly messageBot: (
      fromThreadId: ThreadId,
      input: {
        readonly text: string;
        readonly bot?: string | undefined;
        readonly urgent?: boolean | undefined;
      },
    ) => Effect.Effect<
      { readonly bot: string; readonly delivery: "now" | "soon" | "held" },
      BotsError
    >;
  }
>()("t3/bots/BotService") {}

interface BotRuntime {
  bot: Bot;
  memory: ReadonlyArray<BotMemoryEntry>;
  watches: ReadonlyArray<BotWatch>;
  held: ReadonlyArray<BotWakeItem>;
  timer: Fiber.Fiber<void> | null;
  lastWakeAt: number | null;
  /** Last urgent message_bot wake per source chat, breaking instant chat↔bot ping-pong loops. */
  urgentFrom: Map<string, number>;
}

const fail = (reason: BotsError["reason"], message: string) => new BotsError({ reason, message });

function isPermanentDeliveryError(error: unknown): boolean {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? (error as { readonly _tag?: unknown })._tag
      : undefined;
  return (
    tag === "ThreadManagementThreadNotFoundError" ||
    tag === "ThreadManagementThreadArchivedError" ||
    tag === "ThreadManagementProviderInstanceDisabledError" ||
    tag === "OrchestratorThreadNotFoundError"
  );
}

function sameItem(left: BotWakeItem, right: BotWakeItem): boolean {
  return (
    left.kind === "event" &&
    right.kind === "event" &&
    left.threadId === right.threadId &&
    left.event === right.event
  );
}

/** A repeated event for the same chat counts up instead of adding a line. */
function addItem(held: ReadonlyArray<BotWakeItem>, item: BotWakeItem): ReadonlyArray<BotWakeItem> {
  const index = held.findIndex((existing) => sameItem(existing, item));
  const next =
    index < 0
      ? [...held, item]
      : held.map((entry, at) =>
          at === index && entry.kind === "event" && item.kind === "event"
            ? { ...item, count: (entry.count ?? 1) + 1 }
            : entry,
        );
  return next.length > BOT_HELD_MAX ? next.slice(-BOT_HELD_MAX) : next;
}

const firstLine = (text: string) => clipText(text.split("\n", 1)[0] ?? "", 160);

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const settings = yield* ServerSettings.ServerSettingsService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const folders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks.ScheduledTaskService);
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);

  let view: BotsView = botsSettings(undefined);
  const runtimes = new Map<string, BotRuntime>();
  const byThread = new Map<string, string>();
  const knownThreads = new Set<string>();
  const state = yield* SubscriptionRef.make<BotsState>({ bots: [] });
  let watcher: Fiber.Fiber<void> | null = null;
  const seen = new Map<string, Array<string>>();

  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
  const botDir = (id: string) => path.join(config.stateDir, "bots", id);
  const runtimeForThread = (threadId: string | undefined) => {
    const id = threadId === undefined ? undefined : byThread.get(threadId);
    return id === undefined ? undefined : runtimes.get(id);
  };

  // Every lookup reads the live view, so turning Bots off takes effect at once.
  registerBotThreadCheck((threadId) => view.active && byThread.has(threadId));
  registerKnownBotThreadCheck((threadId) => knownThreads.has(threadId));
  // A bot answers in cards, so its chat lists show_card up front at every Token use level.
  registerEagerCardsCheck(isBotThread);
  registerBotInstructions((threadId) => {
    const runtime = runtimeForThread(threadId);
    if (runtime === undefined) return null;
    return botInstructions({
      name: runtime.bot.name,
      personality: runtime.bot.personality,
      permissions: runtime.bot.permissions,
      memory: runtime.memory,
      cards: showCardAvailable(),
    });
  });

  const nowMs = Clock.currentTimeMillis;
  // The day as the owner's clock shows it; a UTC day reads a day ahead every evening.
  const today = DateTime.now.pipe(
    Effect.map((now) => DateTime.formatIsoDate(DateTime.setZone(now, DateTime.zoneMakeLocal()))),
  );

  const watchAlive = (watch: BotWatch, now: number) =>
    watch.until === undefined || !(Date.parse(watch.until) <= now);

  const publish = Effect.gen(function* () {
    const now = yield* nowMs;
    yield* SubscriptionRef.set(state, {
      bots: view.active
        ? view.list.flatMap((bot) => {
            const runtime = runtimes.get(bot.id);
            if (runtime === undefined) return [];
            return [
              {
                botId: bot.id,
                memory: runtime.memory,
                watching: runtime.watches.filter((watch) => watchAlive(watch, now)),
                waiting: bot.paused ? runtime.held.length : 0,
              },
            ];
          })
        : [],
    });
  });

  const writeFile = (id: string, name: string, text: string) =>
    fileSystem.makeDirectory(botDir(id), { recursive: true }).pipe(
      Effect.andThen(fileSystem.writeFileString(path.join(botDir(id), name), text)),
      Effect.mapError(() => fail("write", "Could not save the bot's files.")),
    );
  const readFile = (id: string, name: string) =>
    fileSystem
      .readFileString(path.join(botDir(id), name))
      .pipe(Effect.orElseSucceed(() => null as string | null));

  const saveWatches = (runtime: BotRuntime) =>
    writeFile(
      runtime.bot.id,
      WATCHES_FILE,
      formatWatches({ watches: runtime.watches, held: runtime.held }),
    );
  const saveMemory = (runtime: BotRuntime) =>
    writeFile(runtime.bot.id, MEMORY_FILE, formatMemory(runtime.memory));

  const loadRuntime = (bot: Bot) =>
    Effect.gen(function* () {
      const memoryText = yield* readFile(bot.id, MEMORY_FILE);
      const watchesText = yield* readFile(bot.id, WATCHES_FILE);
      const file = watchesText === null ? EMPTY_WATCH_FILE : parseWatches(watchesText);
      const now = yield* nowMs;
      return {
        bot,
        memory: memoryText === null ? [] : parseMemory(memoryText),
        watches: file.watches.filter((watch) => watchAlive(watch, now)),
        held: file.held.slice(-BOT_HELD_MAX),
        timer: null,
        lastWakeAt: null,
        urgentFrom: new Map(),
      } satisfies BotRuntime;
    });

  const stopTimer = (runtime: BotRuntime) =>
    Effect.suspend(() => {
      const timer = runtime.timer;
      runtime.timer = null;
      return timer === null ? Effect.void : Fiber.interrupt(timer);
    });

  /** Posts everything held as one note. Called under the lock. Returns true when delivered. */
  const deliver = (runtime: BotRuntime): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      yield* stopTimer(runtime);
      if (runtime.held.length === 0 || !view.active || runtime.bot.paused) return false;
      const items = runtime.held;
      const id = yield* uuid;
      const outcome = yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:bot:${runtime.bot.id}:${id}`),
          threadId: runtime.bot.threadId,
          messageId: MessageId.make(`${WAKE_MESSAGE_PREFIX}${runtime.bot.id}:${id}`),
          text: botWakeText(items),
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: botWakeSummary(items),
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(
          Effect.as("delivered" as const),
          Effect.catchCause((cause) => {
            const error = Cause.squash(cause);
            const permanent = isPermanentDeliveryError(error);
            return Effect.logWarning(
              permanent
                ? "bot update delivery stopped; bot chat or model is unavailable"
                : "bot update delivery failed; kept for the next try",
              {
                botId: runtime.bot.id,
                cause: error,
              },
            ).pipe(Effect.as(permanent ? ("permanent" as const) : ("transient" as const)));
          }),
        );
      if (outcome !== "delivered") {
        if (outcome === "transient") yield* schedule(runtime, BOT_MIN_WAKE_GAP_MS);
        return false;
      }
      runtime.held = [];
      runtime.lastWakeAt = yield* nowMs;
      yield* saveWatches(runtime).pipe(Effect.ignore);
      return true;
    });

  /** Arms the bot's one timer; later updates join it without moving it. */
  const schedule = (runtime: BotRuntime, delayMs: number): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (runtime.timer !== null) return Effect.void;
      return Effect.sleep(delayMs).pipe(
        Effect.andThen(
          lock.withPermits(1)(
            Effect.suspend(() => {
              runtime.timer = null;
              return runtimes.get(runtime.bot.id) === runtime
                ? deliver(runtime).pipe(Effect.asVoid)
                : Effect.void;
            }),
          ),
        ),
        Effect.forkIn(scope),
        Effect.tap((fiber) => Effect.sync(() => (runtime.timer = fiber))),
        Effect.asVoid,
      );
    });

  /** Holds one update and wakes the bot now, after the batch window, or on resume. Under the lock. */
  const enqueue = (runtime: BotRuntime, item: BotWakeItem, urgent: boolean) =>
    Effect.gen(function* () {
      runtime.held = addItem(runtime.held, item);
      yield* saveWatches(runtime).pipe(Effect.ignore);
      if (runtime.bot.paused) {
        yield* publish;
        return "held" as const;
      }
      if (urgent) {
        const delivered = yield* deliver(runtime);
        return delivered ? ("now" as const) : ("held" as const);
      }
      const now = yield* nowMs;
      yield* schedule(
        runtime,
        runtime.lastWakeAt === null
          ? BOT_BATCH_WINDOW_MS
          : Math.max(BOT_BATCH_WINDOW_MS, runtime.lastWakeAt + BOT_MIN_WAKE_GAP_MS - now),
      );
      return "soon" as const;
    });

  const remember = (key: string, id: string) => {
    const ids = seen.get(key) ?? [];
    if (ids.includes(id)) return false;
    ids.push(id);
    if (ids.length > SEEN_PER_THREAD) ids.shift();
    seen.set(key, ids);
    return true;
  };

  /** What a watched chat's event means, once per run, request or message. */
  const watchEventOf = (
    event: OrchestrationV2DomainEvent,
  ): { readonly event: BotWatchEvent; readonly key: string } | null => {
    switch (event.type) {
      case "run.updated": {
        const status = event.payload.status;
        if (status === "completed") return { event: "finished", key: `run:${event.payload.id}` };
        if (status === "failed" || status === "interrupted")
          return { event: "failed", key: `run:${event.payload.id}` };
        return null;
      }
      case "runtime-request.updated":
        return event.payload.status === "pending"
          ? { event: "question", key: `request:${event.payload.id}` }
          : null;
      case "message.updated":
        return event.payload.role === "user" && !event.payload.streaming
          ? { event: "message", key: `message:${event.payload.id}` }
          : null;
      default:
        return null;
    }
  };

  const onEvent = (event: OrchestrationV2DomainEvent) =>
    Effect.gen(function* () {
      const threadId: string = event.threadId;
      const home = runtimeForThread(threadId);
      if (home !== undefined) return;
      if (event.type === "thread.deleted") {
        seen.delete(threadId);
        yield* lock.withPermits(1)(
          Effect.gen(function* () {
            let changed = false;
            for (const runtime of runtimes.values()) {
              const kept = runtime.watches.filter((watch) => watch.threadId !== threadId);
              if (kept.length === runtime.watches.length) continue;
              runtime.watches = kept;
              changed = true;
              yield* saveWatches(runtime).pipe(Effect.ignore);
            }
            if (changed) yield* publish;
          }),
        );
        return;
      }
      const meaning = watchEventOf(event);
      if (meaning === null) return;
      const now = yield* nowMs;
      const watchers = [...runtimes.values()].filter((runtime) =>
        runtime.watches.some(
          (watch) =>
            watch.threadId === threadId &&
            watchAlive(watch, now) &&
            watch.events.includes(meaning.event),
        ),
      );
      if (watchers.length === 0) return;
      const recipients =
        meaning.event === "message" && event.type === "message.updated"
          ? watchers.filter((runtime) => event.payload.senderThreadId !== runtime.bot.threadId)
          : watchers;
      if (recipients.length === 0) return;
      if (!remember(threadId, meaning.key)) return;
      const shell = yield* threads.getThreadShell(ThreadId.make(threadId));
      if (shell === null) return;
      const detail =
        meaning.event === "finished" && shell.replyPreview
          ? firstLine(shell.replyPreview)
          : undefined;
      const item: BotWakeItem = {
        kind: "event",
        threadId,
        title: shell.title,
        event: meaning.event,
        ...(detail === undefined ? {} : { detail }),
      };
      yield* lock.withPermits(1)(
        Effect.forEach(
          recipients,
          (runtime) =>
            enqueue(runtime, item, meaning.event === "question" || meaning.event === "failed"),
          { discard: true },
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("bot watch update failed", { cause: Cause.squash(cause) }),
      ),
    );

  const startWatcher = Effect.suspend(() => {
    if (watcher !== null) return Effect.void;
    return Stream.runForEach(threads.streamDomainEvents, onEvent).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("bot event stream failed; restarting", {
              cause: Cause.squash(cause),
            }),
      ),
      Effect.andThen(Effect.sleep("5 seconds")),
      Effect.forever,
      Effect.forkIn(scope),
      Effect.tap((fiber) => Effect.sync(() => (watcher = fiber))),
      Effect.asVoid,
    );
  });
  const stopWatcher = Effect.suspend(() => {
    const fiber = watcher;
    watcher = null;
    return fiber === null ? Effect.void : Fiber.interrupt(fiber);
  });

  /** Follows settings: loads new bots, drops removed ones, and does nothing while off. */
  const applyView = (next: BotsView) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        view = next;
        knownThreads.clear();
        for (const bot of next.list) knownThreads.add(bot.threadId);
        const live = next.active ? next.list.filter((bot) => SAFE_ID.test(bot.id)) : [];
        // First, before any file reads: MCP tool lists refresh on this same settings change.
        setBotThreads({
          active: next.active,
          threads: new Map(live.map((bot) => [bot.threadId, { permissions: bot.permissions }])),
        });
        const ids = new Set(live.map((bot) => bot.id));
        for (const [id, runtime] of runtimes) {
          if (ids.has(id)) continue;
          yield* stopTimer(runtime);
          runtimes.delete(id);
        }
        byThread.clear();
        for (const bot of live) {
          byThread.set(bot.threadId, bot.id);
          const existing = runtimes.get(bot.id);
          if (existing !== undefined) {
            const resumed = existing.bot.paused === true && bot.paused !== true;
            existing.bot = bot;
            if (bot.paused) yield* stopTimer(existing);
            else if (resumed) yield* deliver(existing);
            continue;
          }
          const runtime = yield* loadRuntime(bot);
          runtimes.set(bot.id, runtime);
          // Updates the last server held wait out a fresh window.
          if (runtime.held.length > 0 && !bot.paused) yield* schedule(runtime, BOT_BATCH_WINDOW_MS);
        }
        if (next.active) yield* startWatcher;
        else yield* stopWatcher;
        yield* publish;
      }),
    );

  const requireOn = Effect.suspend(() =>
    view.enabled
      ? Effect.void
      : Effect.fail(fail("off", "Bots are off. Turn them on in Settings > Bots.")),
  );
  const requireBot = (botId: string) =>
    Effect.suspend(() => {
      const runtime = runtimes.get(botId);
      return runtime === undefined
        ? Effect.fail(fail("notFound", "That bot no longer exists."))
        : Effect.succeed(runtime);
    });
  const requireBotThread = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const runtime = view.active ? runtimeForThread(threadId) : undefined;
      return runtime === undefined
        ? Effect.fail(fail("invalid", "Only a bot's own chat can use this."))
        : Effect.succeed(runtime);
    });

  const writeList = (update: (list: ReadonlyArray<Bot>) => ReadonlyArray<Bot>) =>
    settings
      .modifySettings((current) => Effect.succeed({ bots: { list: update(current.bots.list) } }))
      .pipe(
        Effect.mapError(() => fail("write", "Could not save Settings > Bots.")),
        Effect.flatMap((saved) => applyView(botsSettings(saved))),
      );

  const writeListChecked = (
    update: (current: {
      readonly enabled: boolean;
      readonly list: ReadonlyArray<Bot>;
    }) => Effect.Effect<ReadonlyArray<Bot>, BotsError>,
  ) =>
    settings
      .modifySettings((current) =>
        update(current.bots).pipe(Effect.map((list) => ({ bots: { list } }))),
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "BotsError" ? error : fail("write", "Could not save Settings > Bots."),
        ),
        Effect.flatMap((saved) => applyView(botsSettings(saved))),
      );

  const cleanName = (name: string, list: ReadonlyArray<Bot>, selfId?: string) =>
    Effect.gen(function* () {
      const clean = name.replace(/\s+/gu, " ").trim().slice(0, BOT_NAME_MAX);
      if (clean.length === 0) return yield* fail("invalid", "Give the bot a name.");
      if (list.some((bot) => bot.id !== selfId && bot.name.toLowerCase() === clean.toLowerCase()))
        return yield* fail("invalid", `Another bot is already called ${clean}.`);
      return clean;
    });
  const cleanPersonality = (text: string | undefined) => {
    const clean = text?.trim().slice(0, BOT_PERSONALITY_MAX);
    return clean ? { personality: clean } : {};
  };
  const dispatchFailure = () => fail("unavailable", "SSHCode could not update the bot's chat.");

  const create = (operation: Extract<BotOperation, { type: "create" }>) =>
    Effect.gen(function* () {
      yield* requireOn;
      const name = yield* cleanName(operation.name, view.list);
      const id = `bot-${(yield* uuid).slice(0, 12)}`;
      const threadId = ThreadId.make(`thread:bot:${id}`);
      const folder = botDir(id);
      const { projectId } = yield* folders.ensureScratchProject.pipe(
        Effect.mapError(() =>
          fail(
            "unavailable",
            "Bots need SSHCode's data folder to be outside a Git checkout on this machine.",
          ),
        ),
      );
      yield* fileSystem
        .makeDirectory(folder, { recursive: true })
        .pipe(Effect.mapError(() => fail("write", "Could not make the bot's folder.")));
      const bot: Bot = {
        id,
        name,
        color: botColor(operation.color),
        target: operation.target,
        ...cleanPersonality(operation.personality),
        permissions: { ...DEFAULT_BOT_PERMISSIONS, ...operation.permissions },
        threadId,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* writeFile(id, MEMORY_FILE, formatMemory([]));
      yield* writeFile(id, WATCHES_FILE, formatWatches(EMPTY_WATCH_FILE));
      yield* threads
        .dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "server",
          commandId: CommandId.make(`server:bot-create:${id}`),
          threadId,
          projectId,
          title: name,
          modelSelection: operation.target,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: folder,
        })
        .pipe(
          Effect.tapError(() => fileSystem.remove(folder, { recursive: true }).pipe(Effect.ignore)),
          Effect.mapError((error) =>
            fail(
              "unavailable",
              error._tag === "ThreadManagementProviderInstanceDisabledError"
                ? "That model is turned off. Pick another one."
                : "SSHCode could not start the bot's chat.",
            ),
          ),
        );
      yield* writeListChecked((current) =>
        Effect.gen(function* () {
          if (!current.enabled)
            return yield* fail("off", "Bots are off. Turn them on in Settings > Bots.");
          yield* cleanName(name, current.list);
          return [...current.list, bot];
        }),
      ).pipe(
        Effect.tapError(() =>
          threads
            .dispatch({
              type: "thread.delete",
              commandId: CommandId.make(`server:bot-create-rollback:${id}`),
              threadId,
            })
            .pipe(
              Effect.catchCause(() => Effect.void),
              Effect.andThen(fileSystem.remove(folder, { recursive: true }).pipe(Effect.ignore)),
            ),
        ),
      );
      return { bot } satisfies BotOperationResult;
    });

  const remove = (botId: string) =>
    Effect.gen(function* () {
      const runtime = runtimes.get(botId);
      const bot = runtime?.bot ?? view.list.find((candidate) => candidate.id === botId);
      if (bot === undefined) return yield* fail("notFound", "That bot no longer exists.");
      if (runtime !== undefined) yield* stopTimer(runtime);
      const id = yield* uuid;
      yield* threads
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`server:bot-delete:${botId}:${id}`),
          threadId: bot.threadId,
        })
        .pipe(Effect.catchCause(() => Effect.void));
      if (SAFE_ID.test(botId))
        yield* fileSystem.remove(botDir(botId), { recursive: true }).pipe(Effect.ignore);
      // Its routines go with it; a schedule can't wake a chat that no longer exists.
      if (Option.isSome(scheduledTasks)) {
        const tasks = yield* scheduledTasks.value
          .list()
          .pipe(Effect.orElseSucceed(() => ({ tasks: [] })));
        yield* Effect.forEach(
          tasks.tasks.filter((task) => task.threadId === bot.threadId),
          (task) => scheduledTasks.value.delete({ id: task.id }).pipe(Effect.ignore),
          { discard: true },
        );
      }
      yield* writeList((list) => list.filter((candidate) => candidate.id !== botId));
      return {} satisfies BotOperationResult;
    });

  const update = (operation: Extract<BotOperation, { type: "update" }>) =>
    Effect.gen(function* () {
      const runtime = yield* requireBot(operation.botId);
      const current = runtime.bot;
      const name =
        operation.name === undefined
          ? current.name
          : yield* cleanName(operation.name, view.list, current.id);
      const mergeBot = (base: Bot, resolvedName: string): Bot => {
        const { personality: _personality, ...rest } = base;
        return {
          ...rest,
          name: resolvedName,
          color: operation.color === undefined ? base.color : botColor(operation.color),
          target: operation.target ?? base.target,
          ...(operation.personality === undefined
            ? base.personality === undefined
              ? {}
              : { personality: base.personality }
            : cleanPersonality(operation.personality)),
          permissions: { ...base.permissions, ...operation.permissions },
        };
      };
      const id = yield* uuid;
      let savedBot = mergeBot(current, name);
      yield* writeListChecked((latest) =>
        Effect.gen(function* () {
          const existing = latest.list.find((bot) => bot.id === current.id);
          if (existing === undefined) return yield* fail("notFound", "That bot no longer exists.");
          const checkedName =
            operation.name === undefined
              ? existing.name
              : yield* cleanName(operation.name, latest.list, existing.id);
          savedBot = mergeBot(existing, checkedName);
          return latest.list.map((bot) => (bot.id === current.id ? savedBot : bot));
        }),
      );
      if (savedBot.name !== current.name)
        yield* threads
          .dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`server:bot-rename:${current.id}:${id}`),
            threadId: current.threadId,
            title: savedBot.name,
          })
          .pipe(Effect.mapError(dispatchFailure));
      if (operation.target !== undefined)
        yield* threads
          .dispatch({
            type: "thread.model-selection.set",
            commandId: CommandId.make(`server:bot-model:${current.id}:${id}`),
            threadId: current.threadId,
            modelSelection: operation.target,
          })
          .pipe(Effect.mapError(dispatchFailure));
      return { bot: savedBot } satisfies BotOperationResult;
    });

  const setPaused = (botId: string, paused: boolean) =>
    Effect.gen(function* () {
      let savedBot = (yield* requireBot(botId)).bot;
      yield* writeListChecked((latest) =>
        Effect.gen(function* () {
          const existing = latest.list.find((bot) => bot.id === botId);
          if (existing === undefined) return yield* fail("notFound", "That bot no longer exists.");
          const { paused: _paused, ...rest } = existing;
          const next: Bot = paused ? { ...rest, paused: true } : rest;
          savedBot = next;
          return latest.list.map((bot) => (bot.id === botId ? next : bot));
        }),
      );
      return { bot: savedBot } satisfies BotOperationResult;
    });

  const editMemory = (runtime: BotRuntime, input: Parameters<BotService["Service"]["memory"]>[1]) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        let memory = [...runtime.memory];
        const clean = (text: string) => clipText(text, BOT_MEMORY_ENTRY_MAX);
        if (input.remove !== undefined)
          memory = memory.filter((entry) => entry.id !== input.remove);
        if (input.replace !== undefined) {
          const text = clean(input.replace.text);
          if (!memory.some((entry) => entry.id === input.replace!.id))
            return yield* fail("notFound", `No memory entry ${input.replace.id}.`);
          memory = text
            ? memory.map((entry) => (entry.id === input.replace!.id ? { ...entry, text } : entry))
            : memory.filter((entry) => entry.id !== input.replace!.id);
        }
        if (input.add !== undefined) {
          const text = clean(input.add);
          if (text) memory.push({ id: `m${(yield* uuid).slice(0, 6)}`, at: yield* today, text });
        }
        runtime.memory = memory.slice(-MEMORY_MAX_ENTRIES);
        yield* saveMemory(runtime);
        yield* publish;
        return runtime.memory;
      }),
    );

  const watchViews = (runtime: BotRuntime) =>
    Effect.gen(function* () {
      const now = yield* nowMs;
      const alive = runtime.watches.filter((watch) => watchAlive(watch, now));
      return yield* Effect.forEach(alive, (watch) =>
        threads.getThreadShell(ThreadId.make(watch.threadId)).pipe(
          Effect.map((shell) => ({ ...watch, title: shell?.title ?? "A deleted chat" })),
          Effect.orElseSucceed(() => ({ ...watch, title: "A chat" })),
        ),
      );
    });

  const watch: BotService["Service"]["watch"] = (botThreadId, input) =>
    Effect.gen(function* () {
      const runtime = yield* requireBotThread(botThreadId);
      const events = (input.events?.length ? input.events : DEFAULT_WATCH_EVENTS).filter((event) =>
        BOT_WATCH_EVENTS.includes(event),
      );
      if (events.length === 0)
        return yield* fail(
          "invalid",
          `events must include at least one of ${BOT_WATCH_EVENTS.join(", ")}.`,
        );
      const now = yield* nowMs;
      if (input.until !== undefined) {
        const untilMs = Date.parse(input.until);
        if (Number.isNaN(untilMs)) return yield* fail("invalid", "until must be an ISO time.");
        if (untilMs <= now) return yield* fail("invalid", "until must be in the future.");
      }
      const targets: string[] = [];
      for (const threadId of new Set(input.threadIds)) {
        if (threadId === runtime.bot.threadId)
          return yield* fail("invalid", "A bot doesn't watch its own chat.");
        const shell = yield* threads
          .getThreadShell(ThreadId.make(threadId))
          .pipe(Effect.orElseSucceed(() => null));
        if (shell === null || shell.deletedAt !== null)
          return yield* fail("notFound", `No chat ${threadId}.`);
        targets.push(threadId);
      }
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const checkNow = yield* nowMs;
          const kept = runtime.watches.filter(
            (existing) => watchAlive(existing, checkNow) && !targets.includes(existing.threadId),
          );
          const added = targets.map((threadId) => ({
            threadId: ThreadId.make(threadId),
            events,
            ...(input.until === undefined ? {} : { until: input.until }),
          }));
          if (kept.length + added.length > BOT_WATCH_MAX)
            return yield* fail(
              "invalid",
              `A bot watches at most ${BOT_WATCH_MAX} chats; unwatch some first.`,
            );
          runtime.watches = [...kept, ...added];
          yield* saveWatches(runtime);
          yield* publish;
        }),
      );
      return yield* watchViews(runtime);
    });

  const unwatchFor = (runtime: BotRuntime, threadIds: ReadonlyArray<string>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* nowMs;
        runtime.watches = runtime.watches.filter(
          (watch) => watchAlive(watch, now) && !threadIds.includes(watch.threadId),
        );
        yield* saveWatches(runtime);
        yield* publish;
      }),
    );

  const messageBot: BotService["Service"]["messageBot"] = (fromThreadId, input) =>
    Effect.gen(function* () {
      if (!view.active) return yield* fail("off", "There is no bot to message.");
      if (byThread.has(fromThreadId))
        return yield* fail("invalid", "This is a bot's own chat; reply to the user instead.");
      const wanted = input.bot?.trim().toLowerCase();
      const bot =
        wanted === undefined || wanted.length === 0
          ? view.list[0]
          : view.list.find((candidate) => candidate.name.toLowerCase() === wanted);
      if (bot === undefined)
        return yield* fail(
          "notFound",
          `No bot named ${input.bot}. Bots: ${view.list.map((candidate) => candidate.name).join(", ")}.`,
        );
      const runtime = yield* requireBot(bot.id);
      const text = clipText(input.text, BOT_MESSAGE_MAX);
      if (text.length === 0) return yield* fail("invalid", "Write something for the bot.");
      const shell = yield* threads
        .getThreadShell(fromThreadId)
        .pipe(Effect.orElseSucceed(() => null));
      const delivery = yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* nowMs;
          const lastUrgent = runtime.urgentFrom.get(fromThreadId);
          // One urgent wake per source chat per min-wake gap prevents instant chat↔bot loops.
          const urgentNow =
            input.urgent === true &&
            (lastUrgent === undefined || now - lastUrgent >= BOT_MIN_WAKE_GAP_MS);
          const result = yield* enqueue(
            runtime,
            { kind: "message", threadId: fromThreadId, title: shell?.title ?? "A chat", text },
            urgentNow,
          );
          if (urgentNow && result === "now") {
            if (runtime.urgentFrom.size >= 64) {
              const oldest = runtime.urgentFrom.keys().next().value;
              if (oldest !== undefined) runtime.urgentFrom.delete(oldest);
            }
            runtime.urgentFrom.set(fromThreadId, now);
          }
          return result;
        }),
      );
      return { bot: bot.name, delivery };
    });

  /** "Send to <bot>…": the user's own message, so it starts a turn now. */
  const send = (operation: Extract<BotOperation, { type: "send" }>) =>
    Effect.gen(function* () {
      const runtime = yield* requireBot(operation.botId);
      if (operation.threadId === runtime.bot.threadId)
        return yield* fail("invalid", "A bot can't be sent its own chat.");
      const shell = yield* threads
        .getThreadShell(operation.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      if (shell === null || shell.deletedAt !== null)
        return yield* fail("notFound", "That chat no longer exists.");
      const id = yield* uuid;
      yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:bot-send:${runtime.bot.id}:${id}`),
          threadId: runtime.bot.threadId,
          messageId: MessageId.make(`message:bot-send:${runtime.bot.id}:${id}`),
          text: botSendText({
            threadId: operation.threadId,
            title: shell.title,
            note:
              operation.note === undefined
                ? undefined
                : clipText(operation.note, BOT_SEND_NOTE_MAX),
          }),
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(Effect.mapError(dispatchFailure));
      return {} satisfies BotOperationResult;
    });

  // A paused bot holds its routines like any other update; while Bots are off, saved bots'
  // routines do not run at all (no tokens, no file writes).
  registerBotRoutineGate((threadId, prompt) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        if (!view.active) return knownThreads.has(threadId);
        const runtime = runtimeForThread(threadId);
        if (runtime === undefined || !runtime.bot.paused) return false;
        yield* enqueue(
          runtime,
          { kind: "routine", text: clipText(prompt, BOT_MESSAGE_MAX) },
          false,
        );
        return true;
      }),
    ),
  );

  // Chats and web pages are information. A turn an update note started can't stop or settle
  // chats on its own: the bot asks, and the user's answer starts a turn that can. Answering
  // other chats' questions during a bot-initiated turn also requires the answerQuestions toggle.
  registerBotToolGuard((scope, toolName, payload) =>
    Effect.gen(function* () {
      const runtime = runtimeForThread(scope.thread?.threadId);
      if (runtime === undefined) return undefined;
      if (MANAGE_CHAT_TOOLS.has(toolName) && !runtime.bot.permissions.manageChats)
        return "Managing chats is off for this bot in Settings > Bots.";
      const action =
        typeof payload === "object" && payload !== null
          ? (payload as { readonly action?: unknown }).action
          : undefined;
      const settles =
        (toolName === "t3_thread_update" && action === "settle") ||
        (toolName === "t3_thread_organize" && (action === "settle" || action === "archive"));
      const answersQuestion =
        toolName === "t3_pending_request_respond" && !runtime.bot.permissions.answerQuestions;
      const destructiveWakeTool =
        toolName === "t3_thread_interrupt" ||
        toolName === "task_cancel" ||
        toolName === "t3_workflow_stop" ||
        settles;
      if (!destructiveWakeTool && !answersQuestion) return undefined;
      const records = yield* threads
        .getThreadRecords(runtime.bot.threadId, ["runs", "messages"], { activeRunsOnly: true })
        .pipe(Effect.orElseSucceed(() => null));
      const run = records?.runs.find(
        (candidate) =>
          candidate.status === "running" ||
          candidate.status === "waiting" ||
          candidate.status === "starting" ||
          candidate.status === "preparing",
      );
      if (run === undefined) return undefined;
      if (
        answersQuestion &&
        (run.userMessageId.startsWith(WAKE_MESSAGE_PREFIX) ||
          run.userMessageId.startsWith(ROUTINE_MESSAGE_PREFIX))
      ) {
        return "Answering other chats' questions is off for this bot in Settings > Bots. Ask the user first.";
      }
      return destructiveWakeTool && run.userMessageId.startsWith(WAKE_MESSAGE_PREFIX)
        ? "This turn started from an update note, not from the user. Ask the user first; do it in the turn their answer starts."
        : undefined;
    }),
  );

  // Follow settings for the life of the server.
  const changes = yield* settings.subscribeChanges;
  yield* settings.getSettings.pipe(
    Effect.flatMap((current) => applyView(botsSettings(current))),
    Effect.catchCause((cause) =>
      Effect.logWarning("bots could not read settings", { cause: Cause.squash(cause) }),
    ),
  );
  yield* changes.pipe(
    Stream.map((next) => next.bots),
    Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)),
    Stream.runForEach((bots) => applyView(botsSettings({ bots }))),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      registerBotThreadCheck(() => false);
      registerKnownBotThreadCheck(() => false);
      registerEagerCardsCheck(() => false);
      registerBotInstructions(() => null);
      registerBotRoutineGate(null);
      registerBotToolGuard(null);
      registerBotTools(null);
      setBotThreads({ active: false, threads: new Map() });
    }),
  );

  const unwatch: BotService["Service"]["unwatch"] = (botThreadId, threadIds) =>
    requireBotThread(botThreadId).pipe(
      Effect.tap((runtime) => unwatchFor(runtime, threadIds)),
      Effect.flatMap(watchViews),
    );
  const memory: BotService["Service"]["memory"] = (botThreadId, input) =>
    requireBotThread(botThreadId).pipe(Effect.flatMap((runtime) => editMemory(runtime, input)));
  registerBotTools({ memory, watch, unwatch, messageBot });

  return BotService.of({
    subscribe: () => SubscriptionRef.changes(state),
    mutate: (operation) => {
      switch (operation.type) {
        case "create":
          return create(operation);
        case "update":
          return requireOn.pipe(Effect.andThen(update(operation)));
        case "pause":
          return requireOn.pipe(Effect.andThen(setPaused(operation.botId, operation.paused)));
        case "delete":
          return remove(operation.botId);
        case "memory":
          return requireOn.pipe(
            Effect.andThen(requireBot(operation.botId)),
            Effect.flatMap((runtime) => editMemory(runtime, operation)),
            Effect.as({} satisfies BotOperationResult),
          );
        case "unwatch":
          return requireOn.pipe(
            Effect.andThen(requireBot(operation.botId)),
            Effect.flatMap((runtime) => unwatchFor(runtime, operation.threadIds)),
            Effect.as({} satisfies BotOperationResult),
          );
        case "send":
          return requireOn.pipe(Effect.andThen(send(operation)));
      }
    },
    memory,
    watch,
    unwatch,
    messageBot,
  });
});

export const layer = Layer.effect(BotService, make);
