/**
 * Side chats: the harness's own side conversation over a thread (Claude Code
 * `/btw`, Codex `/side`, or a seeded side session where the harness's protocol
 * has none, as with Antigravity). Their lifetime belongs to the server, not a
 * socket or sheet. Snapshots live in a separate file, outside the thread
 * transcript and shared settings schema, so Nightly never consumes them.
 */
import {
  SideChatError,
  SideChatId,
  sideChatKindForDriver,
  type SideChatActivity,
  type SideChatMessage,
  type SideChatOpenInput,
  type SideChatRefInput,
  type SideChatSendInput,
  SideChatState,
  type SideChatSubscribeInput,
  type SideChatStreamValue,
  type ThreadId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { handoffMessage } from "@t3tools/provider-core/server/handoffBudget";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../config.ts";

/** Streaming answers publish at most this often; a finished answer publishes at once. */
const PUBLISH_INTERVAL = Duration.millis(80);
/**
 * A side question must settle even if a harness control request never responds, but an answer
 * that is still streaming may take as long as it needs: only this long without progress fails it.
 */
const ANSWER_STALL_TIMEOUT_MS = 2 * 60 * 1000;
const STALL_CHECK_INTERVAL = Duration.seconds(5);
/** A side chat nobody has used for this long is closed. */
const IDLE_CLOSE_AFTER_MS = 30 * 60 * 1000;
const MAX_OPEN_SIDE_CHATS = 16;
/** Keep recovered exchanges after releasing the harness, bounded in time and count. */
const HISTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SAVED_SIDE_CHATS = 128;
const SavedSideChat = Schema.Struct({ state: SideChatState, lastUsedAt: Schema.Number });
const sideChatsJson = Schema.fromJsonString(
  Schema.Struct({ version: Schema.Literal(1), chats: Schema.Array(SavedSideChat) }),
);

const decodeSideChats = Schema.decodeEffect(sideChatsJson);
const encodeSideChats = Schema.encodeEffect(sideChatsJson);

export interface SideChatServiceShape {
  readonly open: (input: SideChatOpenInput) => Effect.Effect<SideChatState, SideChatError>;
  readonly send: (input: SideChatSendInput) => Effect.Effect<void, SideChatError>;
  readonly close: (input: SideChatRefInput) => Effect.Effect<void, SideChatError>;
  readonly subscribe: (
    input: SideChatSubscribeInput,
  ) => Stream.Stream<SideChatState | null, SideChatError>;
}

export class SideChatService extends Context.Service<SideChatService, SideChatServiceShape>()(
  "t3/sideChat/SideChatService",
) {}

interface SideChatEntry {
  scope: Scope.Closeable;
  providerInstanceId: ProviderInstanceId;
  nativeThreadId: string;
  /** Latest state; published to subscribers at most every PUBLISH_INTERVAL while streaming. */
  state: SideChatState;
  chat: ProviderAdapter.ProviderAdapterV2SideChat | null;
  running: Fiber.Fiber<void> | null;
  publishScheduled: boolean;
  generation: number;
  lastUsedAt: number;
}

const failed = (reason: SideChatError["reason"], detail?: string) =>
  new SideChatError({ reason, ...(detail === undefined ? {} : { detail }) });

const errorText = (cause: unknown): string => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message: unknown }).message;
    if (typeof message === "string" && message.length > 0) return message;
  }
  return "The side chat failed.";
};

/** Send an append only when every other part of the previous snapshot is unchanged. */
export function sideChatTextPatches<E, R>(stream: Stream.Stream<SideChatState | null, E, R>) {
  return Stream.suspend(() => {
    let previous: SideChatState | null = null;
    return stream.pipe(
      Stream.map((state): SideChatStreamValue => {
        const prior = previous;
        previous = state;
        if (
          state === null ||
          prior === null ||
          state.sideChatId !== prior.sideChatId ||
          state.threadId !== prior.threadId ||
          state.kind !== prior.kind ||
          state.status !== prior.status ||
          state.error !== prior.error ||
          state.messages.length !== prior.messages.length
        )
          return state;
        const lastIndex = state.messages.length - 1;
        const before = prior.messages[lastIndex];
        const after = state.messages[lastIndex];
        if (
          before === undefined ||
          after === undefined ||
          after.role !== "assistant" ||
          before.id !== after.id ||
          before.role !== after.role ||
          before.status !== after.status ||
          before.activities !== after.activities ||
          !after.text.startsWith(before.text) ||
          after.text.length === before.text.length ||
          state.messages
            .slice(0, lastIndex)
            .some((message, index) => message !== prior.messages[index])
        )
          return state;
        return {
          kind: "text-append",
          sideChatId: state.sideChatId,
          messageId: after.id,
          previousLength: before.text.length,
          text: after.text.slice(before.text.length),
        };
      }),
    );
  });
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const runtimePolicies = yield* RuntimePolicy.RuntimePolicyV2;
  const crypto = yield* Crypto.Crypto;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const filePath = path.join(config.stateDir, "side-chats.json");
  const serviceScope = yield* Effect.scope;
  const entries = new Map<SideChatId, SideChatEntry>();
  const admission = yield* Semaphore.make(1);
  const saveLock = yield* Semaphore.make(1);
  const publishLock = yield* Semaphore.make(1);
  const saved = new Map<ThreadId, typeof SavedSideChat.Type>();
  const initial = yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeSideChats),
    Effect.catchIf(
      (cause) => cause._tag === "PlatformError" && cause.reason._tag === "NotFound",
      () => Effect.succeed({ version: 1 as const, chats: [] }),
    ),
    Effect.catch((cause) =>
      Effect.logWarning("Could not restore side chats.", { cause }).pipe(
        Effect.as({ version: 1 as const, chats: [] }),
      ),
    ),
  );
  const now = yield* Clock.currentTimeMillis;
  for (const chat of initial.chats.slice(-MAX_SAVED_SIDE_CHATS)) {
    if (now - chat.lastUsedAt >= HISTORY_TTL_MS) continue;
    const interrupted = chat.state.status === "starting" || chat.state.status === "running";
    saved.set(chat.state.threadId, {
      ...chat,
      state: {
        ...chat.state,
        status: "closed",
        messages: chat.state.messages.map((message) =>
          message.status === "streaming" ? { ...message, status: "failed" as const } : message,
        ),
        error: interrupted
          ? "The server restarted before this answer finished. Ask again to retry."
          : chat.state.error,
      },
    });
  }
  const snapshots = yield* SubscriptionRef.make<ReadonlyMap<ThreadId, SideChatState>>(
    new Map([...saved].map(([id, chat]) => [id, chat.state])),
  );

  const save = saveLock
    .withPermit(
      Effect.gen(function* () {
        const contents = yield* encodeSideChats({
          version: 1,
          chats: [...saved.values()],
        });
        yield* writeFileStringAtomically({ filePath, contents: `${contents}\n` }).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      }),
    )
    .pipe(
      Effect.catch((cause) => Effect.logWarning("Could not save side chats.", { cause })),
      Effect.uninterruptible,
    );

  const newId = crypto.randomUUIDv4().pipe(Effect.orDie);

  const publishNow = (entry: SideChatEntry, persist = false) =>
    publishLock.withPermit(
      Effect.gen(function* () {
        const state = entry.state;
        saved.delete(state.threadId);
        saved.set(state.threadId, { state, lastUsedAt: entry.lastUsedAt });
        while (saved.size > MAX_SAVED_SIDE_CHATS) {
          const oldest = [...saved].find(([, chat]) => !entries.has(chat.state.sideChatId));
          if (oldest === undefined) break;
          saved.delete(oldest[0]);
        }
        if (persist) yield* save;
        // Each emission is a whole snapshot; clients replace it instead of appending deltas.
        yield* SubscriptionRef.set(
          snapshots,
          new Map([...saved].map(([id, chat]) => [id, chat.state])),
        );
      }),
    );

  /** Applies a change; streaming changes are batched, settled ones go out immediately. */
  const update = (
    entry: SideChatEntry,
    change: (state: SideChatState) => SideChatState,
    options: { readonly immediate?: boolean } = {},
  ) =>
    Effect.gen(function* () {
      entry.state = change(entry.state);
      if (options.immediate === true) return yield* publishNow(entry, true);
      if (entry.publishScheduled) return;
      entry.publishScheduled = true;
      yield* Effect.sleep(PUBLISH_INTERVAL).pipe(
        Effect.andThen(
          Effect.suspend(() => {
            entry.publishScheduled = false;
            return publishNow(entry);
          }),
        ),
        Effect.forkIn(entry.scope),
      );
    });

  const updateLastAssistant = (
    entry: SideChatEntry,
    change: (message: SideChatMessage) => SideChatMessage,
    options?: { readonly immediate?: boolean },
  ) =>
    update(
      entry,
      (state) => {
        const index = state.messages.findLastIndex((message) => message.role === "assistant");
        if (index < 0) return state;
        const messages = [...state.messages];
        messages[index] = change(messages[index]!);
        return { ...state, messages };
      },
      options,
    );

  const upsertActivity = (activities: ReadonlyArray<SideChatActivity>, next: SideChatActivity) => {
    const index = activities.findIndex((activity) => activity.id === next.id);
    if (index < 0) return [...activities, next];
    const updated = [...activities];
    updated[index] = next;
    return updated;
  };

  const closeEntry = (sideChatId: SideChatId, entry: SideChatEntry) =>
    Effect.gen(function* () {
      if (entries.get(sideChatId) !== entry) return;
      entries.delete(sideChatId);
      if (entry.running !== null) yield* Fiber.interrupt(entry.running);
      yield* Scope.close(entry.scope, Exit.void);
      yield* update(
        entry,
        (state) => ({
          ...state,
          status: "closed",
          messages: state.messages.map((message) =>
            message.status === "streaming" ? { ...message, status: "failed" } : message,
          ),
        }),
        { immediate: true },
      );
    });

  /** Runs one message: the user's line, then the harness's answer as it streams. */
  const ask = (
    entry: SideChatEntry,
    prompt: string,
    generation: number,
    openChat: Effect.Effect<
      ProviderAdapter.ProviderAdapterV2SideChat,
      ProviderAdapter.ProviderAdapterV2Error
    >,
  ) =>
    Effect.gen(function* () {
      let lastProgressAt = yield* Clock.currentTimeMillis;
      const progressed = Clock.currentTimeMillis.pipe(
        Effect.map((now) => {
          lastProgressAt = now;
        }),
      );
      const answer = Effect.gen(function* () {
        const chat = entry.chat ?? (yield* openChat);
        entry.chat = chat;
        yield* update(entry, (state) => ({ ...state, status: "running" }), { immediate: true });
        return yield* chat.ask({
          prompt,
          onUpdate: (event) =>
            (event.type === "text"
              ? updateLastAssistant(entry, (message) => ({ ...message, text: event.text }))
              : updateLastAssistant(entry, (message) => ({
                  ...message,
                  activities: upsertActivity(message.activities, event.activity),
                }))
            ).pipe(Effect.andThen(progressed)),
        });
      });
      const stalled = Effect.gen(function* () {
        while (true) {
          yield* Effect.sleep(STALL_CHECK_INTERVAL);
          if ((yield* Clock.currentTimeMillis) - lastProgressAt >= ANSWER_STALL_TIMEOUT_MS) {
            return yield* Effect.fail(
              failed(
                "failed",
                "The side answer timed out with no progress for 2 minutes. Try again.",
              ),
            );
          }
        }
      });
      const response = yield* Effect.raceFirst(answer, stalled);
      yield* updateLastAssistant(
        entry,
        (message) => ({ ...message, text: response || message.text, status: "complete" }),
        { immediate: true },
      );
      entry.lastUsedAt = yield* Clock.currentTimeMillis;
      entry.running = null;
      yield* update(entry, (state) => ({ ...state, status: "idle", error: null }), {
        immediate: true,
      });
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterrupts(cause)) return Effect.void;
        entry.running = null;
        // Retry opens a fresh side harness. Never interrupt the main thread's runtime.
        entry.chat = null;
        const message = errorText(Cause.squash(cause));
        return updateLastAssistant(entry, (current) => ({
          ...current,
          status: "failed",
          activities: current.activities.map((activity) =>
            activity.status === "running" ? { ...activity, status: "failed" } : activity,
          ),
        })).pipe(
          Effect.andThen(
            update(
              entry,
              (state) => ({
                ...state,
                status: "failed",
                error: message,
              }),
              { immediate: true },
            ),
          ),
        );
      }),
      Effect.ensuring(
        Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            if (entry.generation === generation) {
              entry.running = null;
              entry.lastUsedAt = now;
            }
          }),
        ),
      ),
    );

  const appendExchange = (entry: SideChatEntry, prompt: string, messageId?: string) =>
    Effect.gen(function* () {
      const userId = messageId ?? (yield* newId);
      const assistantId = yield* newId;
      yield* update(
        entry,
        (state) => ({
          ...state,
          error: null,
          status: "starting",
          messages: [
            ...state.messages,
            { id: userId, role: "user", text: prompt, status: "complete", activities: [] },
            { id: assistantId, role: "assistant", text: "", status: "streaming", activities: [] },
          ],
        }),
        { immediate: true },
      );
    });

  const resolveThread = Effect.fn("SideChatService.resolveThread")(function* (
    input: SideChatOpenInput,
  ) {
    const records = yield* threads
      .getThreadRecords(input.threadId, ["providerThreads"])
      .pipe(Effect.mapError((cause) => failed("failed", errorText(cause))));
    const thread = records.thread;
    let providerThread =
      records.providerThreads.find((candidate) => candidate.id === thread.activeProviderThreadId) ??
      records.providerThreads.at(-1);
    if (providerThread === undefined || providerThread.nativeThreadRef?.nativeId == null) {
      return yield* failed("no-provider-session");
    }
    // A hand-picked compatible account can be staged before the next main turn
    // rebinds its native row. Side questions already belong to that account.
    if (providerThread.providerInstanceId !== thread.modelSelection.instanceId) {
      if (adapters.getMetadata === undefined) return yield* failed("no-provider-session");
      const source = yield* adapters
        .getMetadata(providerThread.providerInstanceId)
        .pipe(Effect.mapError(() => failed("no-provider-session")));
      const target = yield* adapters
        .getMetadata(thread.modelSelection.instanceId)
        .pipe(Effect.mapError(() => failed("no-provider-session")));
      if (
        source.driver !== target.driver ||
        source.continuationKey.length === 0 ||
        source.continuationKey !== target.continuationKey
      )
        return yield* failed("no-provider-session");
      providerThread = {
        ...providerThread,
        providerInstanceId: thread.modelSelection.instanceId,
        providerSessionId: null,
      };
    }
    const adapter = yield* adapters
      .get(providerThread.providerInstanceId)
      .pipe(Effect.mapError(() => failed("unsupported-provider")));
    const kind = sideChatKindForDriver(adapter.driver);
    if (kind === null || adapter.openSideChat === undefined) {
      return yield* failed("unsupported-provider");
    }
    const runtimePolicy = yield* runtimePolicies
      .resolve({ thread, modelSelection: thread.modelSelection })
      .pipe(Effect.mapError((cause) => failed("failed", errorText(cause))));
    const boundProviderThread = providerThread;
    const liveRuntimeFor = (row: typeof boundProviderThread) =>
      row.providerSessionId === null
        ? Effect.succeed(undefined)
        : providerSessions.get(row.providerSessionId).pipe(
            Effect.map((runtime) =>
              Option.isSome(runtime) && runtime.value.instanceId === adapter.instanceId
                ? runtime.value
                : undefined,
            ),
            Effect.orElseSucceed(() => undefined),
          );
    const liveRuntime = yield* liveRuntimeFor(providerThread);
    // Re-read per question. Admission reopens the side harness when its owner
    // changes; a switch racing this read must not reach the old adapter.
    const current = Effect.suspend(() =>
      threads.getThreadRecords(input.threadId, ["providerThreads"]),
    ).pipe(
      Effect.flatMap((latest) =>
        Effect.gen(function* () {
          if (latest.thread.modelSelection.instanceId !== adapter.instanceId) {
            return yield* failed("no-provider-session");
          }
          const stored =
            latest.providerThreads.find((candidate) => candidate.id === boundProviderThread.id) ??
            boundProviderThread;
          const row =
            stored.providerInstanceId === adapter.instanceId
              ? stored
              : {
                  ...stored,
                  providerInstanceId: adapter.instanceId,
                  providerSessionId: null,
                };
          const policy = yield* runtimePolicies.resolve({
            thread: latest.thread,
            modelSelection: latest.thread.modelSelection,
          });
          const runtime = yield* liveRuntimeFor(row);
          return {
            providerThread: row,
            modelSelection: latest.thread.modelSelection,
            runtimePolicy: policy,
            ...(runtime === undefined ? {} : { liveRuntime: runtime }),
          } satisfies ProviderAdapter.ProviderAdapterV2SideChatCurrent;
        }),
      ),
      Effect.mapError(
        (cause) =>
          new ProviderAdapter.ProviderAdapterProtocolError({
            driver: adapter.driver,
            detail: "Could not refresh the side chat's thread settings.",
            cause,
          }),
      ),
    );
    // Read only by harnesses that seed a side session with it, once per question.
    const transcript = Effect.suspend(() =>
      threads.getThreadRecords(input.threadId, ["turnItems"]),
    ).pipe(
      Effect.map(({ turnItems }) =>
        turnItems.flatMap((item) => {
          const message = handoffMessage(item);
          return message === null ? [] : [message];
        }),
      ),
      Effect.mapError(
        (cause) =>
          new ProviderAdapter.ProviderAdapterProtocolError({
            driver: adapter.driver,
            detail: "Could not read the thread's transcript for the side chat.",
            cause,
          }),
      ),
    );
    return {
      kind,
      openSideChat: adapter.openSideChat,
      input: {
        threadId: input.threadId,
        providerThread,
        modelSelection: thread.modelSelection,
        runtimePolicy,
        ...(liveRuntime === undefined ? {} : { liveRuntime }),
        current,
        transcript,
      } satisfies ProviderAdapter.ProviderAdapterV2SideChatInput,
    };
  });

  const chatForEntry = Effect.fnUntraced(function* (
    entry: SideChatEntry,
    resolved: Effect.Success<ReturnType<typeof resolveThread>>,
  ) {
    const providerInstanceId = resolved.input.providerThread.providerInstanceId;
    const nativeThreadId = resolved.input.providerThread.nativeThreadRef!.nativeId!;
    if (
      entry.providerInstanceId !== providerInstanceId ||
      entry.nativeThreadId !== nativeThreadId
    ) {
      // Keep the sheet and its history; release the old account's process before
      // opening the new adapter, including Claude's fallback fork/environment.
      yield* Scope.close(entry.scope, Exit.void);
      entry.scope = yield* Scope.fork(serviceScope);
      entry.providerInstanceId = providerInstanceId;
      entry.nativeThreadId = nativeThreadId;
      entry.chat = null;
      entry.publishScheduled = false;
    }
    return {
      openChat:
        entry.chat === null
          ? resolved.openSideChat(resolved.input).pipe(Scope.provide(entry.scope))
          : Effect.succeed(entry.chat),
    };
  });

  // Admission is atomic even when the RPC loses its socket between saving the
  // question and forking the answer. The provider fiber is interruptible only
  // by its server-owned session scope (explicit close, TTL, or shutdown).
  const sendToEntry = Effect.fnUntraced(function* (
    entry: SideChatEntry,
    input: { readonly prompt: string; readonly messageId?: string | undefined },
    openChat: Effect.Effect<
      ProviderAdapter.ProviderAdapterV2SideChat,
      ProviderAdapter.ProviderAdapterV2Error
    >,
  ) {
    if (
      input.messageId !== undefined &&
      entry.state.messages.some((message) => message.id === input.messageId)
    )
      return;
    if (entry.running !== null) return yield* failed("busy");
    entry.lastUsedAt = yield* Clock.currentTimeMillis;
    yield* appendExchange(entry, input.prompt, input.messageId);
    entry.running = yield* ask(entry, input.prompt, ++entry.generation, openChat).pipe(
      Effect.forkIn(entry.scope, { startImmediately: false, uninterruptible: false }),
    );
  });

  const open: SideChatServiceShape["open"] = Effect.fn("SideChatService.open")(function* (input) {
    return yield* admission
      .withPermit(
        Effect.gen(function* () {
          const previous = saved.get(input.threadId)?.state;
          if (
            input.messageId !== undefined &&
            previous?.messages.some((message) => message.id === input.messageId)
          )
            return previous;
          const existing = previous === undefined ? undefined : entries.get(previous.sideChatId);
          if (existing !== undefined && existing.running !== null) return yield* failed("busy");
          const resolved = yield* resolveThread(input);
          if (existing !== undefined && existing.chat !== null) {
            const { openChat } = yield* chatForEntry(existing, resolved);
            yield* sendToEntry(existing, input, openChat);
            return existing.state;
          }
          if (existing !== undefined) yield* closeEntry(existing.state.sideChatId, existing);
          while (entries.size >= MAX_OPEN_SIDE_CHATS) {
            const oldest = [...entries].find(([, entry]) => entry.running === null);
            if (oldest === undefined) return yield* failed("busy");
            yield* closeEntry(oldest[0], oldest[1]);
          }
          const sideChatId = SideChatId.make(yield* newId);
          const initial: SideChatState = {
            sideChatId,
            threadId: input.threadId,
            kind: resolved.kind,
            status: "starting",
            messages: previous?.messages ?? [],
            error: null,
          };
          const entry: SideChatEntry = {
            scope: yield* Scope.fork(serviceScope),
            providerInstanceId: resolved.input.providerThread.providerInstanceId,
            nativeThreadId: resolved.input.providerThread.nativeThreadRef!.nativeId!,
            state: initial,
            chat: null,
            running: null,
            publishScheduled: false,
            generation: 0,
            lastUsedAt: yield* Clock.currentTimeMillis,
          };
          entries.set(sideChatId, entry);
          const openChat = resolved.openSideChat(resolved.input).pipe(Scope.provide(entry.scope));
          yield* sendToEntry(entry, input, openChat);
          return entry.state;
        }),
      )
      .pipe(Effect.uninterruptible);
  });

  const send: SideChatServiceShape["send"] = Effect.fn("SideChatService.send")(function* (input) {
    yield* admission
      .withPermit(
        Effect.gen(function* () {
          const entry = entries.get(input.sideChatId);
          if (entry === undefined) return yield* failed("not-found");
          if (entry.chat === null) {
            if (
              input.messageId !== undefined &&
              entry.state.messages.some((message) => message.id === input.messageId)
            )
              return;
            return yield* failed("busy");
          }
          if (
            input.messageId !== undefined &&
            entry.state.messages.some((message) => message.id === input.messageId)
          )
            return;
          if (entry.running !== null) return yield* failed("busy");
          const resolved = yield* resolveThread({
            threadId: entry.state.threadId,
            prompt: input.prompt,
          });
          const { openChat } = yield* chatForEntry(entry, resolved);
          yield* sendToEntry(entry, input, openChat);
        }),
      )
      .pipe(Effect.uninterruptible);
  });

  const close: SideChatServiceShape["close"] = Effect.fn("SideChatService.close")(
    function* (input) {
      yield* admission
        .withPermit(
          Effect.gen(function* () {
            const entry = entries.get(input.sideChatId);
            if (entry !== undefined) yield* closeEntry(input.sideChatId, entry);
          }),
        )
        .pipe(Effect.uninterruptible);
    },
  );

  const subscribe: SideChatServiceShape["subscribe"] = (input) =>
    Stream.suspend(() => {
      if ("threadId" in input) {
        return SubscriptionRef.changes(snapshots).pipe(
          Stream.map((states) => states.get(input.threadId) ?? null),
          Stream.changes,
        );
      }
      const archived = [...saved.values()].find(
        (chat) => chat.state.sideChatId === input.sideChatId,
      );
      if (archived === undefined) return Stream.fail(failed("not-found"));
      return SubscriptionRef.changes(snapshots).pipe(
        Stream.map((states) => {
          const state = states.get(archived.state.threadId);
          return state?.sideChatId === input.sideChatId
            ? state
            : { ...archived.state, status: "closed" as const };
        }),
        Stream.changes,
        Stream.takeUntil((state) => state.status === "closed"),
      );
    });

  // Release idle harnesses without throwing their answers away. Reading a sheet
  // does not keep a process alive forever, and active answers are never evicted.
  yield* admission
    .withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const [sideChatId, entry] of entries) {
          if (entry.running === null && now - entry.lastUsedAt >= IDLE_CLOSE_AFTER_MS) {
            yield* closeEntry(sideChatId, entry);
          }
        }
        let expired = false;
        for (const [threadId, chat] of saved) {
          if (!entries.has(chat.state.sideChatId) && now - chat.lastUsedAt >= HISTORY_TTL_MS) {
            saved.delete(threadId);
            expired = true;
          }
        }
        if (expired) {
          yield* SubscriptionRef.set(
            snapshots,
            new Map([...saved].map(([id, chat]) => [id, chat.state])),
          );
          yield* save;
        }
      }),
    )
    .pipe(Effect.repeat(Schedule.spaced("5 minutes")), Effect.forkIn(serviceScope));

  yield* Effect.addFinalizer(() =>
    Effect.forEach([...entries], ([sideChatId, entry]) => closeEntry(sideChatId, entry), {
      discard: true,
    }),
  );

  return SideChatService.of({ open, send, close, subscribe });
});

export const layer = Layer.effect(SideChatService, make);
