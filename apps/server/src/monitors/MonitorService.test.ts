import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as MonitorService from "./MonitorService.ts";

const threadId = ThreadId.make("thread:monitor-test");
const input = {
  threadId,
  cwd: process.cwd(),
  requestNamespace: "test",
  command: "watch",
  description: "Build",
};

const makeProcess = Effect.gen(function* () {
  const stdout = yield* Queue.unbounded<readonly [string, Deferred.Deferred<void>], Cause.Done>();
  const stderr = yield* Queue.unbounded<readonly [string, Deferred.Deferred<void>], Cause.Done>();
  const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
  let released = false;
  const read = (queue: typeof stdout) =>
    Stream.fromQueue(queue).pipe(
      Stream.flatMap(([text, read]) =>
        Stream.concat(
          Stream.encodeText(Stream.make(text)),
          Stream.fromEffect(Deferred.succeed(read, undefined)).pipe(Stream.drain),
        ),
      ),
    );
  const write = (queue: typeof stdout, text: string) =>
    Effect.gen(function* () {
      const read = yield* Deferred.make<void>();
      yield* Queue.offer(queue, [text, read]);
      yield* Deferred.await(read);
    });
  const release = Effect.gen(function* () {
    released = true;
    yield* Queue.end(stdout);
    yield* Queue.end(stderr);
  });
  return {
    handle: ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(1),
      exitCode: Deferred.await(exit),
      isRunning: Effect.sync(() => !released),
      kill: () => release,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      stdout: read(stdout),
      stderr: read(stderr),
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    }),
    release,
    released: () => released,
    stdout: (text: string) => write(stdout, text),
    stderr: (text: string) => write(stderr, text),
    finish: (code: number) =>
      Effect.gen(function* () {
        yield* Queue.end(stdout);
        yield* Queue.end(stderr);
        yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(code));
      }),
  };
});

const withMonitor = <A, E, R>(
  test: (
    service: MonitorService.MonitorService["Service"],
    child: Effect.Success<typeof makeProcess>,
  ) => Effect.Effect<A, E, R>,
  beforeSpawn: Effect.Effect<void> = Effect.void,
) =>
  Effect.gen(function* () {
    const child = yield* makeProcess;
    const spawner = ChildProcessSpawner.make(() =>
      beforeSpawn.pipe(
        Effect.andThen(Effect.acquireRelease(Effect.succeed(child.handle), () => child.release)),
      ),
    );
    return yield* Effect.flatMap(MonitorService.MonitorService, (service) =>
      test(service, child),
    ).pipe(
      Effect.provide(
        MonitorService.layer.pipe(
          Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("MonitorService", () => {
  it.effect.each([
    [false, 0],
    [false, 7],
    ["^ready", 0],
    ["^ready", 7],
  ] as const)(
    "keeps non-waking output readable and always reports exit (wakeOn=%s, code=%s)",
    ([wakeOn, code]) =>
      withMonitor((service, child) =>
        Effect.gen(function* () {
          yield* service.start({ ...input, wakeOn });
          const events = yield* Queue.unbounded<MonitorService.MonitorEvent>();
          yield* service.events.pipe(
            Stream.runForEach((event) => Queue.offer(events, event)),
            Effect.forkChild,
          );
          yield* child.stdout("progress\n");
          yield* child.stderr("diagnostic\n");
          yield* TestClock.adjust("3 minutes");
          expect(yield* Queue.size(events)).toBe(0);
          expect((yield* service.list(threadId))[0]?.output).toBe("progress\ndiagnostic\n");

          if (typeof wakeOn === "string") {
            // Matching is independent of the bounded panel text and includes both pipes.
            yield* child.stdout("noise\n".repeat(100) + "rea");
            yield* child.stdout("dy stdout\r\n");
            yield* TestClock.adjust("1 second");
            expect((yield* Queue.take(events)).notification).toMatchObject({
              outcome: "updated",
              detail: "ready stdout",
            });
            yield* child.stderr("ready stderr\n");
            yield* TestClock.adjust("1 second");
            expect((yield* Queue.take(events)).notification).toMatchObject({
              outcome: "updated",
              detail: "ready stderr",
            });
            expect(yield* Queue.size(events)).toBe(0);
          }
          yield* child.stdout("final partial");
          yield* child.finish(code);
          const end = yield* Queue.take(events);
          expect(end.notification).toMatchObject({
            outcome: code === 0 ? "completed" : "failed",
            summary: `Build: exited with code ${code}`,
          });
          expect(end.notification.detail).toContain("final partial");
          yield* TestClock.adjust("3 minutes");
          expect(yield* Queue.size(events)).toBe(0);
        }),
      ),
  );

  it.effect("streams bounded output without waking an exit-only monitor", () =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        yield* service.start({ ...input, wakeOn: false });
        const snapshots =
          yield* Queue.unbounded<ReadonlyArray<import("@t3tools/contracts").MonitorInfo>>();
        yield* service.stream(threadId).pipe(
          Stream.runForEach((snapshot) => Queue.offer(snapshots, snapshot)),
          Effect.forkChild,
        );
        yield* Queue.take(snapshots);
        yield* child.stdout("x".repeat(16_000) + "\n");
        yield* TestClock.adjust("1 second");
        const snapshot = yield* Queue.take(snapshots);
        expect(snapshot[0]?.output).toHaveLength(8_000);
        expect(snapshot[0]?.output).toMatch(/x\n$/);
        yield* service.stopThread(threadId);
      }),
    ),
  );

  it.effect.each([false, "ready"] as const)("timeouts always wake with wakeOn=%s", (wakeOn) =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        yield* service.start({ ...input, wakeOn, timeoutMs: 2_000 });
        // Wait for matcher startup and the readers before advancing the test clock.
        yield* child.stdout("noise\n");
        yield* TestClock.adjust("2 seconds");
        const [event] = yield* service.events.pipe(Stream.take(1), Stream.runCollect);
        expect(event?.notification).toMatchObject({
          outcome: "failed",
          summary: "Build: timed out",
        });
      }),
    ),
  );

  it.effect("explicit silence alerts still wake an exit-only monitor", () =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        yield* service.start({ ...input, wakeOn: false, silenceMs: 60_000 });
        yield* child.stdout("progress\n");
        yield* TestClock.adjust("1 minute");
        const [event] = yield* service.events.pipe(Stream.take(1), Stream.runCollect);
        expect(event?.notification.summary).toBe("Build: no output for 1 min");
        yield* service.stopThread(threadId);
      }),
    ),
  );

  it.effect.each([
    [false, 2],
    [undefined, 1],
  ] as const)(
    "an ordinary monitor repeating an error wakes at once (wakeOn=%s, wakes=%s)",
    ([wakeOn, wakes]) =>
      withMonitor((service, child) =>
        Effect.gen(function* () {
          const collected = yield* service.events.pipe(
            Stream.takeUntil((event) => event.notification.outcome !== "updated"),
            Stream.runCollect,
            Effect.forkChild,
          );
          yield* service.start({
            ...input,
            persistent: true,
            ...(wakeOn === undefined ? {} : { wakeOn }),
          });
          const crash = (attempt: number) =>
            child.stderr(
              `Traceback (most recent call last):\n  File "/srv/app.py", line 3, in <module>\nConnectionRefusedError: [Errno 61] attempt ${attempt} refused\n`,
            );
          // Every four minutes for an hour; the second wake needs one that waits for it.
          for (let attempt = 0; attempt < 15; attempt++) {
            yield* crash(attempt);
            yield* TestClock.adjust("4 minutes");
          }
          yield* child.finish(1);
          const events = yield* Fiber.join(collected);
          const stuck = events.filter((event) => event.urgent === true);
          expect(stuck.map((event) => event.notification.summary)).toEqual(
            [
              "Build: still running, same error 4× in 12 min: ConnectionRefusedError: [Errno 61] attempt 3 refused",
              "Build: still running, same error 12× in 44 min: ConnectionRefusedError: [Errno 61] attempt 11 refused",
            ].slice(0, wakes),
          );
          expect(events.at(-1)?.notification.summary).toBe("Build: exited with code 1");
        }),
      ),
  );

  it.effect("an ordinary monitor past its expected time wakes once, never after it ends", () =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        const collected = yield* service.events.pipe(
          Stream.takeUntil((event) => event.notification.outcome !== "updated"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* service.start({ ...input, wakeOn: false, persistent: true, expectMinutes: 30 });
        yield* child.stdout("step 1 of 40\n");
        yield* TestClock.adjust("44 minutes");
        expect(collected.pollUnsafe()).toBeUndefined();
        yield* child.stdout("step 2 of 40\n");
        yield* TestClock.adjust("1 minute");
        yield* TestClock.adjust("2 hours");
        yield* child.finish(0);
        expect((yield* Fiber.join(collected)).map((event) => event.notification.summary)).toEqual([
          "Build: still running after 45 min (expected 30 min); last output: step 2 of 40",
          "Build: exited with code 0",
        ]);
      }),
    ),
  );

  it.effect("an ordinary monitor that ends before its expected time does not wake later", () =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<MonitorService.MonitorEvent>();
        yield* service.events.pipe(
          Stream.runForEach((event) => Queue.offer(events, event)),
          Effect.forkChild,
        );
        yield* service.start({ ...input, wakeOn: false, expectMinutes: 5 });
        yield* child.finish(0);
        expect((yield* Queue.take(events)).notification.summary).toBe("Build: exited with code 0");
        yield* TestClock.adjust("1 hour");
        expect(yield* Queue.size(events)).toBe(0);
      }),
    ),
  );

  it.effect("rejects invalid ordinary regexes and changes to a retried wake policy", () =>
    withMonitor((service) =>
      Effect.gen(function* () {
        expect((yield* service.start({ ...input, wakeOn: "[" }).pipe(Effect.flip)).reason).toBe(
          "invalid-options",
        );
        expect(yield* service.list(threadId)).toEqual([]);
        const request = { ...input, clientRequestId: "policy" };
        yield* service.start(request);
        expect((yield* service.start({ ...request, wakeOn: false }).pipe(Effect.flip)).reason).toBe(
          "invalid-request",
        );
        yield* service.stopThread(threadId);
      }),
    ),
  );

  it.effect("holds open work from admission through the last notification delivery", () =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        yield* service.start(input);
        expect(service.hasOpenWork(threadId)).toBe(true);
        yield* child.finish(0);
        // stop waits for process cleanup, including removal from the live roster.
        const stopping = service.stopThread(threadId);
        const event = yield* service.events.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
        expect(service.hasOpenWork(threadId)).toBe(true);
        yield* service.acknowledge(event);
        yield* stopping;
        expect(service.hasOpenWork(threadId)).toBe(false);
      }),
    ),
  );

  it.effect("thread stop catches a monitor whose process is still spawning", () =>
    Effect.gen(function* () {
      const spawning = yield* Deferred.make<void>();
      const allowSpawn = yield* Deferred.make<void>();
      yield* withMonitor(
        (service, child) =>
          Effect.gen(function* () {
            const starting = yield* service.start(input).pipe(Effect.forkChild);
            yield* Deferred.await(spawning);
            const stopping = yield* service.stopThread(threadId).pipe(Effect.forkChild);
            // Let stop reach admission before releasing the process spawn.
            yield* Effect.yieldNow;
            yield* Deferred.succeed(allowSpawn, undefined);
            yield* Fiber.join(starting);
            yield* Fiber.join(stopping);
            expect(yield* service.list(threadId)).toEqual([]);
            expect(child.released()).toBe(true);
            const event = yield* service.events.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
            expect(service.canDeliver(event)).toBe(false);
          }),
        Deferred.succeed(spawning, undefined).pipe(Effect.andThen(Deferred.await(allowSpawn))),
      );
    }),
  );

  it.effect("streams only changes to the requested thread's roster", () =>
    withMonitor((service) =>
      Effect.gen(function* () {
        const subscribed = yield* Deferred.make<void>();
        const snapshots = yield* service.stream(threadId).pipe(
          Stream.tap(() => Deferred.succeed(subscribed, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Deferred.await(subscribed);
        yield* service.start({ ...input, threadId: ThreadId.make("unrelated") });
        const { monitorId } = yield* service.start(input);
        expect(
          (yield* Fiber.join(snapshots)).map((entries) => entries.map((entry) => entry.monitorId)),
        ).toEqual([[], [monitorId]]);
        yield* service.stopThread(threadId);
      }),
    ),
  );

  it.effect("batches the first output after a long idle period", () =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        yield* service.start({ ...input, persistent: true });
        yield* TestClock.adjust("2 hours");
        const events = yield* service.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* child.stdout("first\n");
        yield* TestClock.adjust("500 millis");
        yield* child.stdout("second\n");
        expect(events.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("1 second");
        expect((yield* Fiber.join(events))[0]?.notification.detail).toBe("first\nsecond");
        yield* service.stopThread(threadId);
      }),
    ),
  );

  it.effect("batches nearby lines after a quiet window, preserving partial lines", () =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        yield* service.start(input);
        const next = yield* service.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* child.stdout("first\npar");
        yield* TestClock.adjust("500 millis");
        yield* child.stdout("tial\nthird\n");
        yield* TestClock.adjust("750 millis");
        expect(next.pollUnsafe()).toBeUndefined();
        yield* TestClock.adjust("250 millis");
        const [event] = yield* Fiber.join(next);
        expect(event?.notification).toMatchObject({
          source: { kind: "monitor" },
          summary: "Build: output",
          detail: "first\npartial\nthird",
        });
        yield* service.stopThread(threadId);
        expect(child.released()).toBe(true);
      }),
    ),
  );

  it.effect("flushes on exit and reports code and a bounded stderr tail", () =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        yield* service.start(input);
        const events = yield* service.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* child.stdout("ready\nlast partial");
        yield* child.stderr("x".repeat(5_000) + " failure");
        yield* child.finish(7);
        // Output still batched at exit goes out with the exit status, as one wake.
        const [event] = yield* Fiber.join(events);
        expect(event?.notification).toMatchObject({
          outcome: "failed",
          summary: "Build: exited with code 7",
        });
        expect(event?.notification.detail).toMatch(/^ready\nlast partial\nStderr tail:\nx/);
        expect(event?.notification.detail).toHaveLength(19 + 4_013);
        expect(event?.notification.detail).toMatch(/ failure$/);
        expect(yield* service.list(threadId)).toEqual([]);
      }),
    ),
  );

  it.effect("times out and releases the process before the final notice", () =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        yield* service.start({ ...input, timeoutMs: 2_000 });
        const events = yield* service.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* TestClock.adjust("2 seconds");
        const [event] = yield* Fiber.join(events);
        expect(event?.notification).toMatchObject({
          outcome: "failed",
          summary: "Build: timed out",
        });
        expect(child.released()).toBe(true);
      }),
    ),
  );

  it.effect("bounds long lines and batches and counts omitted lines", () =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        yield* service.start(input);
        const events = yield* service.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* child.stdout("x".repeat(16_000) + "\n" + "line\n".repeat(100));
        yield* child.finish(0);
        const [final] = yield* Fiber.join(events);
        expect(final?.notification.outcome).toBe("completed");
        expect(final?.notification.detail?.length).toBeLessThan(8_050);
        expect(final?.notification.detail).toContain("[line truncated]");
        expect(final?.notification.detail).toMatch(/\[\d+ lines omitted\]/);
      }),
    ),
  );

  it.effect("stops runaway output with a final notice", () =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        yield* service.start(input);
        const events = yield* service.events.pipe(
          Stream.takeUntil((event) => event.notification.outcome === "failed"),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* child.stdout("noise\n".repeat(10_001));
        const result = yield* Fiber.join(events);
        expect(result.at(-1)?.notification.summary).toContain("output rate limit exceeded");
        expect(child.released()).toBe(true);
      }),
    ),
  );

  it.effect("keeps persistent monitors past the default timeout and stops them explicitly", () =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        const { monitorId } = yield* service.start({ ...input, persistent: true });
        yield* TestClock.adjust("2 hours");
        expect(yield* service.list(threadId)).toHaveLength(1);
        expect(yield* service.stop(threadId, monitorId)).toBe(true);
        expect(yield* service.stop(threadId, monitorId)).toBe(false);
        expect(child.released()).toBe(true);
        const [event] = yield* service.events.pipe(Stream.take(1), Stream.runCollect);
        expect(event?.notification.outcome).toBe("cancelled");
      }),
    ),
  );

  it.effect("enforces thread ownership, per-thread limits and idempotency", () =>
    withMonitor((service) =>
      Effect.gen(function* () {
        const started = yield* service.start({ ...input, clientRequestId: "retry" });
        expect(yield* service.start({ ...input, clientRequestId: "retry" })).toEqual(started);
        expect(
          (yield* service
            .start({ ...input, command: "other", clientRequestId: "retry" })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid-request");
        expect(
          (yield* service.stop(ThreadId.make("other"), started.monitorId).pipe(Effect.flip)).reason,
        ).toBe("not-found");
        yield* Effect.forEach(Array.from({ length: 7 }), () => service.start(input));
        expect((yield* service.start(input).pipe(Effect.flip)).reason).toBe("limit");
        yield* service.start({ ...input, threadId: ThreadId.make("other") });
        yield* service.stopThread(threadId);
        expect(yield* service.list(threadId)).toEqual([]);
      }),
    ),
  );

  it.effect("invalidates pending output and final events when a thread stops", () =>
    withMonitor((service, child) =>
      Effect.gen(function* () {
        yield* service.start(input);
        yield* child.stdout("status\n");
        yield* TestClock.adjust("1 second");
        yield* service.stopThread(threadId);
        const events = yield* service.events.pipe(Stream.take(2), Stream.runCollect);
        expect(events.every((event) => !service.canDeliver(event))).toBe(true);
        expect(child.released()).toBe(true);
      }),
    ),
  );

  it.effect("releases monitor processes when the server scope closes", () =>
    Effect.gen(function* () {
      const child = yield* makeProcess;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const service = yield* MonitorService.MonitorService;
          yield* service.start(input);
        }).pipe(
          Effect.provide(
            MonitorService.layer.pipe(
              Layer.provide(
                Layer.succeed(
                  ChildProcessSpawner.ChildProcessSpawner,
                  ChildProcessSpawner.make(() =>
                    Effect.acquireRelease(Effect.succeed(child.handle), () => child.release),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      expect(child.released()).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
