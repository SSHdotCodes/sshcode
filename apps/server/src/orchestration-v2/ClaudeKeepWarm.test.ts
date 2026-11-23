import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import type {
  ProviderSessionKeepWarmHandle,
  ProviderSessionKeepWarmUsage,
} from "@t3tools/provider-core/server/ProviderAdapter";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
class FakePingError extends Schema.TaggedError<FakePingError>()("FakePingError", {}) {}
import { TestClock } from "effect/testing";
import * as ClaudeKeepWarm from "./ClaudeKeepWarm.ts";

const MIN = 60_000;
const MAX = ClaudeKeepWarm.CLAUDE_KEEP_WARM_MAX_CHATS;
const usage: ProviderSessionKeepWarmUsage = {
  model: "claude-sonnet-4-6",
  inputTokens: 2,
  cacheReadTokens: 120_000,
  cacheWriteTokens: 500,
  outputTokens: 1,
};
const finished = { contextTokens: 120_000, cacheTtlMs: 60 * MIN, completedAtMs: 0 };
const threadId = ThreadId.make("keep-warm-test");
const setup = Effect.fnUntraced(function* (
  options: {
    readonly idle?: string;
    readonly eligible?: string;
    readonly ping?: Effect.Effect<ProviderSessionKeepWarmUsage, Error>;
  } = {},
) {
  let enabled = true;
  let wallOffset = 0;
  let eligible: string | null = options.eligible ?? null;
  const blockedThreads = new Map<ThreadId, string>();
  let idle: string | null = options.idle ?? null;
  let sent = 0;
  const records: ProviderSessionKeepWarmUsage[] = [];
  const changes = yield* PubSub.unbounded<boolean>();
  const changesStream = Stream.fromPubSub(changes);
  const service = yield* ClaudeKeepWarm.make({
    now: Clock.currentTimeMillis.pipe(Effect.map((time) => time + wallOffset)),
    enabled: Effect.sync(() => enabled),
    changes: changesStream,
    eligible: (thread) => Effect.sync(() => blockedThreads.get(thread) ?? eligible),
    record: (_, value) =>
      Effect.sync(() => {
        records.push(value);
      }),
  });
  const open = (id = "keep-warm", thread = threadId) =>
    service.open({
      id: ProviderSessionId.make(id),
      threadId: thread,
      idle: Effect.sync(() => idle),
      ping: ({ onSend }) =>
        onSend.pipe(
          Effect.andThen(
            Effect.sync(() => {
              sent++;
            }),
          ),
          Effect.andThen(options.ping ?? Effect.succeed(usage)),
        ),
    });
  return {
    service,
    open,
    records,
    sent: () => sent,
    jumpWallClock: (offset: number) => {
      wallOffset = offset;
    },
    setEligible: (value: string | null) => {
      eligible = value;
    },
    block: (thread: ThreadId, reason: string) => {
      blockedThreads.set(thread, reason);
    },
    setIdle: (value: string | null) => {
      idle = value;
    },
    disable: Effect.gen(function* () {
      enabled = false;
      yield* PubSub.publish(changes, false);
      yield* Effect.yieldNow;
    }),
  };
});

describe("Claude keep-warm", () => {
  it.effect("pings at 50 minutes, caps at two, and releases 30 minutes after the last ping", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const handle = yield* test.open();
      yield* handle.finished(finished);
      yield* TestClock.adjust(49 * MIN);
      assert.equal(test.sent(), 0);
      yield* TestClock.adjust(MIN);
      assert.equal(test.sent(), 1);
      yield* TestClock.adjust(50 * MIN);
      assert.equal(test.sent(), 2);
      assert.equal(yield* handle.holdUntil, 130 * MIN);
      yield* TestClock.adjust(60 * MIN);
      assert.equal(test.sent(), 2);
      assert.deepEqual(yield* test.service.counters, {
        sent: 2,
        skipped: {},
        tokensRead: 240_000,
        cold: 0,
      });
      assert.lengthOf(test.records, 2);
    }),
  );
  it.effect.each([
    { name: "small context", patch: { contextTokens: 99_999 } },
    { name: "5 minute lifetime", patch: { cacheTtlMs: 5 * MIN } },
    { name: "unknown lifetime", patch: { cacheTtlMs: undefined } },
  ] as const)("does not hold or ping $name", ({ patch }) =>
    Effect.gen(function* () {
      const test = yield* setup();
      const handle = yield* test.open();
      yield* handle.finished({ ...finished, ...patch });
      assert.isNull(yield* handle.holdUntil);
      yield* TestClock.adjust(60 * MIN);
      assert.equal(test.sent(), 0);
    }),
  );
  it.effect.each([
    "active_turn",
    "background_work",
    "pending_request",
    "weekly_limit",
    "out_of_credit",
    "rate_limited",
    "archived",
    "removed",
    "settled",
    "snoozed",
    "parent_finished",
  ])("ends the stretch for %s", (reason) =>
    Effect.gen(function* () {
      const test = yield* setup();
      const handle = yield* test.open();
      yield* handle.finished(finished);
      test.setEligible(reason);
      yield* TestClock.adjust(50 * MIN);
      assert.equal(test.sent(), 0);
      assert.isNull(yield* handle.holdUntil);
      assert.equal((yield* test.service.counters).skipped[reason], 1);
    }),
  );
  it.effect(
    "does not hold background work, pending requests or an active turn even before the first timer",
    () =>
      Effect.gen(function* () {
        for (const idle of ["active_turn", "background_work", "pending_request"]) {
          const test = yield* setup({ idle });
          const handle = yield* test.open();
          yield* handle.finished(finished);
          assert.isNull(yield* handle.holdUntil);
        }
      }),
  );
  it.effect("rejects stale registration after restart and a late timer after sleep", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const handle = yield* test.open();
      yield* TestClock.setTime(58 * MIN);
      yield* handle.finished(finished);
      assert.isNull(yield* handle.holdUntil);
      yield* handle.finished({ ...finished, completedAtMs: 58 * MIN });
      // Move the wall clock discontinuously, without running the timer at minute 50.
      yield* TestClock.adjust(0);
      test.jumpWallClock(12 * MIN);
      yield* TestClock.adjust(50 * MIN);
      yield* Effect.yieldNow;
      assert.equal(test.sent(), 0);
      assert.isNull(yield* handle.holdUntil);
      const restarted = yield* test.open("restarted");
      assert.isNull(yield* restarted.holdUntil);
    }),
  );
  it.effect(
    "a real turn cancels an in-flight ping without waiting, then resets the two-ping budget",
    () =>
      Effect.gen(function* () {
        const reached = yield* Deferred.make<void>();
        let cancelled = false;
        const test = yield* setup({
          ping: Deferred.succeed(reached, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                cancelled = true;
              }),
            ),
          ),
        });
        const handle = yield* test.open();
        yield* handle.finished(finished);
        yield* TestClock.adjust(50 * MIN);
        yield* Deferred.await(reached);
        yield* handle.stop;
        yield* Effect.yieldNow;
        assert.isTrue(cancelled);
        assert.isNull(yield* handle.holdUntil);
        assert.lengthOf(test.records, 0);
        assert.equal((yield* test.service.counters).skipped.cancelled_tokens_unknown, 1);
        yield* handle.finished({ ...finished, completedAtMs: yield* Clock.currentTimeMillis });
        yield* TestClock.adjust(50 * MIN);
        assert.equal(test.sent(), 2);
      }),
  );
  it.effect("keeps the largest contexts up to the cap", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const handles = [];
      const larger = Array.from({ length: MAX }, (_, index) => 150_000 + index * 50_000);
      for (const contextTokens of [100_000, ...larger.toReversed()]) {
        const handle = yield* test.open(String(contextTokens));
        yield* handle.finished({ ...finished, contextTokens });
        handles.push(handle);
      }
      assert.isNull(yield* handles[0]!.holdUntil);
      for (const handle of handles.slice(1)) assert.isNotNull(yield* handle.holdUntil);
      yield* TestClock.adjust(50 * MIN);
      assert.equal(test.sent(), MAX);
    }),
  );
  it.effect("a chat that can no longer be pinged gives its slot to a new one", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const threads = Array.from({ length: MAX + 1 }, (_, index) => 500_000 - index * 25_000).map(
        (contextTokens) => ({ thread: ThreadId.make(`chat-${contextTokens}`), contextTokens }),
      );
      for (const { thread, contextTokens } of threads.slice(0, MAX)) {
        const handle = yield* test.open(String(contextTokens), thread);
        yield* handle.finished({ ...finished, contextTokens });
      }
      // The largest is a subagent whose parent has since finished.
      test.block(threads[0]!.thread, "parent_finished");
      const last = threads[MAX]!;
      const newest = yield* test.open(String(last.contextTokens), last.thread);
      yield* newest.finished({ ...finished, contextTokens: last.contextTokens });
      assert.isNotNull(yield* newest.holdUntil);
      const { skipped } = yield* test.service.counters;
      assert.equal(skipped.parent_finished, 1);
      assert.isUndefined(skipped.capacity);
    }),
  );
  it.effect("a finishing subagent whose parent is done takes no slot from a chat", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const chats = Array.from({ length: MAX }, (_, index) => 450_000 - index * 25_000).map(
        (contextTokens) => ({ thread: ThreadId.make(`chat-${contextTokens}`), contextTokens }),
      );
      const handles = [];
      for (const { thread, contextTokens } of chats) {
        const handle = yield* test.open(String(contextTokens), thread);
        yield* handle.finished({ ...finished, contextTokens });
        handles.push(handle);
      }
      const child = ThreadId.make("finished-parent-child");
      test.block(child, "parent_finished");
      const subagent = yield* test.open("child", child);
      yield* subagent.finished({ ...finished, contextTokens: 500_000 });
      assert.isNull(yield* subagent.holdUntil);
      for (const handle of handles) assert.isNotNull(yield* handle.holdUntil);
      assert.isUndefined((yield* test.service.counters).skipped.capacity);
    }),
  );
  it.effect("turning the setting off cancels pings and holds immediately", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const handle = yield* test.open();
      yield* handle.finished(finished);
      yield* test.disable;
      assert.isNull(yield* handle.holdUntil);
      yield* TestClock.adjust(60 * MIN);
      assert.equal(test.sent(), 0);
      yield* handle.finished({ ...finished, completedAtMs: yield* Clock.currentTimeMillis });
      assert.isNull(yield* handle.holdUntil);
    }),
  );
  it.effect("records a cold ping and never sends a second one", () =>
    Effect.gen(function* () {
      const test = yield* setup({
        ping: Effect.succeed({ ...usage, cacheReadTokens: 0, cacheWriteTokens: 120_000 }),
      });
      const handle = yield* test.open();
      yield* handle.finished(finished);
      yield* TestClock.adjust(50 * MIN);
      assert.isNull(yield* handle.holdUntil);
      assert.equal((yield* test.service.counters).cold, 1);
      assert.lengthOf(test.records, 1);
      yield* TestClock.adjust(100 * MIN);
      assert.equal(test.sent(), 1);
    }),
  );
  it.effect("scope shutdown cancels a pending ping without extending session residency", () =>
    Effect.gen(function* () {
      let cancelled = false;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const test = yield* setup({
            ping: Effect.never.pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  cancelled = true;
                }),
              ),
            ),
          });
          const handle = yield* test.open();
          yield* handle.finished(finished);
          yield* TestClock.adjust(50 * MIN);
          assert.equal(test.sent(), 1);
        }),
      );
      assert.isTrue(cancelled);
    }),
  );
  it.effect("a failed ping ends the stretch", () =>
    Effect.gen(function* () {
      const test = yield* setup({ ping: Effect.fail(new FakePingError()) });
      const handle = yield* test.open();
      yield* handle.finished(finished);
      yield* TestClock.adjust(100 * MIN);
      assert.isNull(yield* handle.holdUntil);
      assert.equal(test.sent(), 1);
      assert.equal((yield* test.service.counters).skipped.ping_failed, 1);
    }),
  );
});

describe("Claude keep-warm after a restart", () => {
  const chat = (patch: Partial<ClaudeKeepWarm.ClaudeKeepWarmRestoredChat> = {}) => ({
    threadId,
    contextTokens: 120_000,
    touchedAtMs: 0,
    pings: 0,
    ...patch,
  });
  // Opens a session for the chat the way the manager's wake does, and records each wake.
  const waker = Effect.fnUntraced(function* (test: Effect.Success<ReturnType<typeof setup>>) {
    const scope = yield* Effect.scope;
    const woken: Array<string> = [];
    const handles = new Map<string, ProviderSessionKeepWarmHandle>();
    const wake = (thread: ThreadId) =>
      test.open(`restored:${thread}`, thread).pipe(
        Scope.provide(scope),
        Effect.map((handle) => {
          woken.push(thread);
          handles.set(thread, handle);
          return null;
        }),
      );
    return { woken, handles, wake };
  });

  it.effect("starts nothing until the ping is due, then pings through a session opened idle", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const { woken, handles, wake } = yield* waker(test);
      yield* test.service.restore([chat()], wake);
      yield* TestClock.adjust(49 * MIN);
      assert.deepEqual(woken, []);
      yield* TestClock.adjust(MIN);
      assert.deepEqual(woken, [threadId]);
      assert.equal(test.sent(), 1);
      // Afterwards the chat follows the live rules: one more ping, then release.
      assert.equal(yield* handles.get(threadId)!.holdUntil, 107 * MIN);
      yield* TestClock.adjust(50 * MIN);
      assert.equal(test.sent(), 2);
      assert.equal(yield* handles.get(threadId)!.holdUntil, 130 * MIN);
      yield* TestClock.adjust(60 * MIN);
      assert.equal(test.sent(), 2);
      assert.lengthOf(test.records, 2);
    }),
  );
  it.effect("a chat pinged once before the restart gets only its second ping", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const { handles, wake } = yield* waker(test);
      yield* TestClock.setTime(55 * MIN);
      yield* test.service.restore([chat({ touchedAtMs: 50 * MIN, pings: 1 })], wake);
      yield* TestClock.adjust(45 * MIN);
      assert.equal(test.sent(), 1);
      assert.equal(yield* handles.get(threadId)!.holdUntil, 130 * MIN);
      yield* TestClock.adjust(60 * MIN);
      assert.equal(test.sent(), 1);
    }),
  );
  it.effect("a real turn before the ping is due drops the restored chat", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const { woken, wake } = yield* waker(test);
      yield* test.service.restore([chat()], wake);
      yield* TestClock.adjust(10 * MIN);
      const real = yield* test.open("real-turn");
      yield* real.stop;
      yield* TestClock.adjust(60 * MIN);
      assert.deepEqual(woken, []);
      assert.equal(test.sent(), 0);
      assert.deepEqual((yield* test.service.counters).skipped, {});
    }),
  );
  it.effect("a chat with a session since the restart is left to that session", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const { woken, wake } = yield* waker(test);
      yield* test.open("opened-first");
      yield* test.service.restore([chat()], wake);
      yield* TestClock.adjust(60 * MIN);
      assert.deepEqual(woken, []);
    }),
  );
  it.effect("never opens an ineligible chat or one whose cache expired", () =>
    Effect.gen(function* () {
      const snoozed = yield* setup();
      const first = yield* waker(snoozed);
      yield* snoozed.service.restore([chat()], first.wake);
      snoozed.setEligible("snoozed");
      yield* TestClock.adjust(60 * MIN);
      assert.deepEqual(first.woken, []);
      assert.equal((yield* snoozed.service.counters).skipped.snoozed, 1);

      const slept = yield* setup();
      const second = yield* waker(slept);
      yield* slept.service.restore(
        [chat({ touchedAtMs: yield* Clock.currentTimeMillis })],
        second.wake,
      );
      // The machine slept through the due time.
      yield* TestClock.adjust(0);
      slept.jumpWallClock(12 * MIN);
      yield* TestClock.adjust(50 * MIN);
      assert.deepEqual(second.woken, []);
      assert.equal((yield* slept.service.counters).skipped.expired, 1);
    }),
  );
  it.effect("a chat skipped at startup takes no slot from one that will be pinged", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const { woken, wake } = yield* waker(test);
      test.setEligible("parent_finished");
      const finishedChild = ThreadId.make("finished-child");
      yield* test.service.restore(
        [chat({ threadId: finishedChild, contextTokens: 500_000 })],
        wake,
      );
      test.setEligible(null);
      yield* test.service.restore(
        [400_000, 300_000, 200_000, 150_000].map((contextTokens) =>
          chat({ threadId: ThreadId.make(`restored-${contextTokens}`), contextTokens }),
        ),
        wake,
      );
      yield* TestClock.adjust(50 * MIN);
      assert.lengthOf(woken, 4);
      assert.notInclude(woken, finishedChild);
      assert.equal((yield* test.service.counters).skipped.parent_finished, 1);
    }),
  );
  it.effect("restored and live chats share the largest contexts", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const { woken, wake } = yield* waker(test);
      const thread = (name: string) => ThreadId.make(`restored-${name}`);
      const restored = Array.from({ length: MAX }, (_, index) => 400_000 - index * 25_000);
      yield* test.service.restore(
        restored.map((contextTokens) =>
          chat({ threadId: thread(String(contextTokens)), contextTokens }),
        ),
        wake,
      );
      const live = yield* test.open("live", ThreadId.make("live"));
      yield* live.finished({ ...finished, contextTokens: 500_000 });
      assert.equal((yield* test.service.counters).skipped.capacity, 1);
      yield* TestClock.adjust(50 * MIN);
      // The smallest restored chat gave its slot to the larger live one.
      assert.sameMembers(
        woken,
        restored.slice(0, MAX - 1).map((contextTokens) => thread(String(contextTokens))),
      );
      assert.equal(test.sent(), MAX);
    }),
  );
  it.effect("a chat the wake cannot open ends with its reason", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      yield* test.service.restore(
        [chat(), chat({ threadId: ThreadId.make("failing") })],
        (thread) =>
          thread === threadId
            ? Effect.succeed("selection_changed")
            : Effect.fail(new FakePingError()),
      );
      yield* TestClock.adjust(60 * MIN);
      assert.equal(test.sent(), 0);
      const { skipped } = yield* test.service.counters;
      assert.equal(skipped.selection_changed, 1);
      assert.equal(skipped.restore_failed, 1);
    }),
  );
  it.effect("turning the setting off drops restored chats", () =>
    Effect.gen(function* () {
      const test = yield* setup();
      const { woken, wake } = yield* waker(test);
      yield* test.service.restore([chat()], wake);
      yield* test.disable;
      yield* TestClock.adjust(60 * MIN);
      assert.deepEqual(woken, []);
    }),
  );
});

it("restores chats from their last turn and the pings logged since", () => {
  type Input = Parameters<typeof ClaudeKeepWarm.claudeKeepWarmRestoredChats>[0];
  const turn: Input["turns"][number] = {
    threadId,
    contextTokens: 200_000,
    cacheTtlMs: 60 * MIN,
    touchedAtMs: 0,
  };
  const ping = (
    atMs: number,
    cacheReadTokens = 199_000,
    cacheWriteTokens = 500,
  ): Input["pings"][number] => ({ threadId, atMs, cacheReadTokens, cacheWriteTokens });
  const restored = (turns: Input["turns"], pings: Input["pings"], now: number) =>
    ClaudeKeepWarm.claudeKeepWarmRestoredChats({ turns, pings, now });
  assert.deepEqual(restored([turn], [], 30 * MIN), [
    { threadId, contextTokens: 200_000, touchedAtMs: 0, pings: 0 },
  ]);
  assert.deepEqual(restored([turn], [], 58 * MIN), []);
  assert.deepEqual(restored([{ ...turn, contextTokens: 99_999 }], [], 1), []);
  assert.deepEqual(restored([{ ...turn, cacheTtlMs: 5 * MIN }], [], 1), []);
  assert.deepEqual(restored([{ ...turn, cacheTtlMs: null }], [], 1), []);
  // A ping moves the touch, so a turn past its own window can still be warm.
  assert.deepEqual(restored([turn], [ping(50 * MIN)], 80 * MIN), [
    { threadId, contextTokens: 200_000, touchedAtMs: 50 * MIN, pings: 1 },
  ]);
  // One ping can log a row per model.
  assert.deepEqual(
    restored([turn], [ping(50 * MIN, 150_000, 300), ping(50 * MIN, 49_000, 200)], 80 * MIN),
    [{ threadId, contextTokens: 200_000, touchedAtMs: 50 * MIN, pings: 1 }],
  );
  // Pings for an earlier turn, or another chat, do not count.
  assert.deepEqual(restored([{ ...turn, touchedAtMs: 60 * MIN }], [ping(50 * MIN)], 80 * MIN), [
    { threadId, contextTokens: 200_000, touchedAtMs: 60 * MIN, pings: 0 },
  ]);
  assert.deepEqual(restored([turn], [{ ...ping(50 * MIN), threadId: "other" }], 30 * MIN), [
    { threadId, contextTokens: 200_000, touchedAtMs: 0, pings: 0 },
  ]);
  // Two pings spend the stretch; a cold ping ends it.
  assert.deepEqual(restored([turn], [ping(50 * MIN), ping(100 * MIN)], 110 * MIN), []);
  assert.deepEqual(restored([turn], [ping(50 * MIN, 0, 200_000)], 80 * MIN), []);
});

it("recognizes lifecycle exclusions from the current projection", () => {
  const at = DateTime.makeUnsafe(0);
  const base = {
    status: "idle" as const,
    deletedAt: null,
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
  };
  assert.isNull(ClaudeKeepWarm.claudeKeepWarmThreadSkipReason(base));
  // A question the agent left open is answered by message: the chat idles until then.
  const question = {
    id: "request-1",
    kind: "user_input",
    createdAt: at,
  };
  assert.isNull(
    ClaudeKeepWarm.claudeKeepWarmThreadSkipReason({
      ...base,
      pendingRuntimeRequest: question,
    } as never),
  );
  // One that holds a turn (an approval) leaves the chat running.
  assert.equal(
    ClaudeKeepWarm.claudeKeepWarmThreadSkipReason({
      ...base,
      status: "waiting",
      pendingRuntimeRequest: question,
    } as never),
    "active_turn",
  );
  // A chat waiting on its subagents or monitors is the one most sure to come back.
  assert.isNull(
    ClaudeKeepWarm.claudeKeepWarmThreadSkipReason({
      ...base,
      pendingBackgroundTasks: [{ taskId: "monitor-1", kind: "monitor", description: "Build" }],
    } as never),
  );
  assert.equal(ClaudeKeepWarm.claudeKeepWarmThreadSkipReason(null), "removed");
  for (const [key, expected] of [
    ["deletedAt", "removed"],
    ["archivedAt", "archived"],
    ["settledAt", "settled"],
    ["snoozedAt", "snoozed"],
    ["snoozedUntil", "snoozed"],
  ] as const) {
    assert.equal(ClaudeKeepWarm.claudeKeepWarmThreadSkipReason({ ...base, [key]: at }), expected);
  }
  const child = {
    ...base,
    lineage: {
      rootThreadId: threadId,
      parentThreadId: threadId,
      relationshipToParent: "subagent" as const,
    },
  };
  assert.equal(
    ClaudeKeepWarm.claudeKeepWarmThreadSkipReason(child, { status: "idle" }),
    "parent_finished",
  );
  assert.isNull(ClaudeKeepWarm.claudeKeepWarmThreadSkipReason(child, { status: "running" }));
});
