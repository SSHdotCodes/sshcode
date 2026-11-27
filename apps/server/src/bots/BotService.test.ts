import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type Bot,
  EnvironmentId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ServerSettings as ServerSettingsSchema,
  type ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import {
  botInstructionsFor,
  isBotThread,
  isKnownBotThread,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { parseBotWake } from "@t3tools/shared/bots";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { resolveAgentAwarenessRelayActiveThreadIds } from "../relay/AgentAwarenessRelay.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as BotService from "./BotService.ts";
import { formatWatches } from "./botFiles.ts";
import { botToolVisible, guardBotToolCall, holdBotRoutine } from "./botsRuntime.ts";

type Command = Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0];

const decodeSettings = Schema.decodeUnknownSync(ServerSettingsSchema);
const target = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const scratch = ProjectId.make("scratch");

const savedBot = (overrides: Partial<Bot> = {}): Bot =>
  ({
    id: "bot-fixed",
    name: "Pip",
    color: "teal",
    target,
    permissions: {
      manageChats: true,
      answerQuestions: false,
      startSubagents: true,
      messageFirst: true,
    },
    threadId: ThreadId.make("thread:bot:bot-fixed"),
    createdAt: "2026-11-26T12:00:00.000Z",
    ...overrides,
  }) as Bot;

let eventCount = 0;
const event = (input: { type: string; threadId: string; payload: object }) =>
  ({ id: `event-${++eventCount}`, ...input }) as unknown as OrchestrationV2DomainEvent;

interface Harness {
  readonly bots: BotService.BotService["Service"];
  readonly commands: Queue.Queue<Command>;
  readonly events: Queue.Queue<OrchestrationV2DomainEvent>;
  readonly shells: Map<string, Partial<OrchestrationV2ThreadShell>>;
  readonly activeRuns: Map<string, ReadonlyArray<{ status: string; userMessageId: string }>>;
  readonly settings: SubscriptionRef.SubscriptionRef<ServerSettings>;
  readonly subscriptions: () => number;
  /** Every shell read, so a test can wait until an event was handled. */
  readonly shellReads: Queue.Queue<string>;
  readonly stateDir: string;
}

/** BotService against mocked chats, settings that stream their changes, and a temp state dir. */
const withBots = <A, E>(
  initial: { readonly enabled: boolean; readonly list?: ReadonlyArray<Bot> },
  body: (harness: Harness) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  before?: (
    stateDir: string,
  ) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path>,
  options?: {
    readonly failDispatch?: (command: Command) => unknown;
    readonly failModifySettings?: () => unknown;
  },
) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (before) yield* before(config.stateDir).pipe(Effect.orDie);
    const commands = yield* Queue.unbounded<Command>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const shellReads = yield* Queue.unbounded<string>();
    const shells = new Map<string, Partial<OrchestrationV2ThreadShell>>();
    const activeRuns = new Map<string, ReadonlyArray<{ status: string; userMessageId: string }>>();
    let subscriptions = 0;
    const settings = yield* SubscriptionRef.make(
      decodeSettings({ bots: { enabled: initial.enabled, list: initial.list ?? [] } }),
    );
    const layer = BotService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ThreadManagement.ThreadManagementService)({
            dispatch: (command) => {
              const failure = options?.failDispatch?.(command);
              if (failure !== undefined)
                return Queue.offer(commands, command).pipe(
                  Effect.andThen(Effect.fail(failure as never)),
                );
              return Queue.offer(commands, command).pipe(
                Effect.as({ sequence: 0, storedEvents: [] }),
              );
            },
            getThreadShell: (threadId) =>
              Queue.offer(shellReads, threadId).pipe(
                Effect.as(
                  (shells.has(threadId)
                    ? { id: threadId, deletedAt: null, ...shells.get(threadId) }
                    : null) as OrchestrationV2ThreadShell | null,
                ),
              ),
            getThreadRecords: (threadId) =>
              Effect.succeed({
                thread: {},
                runs: activeRuns.get(threadId) ?? [],
                messages: [],
              } as never),
            streamDomainEvents: Stream.suspend(() => {
              subscriptions++;
              return Stream.fromQueue(events);
            }),
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            ensureScratchProject: Effect.succeed({ projectId: scratch }),
            namedProjectsRoot: "",
          }),
          Layer.mock(ServerSettingsService.ServerSettingsService)({
            getSettings: SubscriptionRef.get(settings),
            modifySettings: (update) => {
              const failure = options?.failModifySettings?.();
              if (failure !== undefined) return Effect.fail(failure as never);
              return SubscriptionRef.get(settings).pipe(
                Effect.flatMap((current) =>
                  update(current).pipe(
                    Effect.map((patch) => applyServerSettingsPatch(current, patch)),
                  ),
                ),
                Effect.tap((next) => SubscriptionRef.set(settings, next)),
              );
            },
            subscribeChanges: Effect.succeed(
              SubscriptionRef.changes(settings).pipe(Stream.drop(1)),
            ),
          }),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const bots = yield* BotService.BotService;
      return yield* body({
        bots,
        commands,
        events,
        shells,
        activeRuns,
        settings,
        subscriptions: () => subscriptions,
        shellReads,
        stateDir: config.stateDir,
      });
    }).pipe(Effect.provide(layer));
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-bots-" }).pipe(
        Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
      ),
    ),
  );

const wakeText = (command: Command) => (command.type === "message.dispatch" ? command.text : "");

describe("BotService", () => {
  it.effect("does nothing while Bots are off: no stream, no tools, no instructions", () =>
    withBots({ enabled: false, list: [savedBot()] }, (harness) =>
      Effect.gen(function* () {
        expect(harness.subscriptions()).toBe(0);
        expect(isBotThread("thread:bot:bot-fixed")).toBe(false);
        expect(isKnownBotThread("thread:bot:bot-fixed")).toBe(true);
        expect(botInstructionsFor("thread:bot:bot-fixed")).toBeNull();
        // Turning Bots off must keep saved bot chats out of phone alerts and relay live activities.
        const botShell = {
          id: ThreadId.make("thread:bot:bot-fixed"),
          projectId: scratch,
          title: "Pip",
          archivedAt: null,
          deletedAt: null,
          status: "running",
          activityRunStatus: "running",
          activeRunId: "run-1",
          latestRunId: "run-1",
          latestRunCompletedAt: null,
          pendingRuntimeRequest: null,
          hasActionableProposedPlan: false,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: "thread:bot:bot-fixed",
          },
        } as unknown as OrchestrationV2ThreadShell;
        expect(
          resolveAgentAwarenessRelayActiveThreadIds({
            environmentId: EnvironmentId.make("env-1"),
            startedAt: 0,
            projects: [{ id: scratch, title: "Scratch" }],
            threads: [botShell],
          }),
        ).toEqual([]);
        const chat = { thread: { threadId: "thread-1" } } as never;
        expect(botToolVisible("message_bot", chat)).toBe(false);
        const created = yield* harness.bots
          .mutate({ type: "create", name: "Kit", color: "blue", target })
          .pipe(Effect.flip);
        expect(created.reason).toBe("off");
        expect(yield* Queue.size(harness.commands)).toBe(0);
        // A saved bot's routine must not run while Bots are off, and must not write watches.json.
        expect(yield* holdBotRoutine("thread:bot:bot-fixed", "Morning check")!).toBe(true);
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        expect(
          yield* fs.exists(path.join(harness.stateDir, "bots", "bot-fixed", "watches.json")),
        ).toBe(false);
        // Deleting a saved bot still works while Bots are off.
        yield* harness.bots.mutate({ type: "delete", botId: "bot-fixed" });
        expect(yield* Queue.take(harness.commands)).toMatchObject({
          type: "thread.delete",
          threadId: "thread:bot:bot-fixed",
        });
        expect((yield* SubscriptionRef.get(harness.settings)).bots.list).toHaveLength(0);
      }),
    ),
  );

  it.effect("makes a bot's folder and home chat, and deleting removes both", () =>
    withBots({ enabled: true }, (harness) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { bot } = yield* harness.bots.mutate({
          type: "create",
          name: "  Juno ",
          color: "chartreuse",
          target,
          personality: "Dry humor",
        });
        expect(bot).toMatchObject({ name: "Juno", color: "blue", personality: "Dry humor" });
        const folder = path.join(harness.stateDir, "bots", bot!.id);
        expect(yield* Queue.take(harness.commands)).toMatchObject({
          type: "thread.create",
          threadId: bot!.threadId,
          projectId: scratch,
          title: "Juno",
          runtimeMode: "full-access",
          worktreePath: folder,
        });
        expect(yield* fs.exists(path.join(folder, "memory.md"))).toBe(true);
        expect((yield* SubscriptionRef.get(harness.settings)).bots.list).toHaveLength(1);
        expect(isBotThread(bot!.threadId)).toBe(true);
        expect(botInstructionsFor(bot!.threadId)).toContain("## You are Juno");
        expect(botInstructionsFor(bot!.threadId)).toContain("Dry humor");
        expect(harness.subscriptions()).toBe(1);

        const duplicate = yield* harness.bots
          .mutate({ type: "create", name: "juno", color: "blue", target })
          .pipe(Effect.flip);
        expect(duplicate.message).toBe("Another bot is already called juno.");

        yield* harness.bots.mutate({ type: "delete", botId: bot!.id });
        expect(yield* Queue.take(harness.commands)).toMatchObject({
          type: "thread.delete",
          threadId: bot!.threadId,
        });
        expect(yield* fs.exists(folder)).toBe(false);
        expect((yield* SubscriptionRef.get(harness.settings)).bots.list).toHaveLength(0);
        expect(isBotThread(bot!.threadId)).toBe(false);
      }),
    ),
  );

  it.effect("batches updates: a 60 s window, 2 min between wakes, urgent ones at once", () =>
    withBots({ enabled: true, list: [savedBot()] }, (harness) =>
      Effect.gen(function* () {
        const from = ThreadId.make("chat-a");
        harness.shells.set(from, { title: "Phone build" });
        expect(yield* harness.bots.messageBot(from, { text: "Build is green." })).toEqual({
          bot: "Pip",
          delivery: "soon",
        });
        yield* harness.bots.messageBot(from, { text: "Tests too." });
        yield* TestClock.adjust("59 seconds");
        expect(yield* Queue.size(harness.commands)).toBe(0);
        yield* TestClock.adjust("1 second");
        const first = yield* Queue.take(harness.commands);
        expect(first).toMatchObject({
          type: "message.dispatch",
          threadId: "thread:bot:bot-fixed",
          createdBy: "agent",
          creationSource: "server",
          dispatchMode: { type: "queue_after_active" },
          notification: {
            source: { kind: "monitor" },
            summary: "Updates: From Phone build · From Phone build",
          },
        });
        expect(parseBotWake(wakeText(first))).toHaveLength(2);

        // The next batch waits out the 2 min gap since that wake, not just the window.
        yield* harness.bots.messageBot(from, { text: "One more." });
        yield* TestClock.adjust("119 seconds");
        expect(yield* Queue.size(harness.commands)).toBe(0);
        // Urgent skips the wait and takes what is held with it.
        expect(
          yield* harness.bots.messageBot(from, { text: "Server is down", urgent: true }),
        ).toEqual({
          bot: "Pip",
          delivery: "now",
        });
        const urgent = yield* Queue.take(harness.commands);
        expect(
          parseBotWake(wakeText(urgent))?.map((item) => item.kind === "message" && item.text),
        ).toEqual(["One more.", "Server is down"]);
        yield* TestClock.adjust("10 minutes");
        expect(yield* Queue.size(harness.commands)).toBe(0);
      }),
    ),
  );

  it.effect("watched chats: finishes wait for the batch, failures and questions wake now", () =>
    withBots({ enabled: true, list: [savedBot()] }, (harness) =>
      Effect.gen(function* () {
        const bot = savedBot();
        for (const [id, title] of [
          ["chat-build", "Phone build"],
          ["chat-tests", "Server tests"],
        ] as const)
          harness.shells.set(id, {
            title,
            replyPreview: id === "chat-build" ? "All 12 checks passed." : null,
          });
        const watching = yield* harness.bots.watch(bot.threadId, {
          threadIds: ["chat-build", "chat-tests"],
        });
        expect(watching.map((watch) => watch.title)).toEqual(["Phone build", "Server tests"]);
        const run = (threadId: string, id: string, status: string) =>
          Queue.offer(
            harness.events,
            event({ type: "run.updated", threadId, payload: { id, status, userMessageId: "m" } }),
          );
        yield* run("chat-build", "run-1", "completed");
        // The same run reported again is not a second update.
        yield* run("chat-build", "run-1", "completed");
        yield* run("chat-tests", "run-2", "running");
        yield* run("chat-tests", "run-2", "failed");
        const note = yield* Queue.take(harness.commands);
        expect(parseBotWake(wakeText(note))).toEqual([
          {
            kind: "event",
            threadId: "chat-build",
            title: "Phone build",
            event: "finished",
            detail: "All 12 checks passed.",
          },
          { kind: "event", threadId: "chat-tests", title: "Server tests", event: "failed" },
        ]);
        expect(note).toMatchObject({
          notification: { summary: "Updates: Phone build finished · Server tests failed" },
        });

        yield* Queue.offer(
          harness.events,
          event({
            type: "runtime-request.updated",
            threadId: "chat-tests",
            payload: { id: "request-1", status: "pending" },
          }),
        );
        expect(parseBotWake(wakeText(yield* Queue.take(harness.commands)))).toEqual([
          { kind: "event", threadId: "chat-tests", title: "Server tests", event: "question" },
        ]);

        const left = yield* harness.bots.unwatch(bot.threadId, ["chat-tests"]);
        expect(left.map((watch) => watch.threadId)).toEqual(["chat-build"]);
      }),
    ),
  );

  it.effect("a paused bot holds updates and routines, then gets them as one note", () =>
    withBots({ enabled: true, list: [savedBot()] }, (harness) =>
      Effect.gen(function* () {
        const bot = savedBot();
        harness.shells.set("chat-a", { title: "Docs chat" });
        yield* harness.bots.mutate({ type: "pause", botId: bot.id, paused: true });
        expect(
          yield* harness.bots.messageBot(ThreadId.make("chat-a"), { text: "Ready", urgent: true }),
        ).toEqual({ bot: "Pip", delivery: "held" });
        expect(yield* holdBotRoutine(bot.threadId, "Tell me what happened overnight")!).toBe(true);
        expect(yield* holdBotRoutine("chat-a", "Not a bot")!).toBe(false);
        const state = yield* harness.bots.subscribe().pipe(Stream.runHead);
        expect(state._tag === "Some" && state.value.bots[0]?.waiting).toBe(2);
        yield* TestClock.adjust("1 hour");
        expect(yield* Queue.size(harness.commands)).toBe(0);

        yield* harness.bots.mutate({ type: "pause", botId: bot.id, paused: false });
        const note = yield* Queue.take(harness.commands);
        expect(parseBotWake(wakeText(note))).toEqual([
          { kind: "message", threadId: "chat-a", title: "Docs chat", text: "Ready" },
          { kind: "routine", text: "Tell me what happened overnight" },
        ]);
      }),
    ),
  );

  it.effect("keeps watches and held updates across a restart", () =>
    withBots(
      { enabled: true, list: [savedBot()] },
      (harness) =>
        Effect.gen(function* () {
          const state = yield* harness.bots.subscribe().pipe(Stream.runHead);
          expect(state._tag === "Some" && state.value.bots[0]?.watching[0]?.threadId).toBe(
            "chat-a",
          );
          yield* TestClock.adjust("60 seconds");
          expect(parseBotWake(wakeText(yield* Queue.take(harness.commands)))).toEqual([
            { kind: "event", threadId: "chat-a", title: "Release", event: "finished" },
          ]);
        }),
      (stateDir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const folder = path.join(stateDir, "bots", "bot-fixed");
          yield* fs.makeDirectory(folder, { recursive: true });
          yield* fs.writeFileString(
            path.join(folder, "watches.json"),
            formatWatches({
              watches: [{ threadId: ThreadId.make("chat-a"), events: ["finished"] }],
              held: [{ kind: "event", threadId: "chat-a", title: "Release", event: "finished" }],
            }),
          );
        }),
    ),
  );

  it.effect("an update note can't make the bot settle or stop chats on its own", () =>
    withBots({ enabled: true, list: [savedBot()] }, (harness) =>
      Effect.gen(function* () {
        const bot = savedBot();
        const scope = { thread: { threadId: bot.threadId } } as never;
        const guard = (tool: string, payload: unknown) => guardBotToolCall(scope, tool, payload)!;
        harness.activeRuns.set(bot.threadId, [
          { status: "running", userMessageId: "message:bot:bot-fixed:9" },
        ]);
        expect(
          yield* guard("t3_thread_update", { action: "settle", threadId: "chat-a" }),
        ).toContain("Ask the user first");
        expect(yield* guard("t3_thread_interrupt", { threadId: "chat-a" })).toContain(
          "Ask the user first",
        );
        expect(yield* guard("t3_thread_update", { action: "rename", title: "x" })).toBeUndefined();
        // The user's own turn may.
        harness.activeRuns.set(bot.threadId, [
          { status: "running", userMessageId: "message:typed" },
        ]);
        expect(yield* guard("t3_thread_update", { action: "settle" })).toBeUndefined();
        // Other chats are never guarded.
        expect(
          guardBotToolCall({ thread: { threadId: "chat-a" } } as never, "t3_thread_interrupt", {}),
        ).toBeNull();
      }),
    ),
  );

  it.effect("memory: add, edit and remove dated notes; turns see the newest", () =>
    withBots({ enabled: true, list: [savedBot()] }, (harness) =>
      Effect.gen(function* () {
        const bot = savedBot();
        const added = yield* harness.bots.memory(bot.threadId, {
          add: "Prefers updates before 9 AM.",
        });
        expect(added).toEqual([
          // The test clock starts at the epoch; the day is the local one, so west of UTC it is the 31st.
          {
            id: expect.any(String),
            at: expect.stringMatching(/^(1969-12-31|1970-01-01)$/),
            text: "Prefers updates before 9 AM.",
          },
        ]);
        const id = added[0]!.id;
        yield* harness.bots.memory(bot.threadId, { add: "x".repeat(400) });
        const edited = yield* harness.bots.memory(bot.threadId, {
          replace: { id, text: "Prefers updates before 8 AM." },
        });
        expect(edited[0]!.text).toBe("Prefers updates before 8 AM.");
        expect(edited[1]!.text).toHaveLength(300);
        expect(botInstructionsFor(bot.threadId)).toContain(
          `- ${edited[0]!.at}: Prefers updates before 8 AM.`,
        );
        yield* harness.bots.mutate({ type: "memory", botId: bot.id, remove: id });
        expect(botInstructionsFor(bot.threadId)).not.toContain("8 AM");
        const fromOtherChat = yield* harness.bots
          .memory(ThreadId.make("chat-a"), { add: "nope" })
          .pipe(Effect.flip);
        expect(fromOtherChat.reason).toBe("invalid");
      }),
    ),
  );

  it.effect(
    "two bots watching a chat: sender bot never wakes on its own message, and expired/deleted watches prune",
    () =>
      withBots(
        {
          enabled: true,
          list: [
            savedBot({ id: "bot-a", name: "Pip", threadId: ThreadId.make("thread:bot:bot-a") }),
            savedBot({ id: "bot-b", name: "Juno", threadId: ThreadId.make("thread:bot:bot-b") }),
          ],
        },
        (harness) =>
          Effect.gen(function* () {
            harness.shells.set("chat-shared", { title: "Shared work" });
            yield* harness.bots.watch(ThreadId.make("thread:bot:bot-a"), {
              threadIds: ["chat-shared"],
              events: ["message", "question"],
            });
            yield* harness.bots.watch(ThreadId.make("thread:bot:bot-b"), {
              threadIds: ["chat-shared"],
              events: ["message", "question"],
            });
            // Bot A sends a message to chat-shared, then a question flushes both bots deterministically:
            // Bot A must only receive the question (never its own message), while Bot B gets both.
            yield* Queue.offer(
              harness.events,
              event({
                type: "message.updated",
                threadId: "chat-shared",
                payload: {
                  id: "msg-from-a",
                  role: "user",
                  streaming: false,
                  senderThreadId: "thread:bot:bot-a",
                },
              }),
            );
            yield* Queue.offer(
              harness.events,
              event({
                type: "runtime-request.updated",
                threadId: "chat-shared",
                payload: { id: "req-flush", status: "pending" },
              }),
            );
            const firstWake = yield* Queue.take(harness.commands);
            const secondWake = yield* Queue.take(harness.commands);
            const byBot = new Map(
              [firstWake, secondWake].map((cmd) => [
                cmd.type === "message.dispatch" ? cmd.threadId : "",
                parseBotWake(wakeText(cmd))?.map((item) => item.kind === "event" && item.event),
              ]),
            );
            expect(byBot.get(ThreadId.make("thread:bot:bot-a"))).toEqual(["question"]);
            expect(byBot.get(ThreadId.make("thread:bot:bot-b"))).toEqual(["message", "question"]);
            expect(yield* Queue.size(harness.commands)).toBe(0);

            // Past until is rejected; an expired watch is pruned so it doesn't count against BOT_WATCH_MAX.
            const past = yield* harness.bots
              .watch(ThreadId.make("thread:bot:bot-a"), {
                threadIds: ["chat-shared"],
                until: DateTime.formatIso(DateTime.makeUnsafe(0)),
              })
              .pipe(Effect.flip);
            expect(past.reason).toBe("invalid");

            yield* harness.bots.unwatch(ThreadId.make("thread:bot:bot-a"), ["chat-shared"]);
            const futureUntil = DateTime.formatIso(DateTime.makeUnsafe(120_000));
            for (let i = 0; i < 20; i++) {
              harness.shells.set(`chat-exp-${i}`, { title: `Exp ${i}` });
            }
            yield* harness.bots.watch(ThreadId.make("thread:bot:bot-a"), {
              threadIds: Array.from({ length: 20 }, (_, i) => `chat-exp-${i}`),
              until: futureUntil,
            });
            // Advance past expiry and add a new watch: expired entries are pruned instead of hitting max.
            yield* TestClock.adjust("120 seconds");
            harness.shells.set("chat-fresh", { title: "Fresh" });
            const afterPrune = yield* harness.bots.watch(ThreadId.make("thread:bot:bot-a"), {
              threadIds: ["chat-fresh"],
            });
            expect(afterPrune.map((w) => w.threadId)).toEqual(["chat-fresh"]);

            // Deleting a watched chat prunes it from watches.
            yield* Queue.offer(
              harness.events,
              event({ type: "thread.deleted", threadId: "chat-fresh", payload: {} }),
            );
            const cleared = yield* harness.bots.subscribe().pipe(
              Stream.filter((s) => s.bots.find((b) => b.botId === "bot-a")?.watching.length === 0),
              Stream.runHead,
            );
            expect(cleared._tag).toBe("Some");
            const remaining = yield* harness.bots.unwatch(ThreadId.make("thread:bot:bot-a"), []);
            expect(remaining).toEqual([]);
          }),
      ),
  );

  it.effect(
    "stops retrying on permanent delivery errors, caps held items, and throttles urgent ping-pong loops",
    () =>
      withBots(
        { enabled: true, list: [savedBot()] },
        (harness) =>
          Effect.gen(function* () {
            harness.shells.set("chat-loop", { title: "Loop chat" });
            const res = yield* harness.bots.messageBot(ThreadId.make("chat-loop"), {
              text: "Urgent ping",
              urgent: true,
            });
            // Permanent failure must not claim "now" and must not retry forever every 2 min.
            expect(res).toEqual({ bot: "Pip", delivery: "held" });
            expect(yield* Queue.size(harness.commands)).toBe(1);
            yield* Queue.take(harness.commands);
            yield* TestClock.adjust("10 minutes");
            expect(yield* Queue.size(harness.commands)).toBe(0);
          }),
        undefined,
        {
          failDispatch: (command) =>
            command.type === "message.dispatch"
              ? { _tag: "ThreadManagementThreadNotFoundError" }
              : undefined,
        },
      ),
  );

  it.effect(
    "throttles rapid urgent message_bot calls from one chat and caps paused held queue",
    () =>
      withBots({ enabled: true, list: [savedBot()] }, (harness) =>
        Effect.gen(function* () {
          harness.shells.set("chat-a", { title: "Chat A" });
          harness.shells.set("chat-b", { title: "Chat B" });
          // First urgent call from Chat A wakes immediately; a second within 2m batches as "soon".
          expect(
            yield* harness.bots.messageBot(ThreadId.make("chat-a"), {
              text: "First",
              urgent: true,
            }),
          ).toEqual({ bot: "Pip", delivery: "now" });
          expect(yield* Queue.size(harness.commands)).toBe(1);
          yield* Queue.take(harness.commands);

          expect(
            yield* harness.bots.messageBot(ThreadId.make("chat-a"), {
              text: "Second",
              urgent: true,
            }),
          ).toEqual({ bot: "Pip", delivery: "soon" });
          expect(yield* Queue.size(harness.commands)).toBe(0);

          // A different chat can still send an urgent wake immediately.
          expect(
            yield* harness.bots.messageBot(ThreadId.make("chat-b"), {
              text: "Other",
              urgent: true,
            }),
          ).toEqual({ bot: "Pip", delivery: "now" });
          const combined = yield* Queue.take(harness.commands);
          expect(parseBotWake(wakeText(combined))).toHaveLength(2);

          // Paused bot caps held items at BOT_HELD_MAX.
          yield* harness.bots.mutate({ type: "pause", botId: "bot-fixed", paused: true });
          for (let i = 0; i < BotService.BOT_HELD_MAX + 15; i++) {
            yield* harness.bots.messageBot(ThreadId.make("chat-a"), { text: `msg-${i}` });
          }
          const state = yield* harness.bots.subscribe().pipe(Stream.runHead);
          expect(state._tag === "Some" && state.value.bots[0]?.waiting).toBe(
            BotService.BOT_HELD_MAX,
          );
        }),
      ),
  );

  it.effect("enforces answerQuestions and manageChats permissions on wake/routine turns", () =>
    withBots({ enabled: true, list: [savedBot()] }, (harness) =>
      Effect.gen(function* () {
        const bot = savedBot();
        const scope = { thread: { threadId: bot.threadId } } as never;
        const guard = (tool: string, payload: unknown) => guardBotToolCall(scope, tool, payload)!;
        // Default bot has answerQuestions: false: wake & routine turns cannot answer other chats' questions.
        harness.activeRuns.set(bot.threadId, [
          { status: "running", userMessageId: "message:bot:bot-fixed:9" },
        ]);
        expect(yield* guard("t3_pending_request_respond", { threadId: "chat-a" })).toContain(
          "Answering other chats' questions is off",
        );
        expect(yield* guard("t3_workflow_stop", {})).toContain("Ask the user first");
        expect(yield* guard("t3_thread_organize", { action: "archive" })).toContain(
          "Ask the user first",
        );
        harness.activeRuns.set(bot.threadId, [
          { status: "running", userMessageId: "scheduled-task-message:task-1:at" },
        ]);
        expect(yield* guard("t3_pending_request_respond", { threadId: "chat-a" })).toContain(
          "Answering other chats' questions is off",
        );
        // User-started turn may answer when asked.
        harness.activeRuns.set(bot.threadId, [
          { status: "running", userMessageId: "message:user-typed" },
        ]);
        expect(yield* guard("t3_pending_request_respond", { threadId: "chat-a" })).toBeUndefined();

        // Turning manageChats off blocks t3_workflow_stop, t3_thread_organize, and t3_queue too.
        yield* harness.bots.mutate({
          type: "update",
          botId: bot.id,
          permissions: { manageChats: false, answerQuestions: true },
        });
        expect(yield* guard("t3_workflow_stop", {})).toContain("Managing chats is off");
        expect(yield* guard("t3_thread_organize", { action: "pin" })).toContain(
          "Managing chats is off",
        );
        expect(yield* guard("t3_queue", { action: "cancel" })).toContain("Managing chats is off");
        // answerQuestions: true allows answering on a wake turn.
        harness.activeRuns.set(bot.threadId, [
          { status: "running", userMessageId: "message:bot:bot-fixed:10" },
        ]);
        expect(yield* guard("t3_pending_request_respond", { threadId: "chat-a" })).toBeUndefined();
      }),
    ),
  );

  it.effect("cleans up home thread and folder when saving a new bot fails", () =>
    withBots(
      { enabled: true },
      (harness) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const created = yield* harness.bots
            .mutate({ type: "create", name: "Rollback", color: "blue", target })
            .pipe(Effect.flip);
          expect(created.reason).toBe("write");
          const first = yield* Queue.take(harness.commands);
          const second = yield* Queue.take(harness.commands);
          expect(first.type).toBe("thread.create");
          expect(second).toMatchObject({
            type: "thread.delete",
            threadId: first.type === "thread.create" ? first.threadId : undefined,
          });
          const botsDir = path.join(harness.stateDir, "bots");
          const entries = (yield* fs.exists(botsDir)) ? yield* fs.readDirectory(botsDir) : [];
          expect(entries).toEqual([]);
        }),
      undefined,
      {
        failModifySettings: () => new Error("disk full"),
      },
    ),
  );

  it.effect("rejects invalid watch events and sending a deleted or self chat to a bot", () =>
    withBots({ enabled: true }, (harness) =>
      Effect.gen(function* () {
        const created = yield* harness.bots.mutate({
          type: "create",
          name: "Milo",
          color: "blue",
          target,
        });
        const bot = created.bot!;
        yield* Queue.take(harness.commands);
        harness.shells.set(ThreadId.make("chat-ok"), {
          id: ThreadId.make("chat-ok"),
          title: "Live",
          deletedAt: null,
        } as unknown as OrchestrationV2ThreadShell);
        harness.shells.set(ThreadId.make("chat-deleted"), {
          id: ThreadId.make("chat-deleted"),
          title: "Gone",
          deletedAt: DateTime.makeUnsafe(1_000),
        } as unknown as OrchestrationV2ThreadShell);

        const badEvents = yield* harness.bots
          .watch(bot.threadId, {
            threadIds: ["chat-ok"],
            events: ["unknown" as never],
          })
          .pipe(Effect.flip);
        expect(badEvents.reason).toBe("invalid");

        const sendDeleted = yield* harness.bots
          .mutate({
            type: "send",
            botId: bot.id,
            threadId: ThreadId.make("chat-deleted"),
          })
          .pipe(Effect.flip);
        expect(sendDeleted.reason).toBe("notFound");

        const sendSelf = yield* harness.bots
          .mutate({
            type: "send",
            botId: bot.id,
            threadId: bot.threadId,
          })
          .pipe(Effect.flip);
        expect(sendSelf.reason).toBe("invalid");
      }),
    ),
  );
});
