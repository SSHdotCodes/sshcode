import type {
  ProviderSessionKeepWarm,
  ProviderSessionKeepWarmUsage,
} from "@t3tools/provider-core/server/ProviderAdapter";
import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

const INTERVAL_MS = 50 * 60_000;
const LATEST_SEND_MS = 57 * 60_000;
const RELEASE_AFTER_MS = 30 * 60_000;
const MIN_CONTEXT_TOKENS = 100_000;
const CACHE_TTL_MS = 60 * 60_000;
/** Idle chats kept warm at once, the largest contexts first. */
export const CLAUDE_KEEP_WARM_MAX_CHATS = 6;

/** A ping that rewrote most of the prefix found it cold. Tiny tail writes are normal. */
const isColdPing = (
  usage: Pick<ProviderSessionKeepWarmUsage, "cacheReadTokens" | "cacheWriteTokens">,
  context: number,
) => usage.cacheWriteTokens >= Math.max(10_000, context / 2) || usage.cacheReadTokens < context / 2;

/** An idle chat whose Claude process a server restart ended while its cache was still warm. */
export interface ClaudeKeepWarmRestoredChat {
  readonly threadId: ThreadId;
  readonly contextTokens: number;
  /** The last cache touch: the turn's last model request, or a later ping. */
  readonly touchedAtMs: number;
  /** Pings already sent since that turn. */
  readonly pings: number;
}

/**
 * Chats to keep warm after a restart, from each chat's last completed turn and the pings
 * logged since it. A ping moves the cache touch. A cold ping, or a second one, ends the stretch
 * as it does live, and an expired cache is never pinged.
 */
export function claudeKeepWarmRestoredChats(input: {
  readonly turns: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly contextTokens: number;
    readonly cacheTtlMs: number | null;
    readonly touchedAtMs: number;
  }>;
  readonly pings: ReadonlyArray<{
    readonly threadId: string;
    readonly atMs: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  }>;
  readonly now: number;
}): ReadonlyArray<ClaudeKeepWarmRestoredChat> {
  const chats: Array<ClaudeKeepWarmRestoredChat> = [];
  for (const turn of input.turns) {
    if (turn.contextTokens < MIN_CONTEXT_TOKENS || turn.cacheTtlMs !== CACHE_TTL_MS) continue;
    // One ping can log a row per model; together they are one send.
    const pings = new Map<number, { cacheReadTokens: number; cacheWriteTokens: number }>();
    for (const row of input.pings) {
      if (row.threadId !== turn.threadId || row.atMs <= turn.touchedAtMs) continue;
      const ping = pings.get(row.atMs) ?? { cacheReadTokens: 0, cacheWriteTokens: 0 };
      ping.cacheReadTokens += row.cacheReadTokens;
      ping.cacheWriteTokens += row.cacheWriteTokens;
      pings.set(row.atMs, ping);
    }
    if (pings.size >= 2) continue;
    if ([...pings.values()].some((ping) => isColdPing(ping, turn.contextTokens))) continue;
    const touchedAtMs = Math.max(turn.touchedAtMs, ...pings.keys());
    if (input.now - touchedAtMs > LATEST_SEND_MS || input.now < touchedAtMs) continue;
    chats.push({
      threadId: turn.threadId,
      contextTokens: turn.contextTokens,
      touchedAtMs,
      pings: pings.size,
    });
  }
  return chats;
}

type WarmThread = Pick<
  OrchestrationV2ThreadShell,
  | "deletedAt"
  | "archivedAt"
  | "settledAt"
  | "settledOverride"
  | "snoozedAt"
  | "snoozedUntil"
  | "status"
  | "lineage"
>;
const ACTIVE_STATUSES = new Set(["queued", "preparing", "starting", "running", "waiting"]);

/**
 * Why a chat should not be kept warm, from its projection. Work SSHCode runs outside the Claude
 * process (subagents, monitors) does not count: a chat waiting on it is the one most sure to
 * come back, often after more than the cache's hour. Work inside the Claude process is the
 * adapter's `idle` check.
 */
export function claudeKeepWarmThreadSkipReason(
  thread: WarmThread | null,
  parent: Pick<WarmThread, "status"> | null = null,
): string | null {
  if (thread === null || thread.deletedAt !== null) return "removed";
  if (thread.archivedAt !== null) return "archived";
  if (thread.settledAt !== null || thread.settledOverride === "settled") return "settled";
  if (thread.snoozedAt != null || thread.snoozedUntil != null) return "snoozed";
  // Before the chat's own status: a chat whose turn just ended can still read as running.
  if (
    thread.lineage.relationshipToParent === "subagent" &&
    (parent === null || !ACTIVE_STATUSES.has(parent.status))
  )
    return "parent_finished";
  // A question still open once the turn ended is answered by a message, so the process is
  // idle and the user is all but sure to come back; one that holds a turn reads as active.
  if (ACTIVE_STATUSES.has(thread.status)) return "active_turn";
  return null;
}

export class ClaudeKeepWarmSkip extends Schema.TaggedError<ClaudeKeepWarmSkip>()(
  "ClaudeKeepWarmSkip",
  { reason: Schema.Literals(["expired", "weekly_limit", "usage_unavailable"]) },
) {}
const isKeepWarmSkip = Schema.is(ClaudeKeepWarmSkip);

export class ClaudeKeepWarm extends Context.Service<
  ClaudeKeepWarm,
  ProviderSessionKeepWarm & {
    /**
     * Holds restored chats in the shared cap without starting anything. When one is due,
     * `wake` opens its session idle (or returns why not) and the ping runs through it.
     */
    readonly restore: (
      chats: ReadonlyArray<ClaudeKeepWarmRestoredChat>,
      wake: (threadId: ThreadId) => Effect.Effect<string | null, Error>,
    ) => Effect.Effect<void>;
    readonly counters: Effect.Effect<{
      readonly sent: number;
      readonly skipped: Readonly<Record<string, number>>;
      readonly tokensRead: number;
      readonly cold: number;
    }>;
  }
>()("t3/orchestration-v2/ClaudeKeepWarm") {}

/** One coordinator per environment, shared by all Claude provider instances. */
export const make = Effect.fn("ClaudeKeepWarm.make")(function* (options: {
  readonly now?: Effect.Effect<number>;
  readonly enabled: Effect.Effect<boolean>;
  readonly changes: Stream.Stream<boolean>;
  readonly eligible: (threadId: ThreadId) => Effect.Effect<string | null>;
  readonly record: (
    threadId: ThreadId,
    usage: ProviderSessionKeepWarmUsage,
    atMs: number,
  ) => Effect.Effect<void, Error>;
}) {
  const now = options.now ?? Clock.currentTimeMillis;
  const coordinatorScope = yield* Effect.scope;
  interface Entry {
    readonly threadId: ThreadId;
    context: number;
    deadline: () => number;
    end: (reason: string) => void;
  }
  const entries = new Set<Entry>();
  // A restored chat waits here, with no session, until its ping is due.
  const restored = new Map<ThreadId, Entry>();
  // The newest session handle per chat, which a due restored chat pings through.
  const handles = new Map<
    ThreadId,
    { adopt: (chat: ClaudeKeepWarmRestoredChat) => Effect.Effect<void> }
  >();
  const counters = { sent: 0, skipped: {} as Record<string, number>, tokensRead: 0, cold: 0 };
  const skip = (reason: string) => {
    counters.skipped[reason] = (counters.skipped[reason] ?? 0) + 1;
  };
  /**
   * Live and restored entries share one cap: the largest contexts win. Over the cap, a chat
   * that can no longer be pinged (a subagent whose parent finished, a settled chat) gives up
   * its slot first, or it would push out a chat that will be pinged. `active_turn` is left to
   * the ping-time check: a chat whose turn just ended can still read as running, and a real
   * turn ends its own entry anyway.
   */
  const admit = Effect.fnUntraced(function* (admitted: Entry, at: number) {
    entries.add(admitted);
    for (const candidate of entries) if (candidate.deadline() <= at) candidate.end("complete");
    if (entries.size > CLAUDE_KEEP_WARM_MAX_CHATS)
      for (const candidate of entries) {
        const blocked = yield* options.eligible(candidate.threadId);
        if (blocked !== null && blocked !== "active_turn") candidate.end(blocked);
      }
    for (const excess of [...entries]
      .sort((a, b) => b.context - a.context)
      .slice(CLAUDE_KEEP_WARM_MAX_CHATS))
      excess.end("capacity");
  });

  yield* options.changes.pipe(
    Stream.runForEach((enabled) =>
      Effect.sync(() => {
        if (!enabled) for (const entry of entries) entry.end("setting_off");
      }),
    ),
    Effect.forkScoped,
  );

  return ClaudeKeepWarm.of({
    counters: Effect.sync(() => ({ ...counters, skipped: { ...counters.skipped } })),
    restore: Effect.fnUntraced(function* (chats, wake) {
      if (!(yield* options.enabled)) return;
      for (const chat of chats) {
        // A session opened since the restart owns this chat's keep-warm.
        if (handles.has(chat.threadId) || restored.has(chat.threadId)) continue;
        // No turn is mid-flight at startup, so the skip reasons hold now; a skipped chat must
        // not take a slot from one that will be pinged.
        const blocked = yield* options.eligible(chat.threadId);
        if (blocked !== null) {
          skip(blocked);
          continue;
        }
        let live = true;
        let waking = false;
        let timer: Fiber.Fiber<void> | undefined;
        const placeholder: Entry = {
          threadId: chat.threadId,
          context: chat.contextTokens,
          deadline: () => chat.touchedAtMs + LATEST_SEND_MS,
          end: (reason: string) => {
            if (!live) return;
            live = false;
            entries.delete(placeholder);
            if (restored.get(chat.threadId) === placeholder) restored.delete(chat.threadId);
            if (reason !== "complete" && reason !== "real_turn" && reason !== "adopted")
              skip(reason);
            // An open in progress finishes; the real turn it raced reuses its process.
            if (!waking) timer?.interruptUnsafe();
            timer = undefined;
          },
        };
        const due = Effect.gen(function* () {
          yield* Effect.sleep(Math.max(0, chat.touchedAtMs + INTERVAL_MS - (yield* now)));
          if (!live) return;
          timer = undefined;
          const blocked = (yield* options.enabled)
            ? yield* options.eligible(chat.threadId)
            : "setting_off";
          if (!live) return;
          if (blocked !== null) return placeholder.end(blocked);
          const at = yield* now;
          if (at - chat.touchedAtMs > LATEST_SEND_MS || at < chat.touchedAtMs)
            return placeholder.end("expired");
          waking = true;
          const woke = yield* Effect.exit(wake(chat.threadId).pipe(Effect.timeout("2 minutes")));
          waking = false;
          if (!live) return;
          const blockedAtOpen = woke._tag === "Failure" ? "restore_failed" : woke.value;
          if (blockedAtOpen !== null) {
            yield* Effect.logInfo("claude.keep-warm", {
              threadId: chat.threadId,
              outcome: blockedAtOpen,
              ...(woke._tag === "Failure" ? { cause: Cause.pretty(woke.cause) } : {}),
            });
            return placeholder.end(blockedAtOpen);
          }
          const handle = handles.get(chat.threadId);
          if (handle === undefined) return placeholder.end("no_live_query");
          placeholder.end("adopted");
          yield* handle.adopt(chat);
        });
        restored.set(chat.threadId, placeholder);
        yield* admit(placeholder, yield* now);
        if (live) timer = yield* due.pipe(Effect.forkIn(coordinatorScope));
      }
    }),
    open: Effect.fnUntraced(function* (input) {
      const scope = yield* Effect.scope;
      let generation = 0;
      let state: { touchedAt: number; count: number; holdUntil: number; sending: boolean } | null =
        null;
      let timer: Fiber.Fiber<void> | undefined;
      const entry: Entry = {
        threadId: input.threadId,
        context: 0,
        deadline: () => state?.holdUntil ?? -Infinity,
        end: (reason: string) => {
          if (state === null) return;
          if (state.sending) {
            skip("cancelled_tokens_unknown");
          } else if (reason !== "complete" && reason !== "real_turn") skip(reason);
          state = null;
          generation++;
          entries.delete(entry);
          // Signal interruption synchronously without waiting for a CLI control response.
          timer?.interruptUnsafe();
          timer = undefined;
        },
      };
      yield* Effect.addFinalizer(() => Effect.sync(() => entry.end("shutdown")));
      // A real turn, or other work on the chat, also ends a restored chat's wait.
      const endForTurn = Effect.sync(() => {
        entry.end("real_turn");
        restored.get(input.threadId)?.end("real_turn");
      });
      const reason = Effect.gen(function* () {
        if (!(yield* options.enabled)) return "setting_off";
        return (yield* options.eligible(input.threadId)) ?? (yield* input.idle);
      });
      const holdUntil = Effect.gen(function* () {
        if (state === null) return null;
        const blocked = yield* reason;
        if (blocked !== null) {
          entry.end(blocked);
          return null;
        }
        return state?.holdUntil ?? null;
      });
      const run = Effect.fnUntraced(function* (expectedGeneration: number) {
        while (true) {
          if (state === null || generation !== expectedGeneration || state.count >= 2) return;
          yield* Effect.sleep(Math.max(0, state.touchedAt + INTERVAL_MS - (yield* now)));
          if (state === null || generation !== expectedGeneration) return;
          const blocked = yield* reason;
          if (blocked !== null) {
            entry.end(blocked);
            return;
          }
          // Clock is re-read immediately before invoking the SDK, never inferred from the timer.
          const sentAt = yield* now;
          if (sentAt - state.touchedAt > LATEST_SEND_MS || sentAt < state.touchedAt) {
            entry.end("expired");
            return;
          }
          state.sending = true;
          const result = yield* Effect.exit(
            input
              .ping({
                latestSendAtMs: state.touchedAt + LATEST_SEND_MS,
                onSend: Effect.sync(() => {
                  counters.sent++;
                }),
              })
              .pipe(
                Effect.timeout("2 minutes"),
                Effect.onInterrupt(() =>
                  Effect.logInfo("claude.keep-warm", {
                    providerSessionId: input.id,
                    threadId: input.threadId,
                    outcome: "cancelled_tokens_unknown",
                    ...counters,
                    skipped: { ...counters.skipped },
                  }),
                ),
              ),
          );
          if (state === null || generation !== expectedGeneration) return;
          state.sending = false;
          if (result._tag === "Failure") {
            // Do not self-interrupt while recording the outcome.
            timer = undefined;
            const error = Cause.squash(result.cause);
            entry.end(isKeepWarmSkip(error) ? error.reason : "ping_failed");
            yield* Effect.logInfo("claude.keep-warm", {
              providerSessionId: input.id,
              threadId: input.threadId,
              outcome: "failed",
              ...counters,
              skipped: { ...counters.skipped },
            });
            return;
          }
          const usage = result.value;
          const completedAt = yield* now;
          counters.tokensRead += usage.cacheReadTokens;
          const cold = isColdPing(usage, entry.context);
          if (cold) counters.cold++;
          const recorded = yield* Effect.exit(
            options.record(input.threadId, usage, completedAt).pipe(Effect.uninterruptible),
          );
          yield* Effect.logInfo("claude.keep-warm", {
            providerSessionId: input.id,
            threadId: input.threadId,
            outcome: cold ? "cold" : "warm",
            ...usage,
            ...counters,
            skipped: { ...counters.skipped },
          });
          if (state === null || generation !== expectedGeneration) return;
          if (cold || recorded._tag === "Failure") {
            timer = undefined;
            entry.end(cold ? "cold" : "accounting_failed");
            return;
          }
          state.count++;
          // Usage sampling after the answer must not move the cache-touch time.
          state.touchedAt = usage.requestFinishedAtMs ?? completedAt;
          state.holdUntil =
            state.count === 2
              ? state.touchedAt + RELEASE_AFTER_MS
              : state.touchedAt + LATEST_SEND_MS;
        }
      });
      const register = Effect.fnUntraced(function* (
        context: number,
        touchedAt: number,
        count: number,
      ) {
        const registeredAt = yield* now;
        if (registeredAt - touchedAt > LATEST_SEND_MS || registeredAt < touchedAt) {
          skip("expired");
          return;
        }
        entry.context = context;
        state = { touchedAt, count, holdUntil: touchedAt + LATEST_SEND_MS, sending: false };
        yield* admit(entry, registeredAt);
        if (state !== null) timer = yield* run(generation).pipe(Effect.forkIn(scope));
      });
      const handle = {
        // The session was opened idle for this restored chat; it keeps the chat's ping count.
        adopt: Effect.fnUntraced(function* (chat: ClaudeKeepWarmRestoredChat) {
          if (state !== null) return;
          const idleBlock = yield* input.idle;
          if (idleBlock !== null) {
            skip(idleBlock);
            return;
          }
          yield* register(chat.contextTokens, chat.touchedAtMs, chat.pings);
        }),
      };
      handles.set(input.threadId, handle);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (handles.get(input.threadId) === handle) handles.delete(input.threadId);
        }),
      );
      return {
        holdUntil,
        stop: endForTurn,
        finished: Effect.fnUntraced(function* (finished) {
          yield* endForTurn;
          if (!(yield* options.enabled)) {
            skip("setting_off");
            return;
          }
          if (finished.contextTokens < MIN_CONTEXT_TOKENS) {
            skip("small_context");
            return;
          }
          if (finished.cacheTtlMs !== CACHE_TTL_MS) {
            skip("cache_lifetime");
            return;
          }
          const idleBlock = yield* input.idle;
          if (idleBlock !== null) {
            skip(idleBlock);
            return;
          }
          yield* register(finished.contextTokens, finished.completedAtMs, 0);
        }),
      };
    }),
  });
});
