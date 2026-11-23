import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as MonitorDelivery from "./MonitorDelivery.ts";
import * as MonitorService from "./MonitorService.ts";

it.live("delivers process output and exit through server notification wakes", () =>
  Effect.gen(function* () {
    const commands =
      yield* Queue.unbounded<Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0]>();
    yield* Effect.gen(function* () {
      const monitors = yield* MonitorService.MonitorService;
      yield* monitors.start({
        threadId: ThreadId.make("delivery"),
        command: "printf 'ready\\n'",
        description: "Service",
        cwd: process.cwd(),
        requestNamespace: "test",
      });
      // The process prints and exits at once, so its output rides with its end: one wake.
      const exit = yield* Queue.take(commands);
      expect(exit).toMatchObject({
        type: "message.dispatch",
        createdBy: "agent",
        creationSource: "server",
        dispatchMode: { type: "queue_after_active" },
        notification: {
          source: { kind: "monitor" },
          outcome: "completed",
          summary: "Service: exited with code 0",
          detail: "ready",
        },
      });
      if (exit.type === "message.dispatch")
        expect(exit.messageId).toMatch(/^message:monitor:0:monitor:/);
      expect(yield* Queue.size(commands)).toBe(0);
    }).pipe(
      Effect.provide(
        MonitorDelivery.layer.pipe(
          Layer.provideMerge(MonitorService.layer),
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              dispatch: (command) =>
                Queue.offer(commands, command).pipe(Effect.as({ sequence: 0, storedEvents: [] })),
              streamDomainEvents: Stream.never,
              getThreadShell: () => Effect.succeed(null),
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])(
  "holds an idle thread's output and delivers a compact wake (durable=%s)",
  (durable) =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("held");
      const events = yield* Queue.unbounded<MonitorService.MonitorEvent>();
      const commands =
        yield* Queue.unbounded<Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0]>();
      let busy = false;
      let sequence = 0;
      const offer = (detail: string, outcome: "updated" | "completed" = "updated") => {
        const summary = outcome === "updated" ? "output" : "exited with code 0";
        return Queue.offer(events, {
          monitorId: "monitor:watch",
          durable,
          threadId,
          generation: 0,
          sequence: ++sequence,
          text: `Monitor "Watch" (monitor:watch): ${summary}\n${detail}`,
          notification: {
            source: { kind: "monitor" },
            outcome,
            summary: `Watch: ${summary}`,
            ...(detail ? { detail } : {}),
          },
        });
      };
      const detailOf = (
        command: Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0],
      ) => (command.type === "message.dispatch" ? command.notification?.detail : undefined);

      yield* Effect.gen(function* () {
        // The first output wakes the thread at once.
        yield* offer("one");
        expect(detailOf(yield* Queue.take(commands))).toBe("one");

        // More output while the thread is idle waits out the interval, then goes as one wake.
        yield* offer("two");
        yield* offer("three");
        yield* TestClock.adjust("1 minute");
        expect(yield* Queue.size(commands)).toBe(0);
        yield* TestClock.adjust("1 minute");
        const combined = yield* Queue.take(commands);
        expect(detailOf(combined)).toBe(durable ? "three" : "two\nthree");
        if (combined.type === "message.dispatch") {
          expect(combined.text).toBe(
            `Monitor "Watch" (monitor:watch): output\n${durable ? "three" : "two\nthree"}`,
          );
          expect(combined.messageId).toBe("message:monitor:0:monitor:watch:3");
        }

        // A busy thread takes output at once as a steer.
        busy = true;
        yield* offer("four");
        expect(detailOf(yield* Queue.take(commands))).toBe("four");

        // Held output goes out with the monitor's end, at once.
        busy = false;
        yield* offer("five");
        yield* TestClock.adjust("10 seconds");
        expect(yield* Queue.size(commands)).toBe(0);
        const exitDetail = durable ? "Log: /tmp/output.log\nlast" : "";
        yield* offer(exitDetail, "completed");
        const end = yield* Queue.take(commands);
        expect(end).toMatchObject({
          notification: {
            outcome: "completed",
            summary: "Watch: exited with code 0",
            detail: durable ? exitDetail : "five",
          },
        });
      }).pipe(
        Effect.provide(
          MonitorDelivery.layer.pipe(
            Layer.provide(
              Layer.mock(MonitorService.MonitorService)({
                events: Stream.fromQueue(events),
                acknowledge: () => Effect.void,
                canDeliver: () => true,
                ownsCwd: () => false,
                hasOpenWork: () => true,
              }),
            ),
            Layer.provide(
              Layer.mock(Orchestrator.OrchestratorV2)({
                dispatch: (command) =>
                  Queue.offer(commands, command).pipe(Effect.as({ sequence: 0, storedEvents: [] })),
                streamDomainEvents: Stream.never,
                getThreadShell: () =>
                  Effect.succeed({
                    activeRunId: busy ? "run:busy" : null,
                  } as unknown as OrchestrationV2ThreadShell),
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);

it.effect("a stuck-job notice skips the idle hold and carries the output held before it", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("stuck");
    const events = yield* Queue.unbounded<MonitorService.MonitorEvent>();
    const commands =
      yield* Queue.unbounded<Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0]>();
    let sequence = 0;
    const offer = (summary: string, detail: string, urgent = false) =>
      Queue.offer(events, {
        monitorId: "monitor:train",
        threadId,
        generation: 0,
        sequence: ++sequence,
        ...(urgent ? { urgent } : {}),
        text: `Monitor "Train" (monitor:train): ${summary}${detail ? `\n${detail}` : ""}`,
        notification: {
          source: { kind: "monitor" },
          outcome: "updated",
          summary: `Train: ${summary}`,
          ...(detail ? { detail } : {}),
        },
      });
    yield* Effect.gen(function* () {
      yield* offer("output", "epoch 1");
      yield* Queue.take(commands);
      yield* offer("output", "retrying");
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.size(commands)).toBe(0);
      yield* offer("still running, same error 4× in 9 min: OSError: disk full", "", true);
      const stuck = yield* Queue.take(commands);
      expect(stuck).toMatchObject({
        text: 'Monitor "Train" (monitor:train): still running, same error 4× in 9 min: OSError: disk full\nretrying',
        notification: {
          summary: "Train: still running, same error 4× in 9 min: OSError: disk full",
        },
      });
      // Ordinary output after it waits out the interval again.
      yield* offer("output", "epoch 2");
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.size(commands)).toBe(0);
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.take(commands)).toMatchObject({ notification: { detail: "epoch 2" } });
    }).pipe(
      Effect.provide(
        MonitorDelivery.layer.pipe(
          Layer.provide(
            Layer.mock(MonitorService.MonitorService)({
              events: Stream.fromQueue(events),
              acknowledge: () => Effect.void,
              canDeliver: () => true,
              ownsCwd: () => false,
              hasOpenWork: () => true,
            }),
          ),
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              dispatch: (command) =>
                Queue.offer(commands, command).pipe(Effect.as({ sequence: 0, storedEvents: [] })),
              streamDomainEvents: Stream.never,
              getThreadShell: () =>
                Effect.succeed({ activeRunId: null } as unknown as OrchestrationV2ThreadShell),
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("acknowledges a completion only once it is delivered, retrying a failed dispatch", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<MonitorService.MonitorEvent>();
    const acknowledged: number[] = [];
    let failures = 2;
    let attempts = 0;
    yield* Effect.gen(function* () {
      yield* Queue.offer(events, {
        monitorId: "monitor:build",
        durable: true,
        threadId: ThreadId.make("retry"),
        generation: 0,
        sequence: 1,
        text: 'Monitor "Build" (monitor:build): exited with code 0',
        notification: {
          source: { kind: "monitor" },
          outcome: "completed",
          summary: "Build: exited with code 0",
        },
      });
      yield* Effect.yieldNow;
      // The first dispatch failed, so the saved completion must still be there.
      expect(attempts).toBe(1);
      expect(acknowledged).toEqual([]);
      yield* TestClock.adjust("2 seconds");
      expect(attempts).toBe(2);
      expect(acknowledged).toEqual([]);
      yield* TestClock.adjust("4 seconds");
      expect(attempts).toBe(3);
      expect(acknowledged).toEqual([1]);
    }).pipe(
      Effect.provide(
        MonitorDelivery.layer.pipe(
          Layer.provide(
            Layer.mock(MonitorService.MonitorService)({
              events: Stream.fromQueue(events),
              acknowledge: (event) => Effect.sync(() => void acknowledged.push(event.sequence)),
              canDeliver: () => true,
              ownsCwd: () => false,
              hasOpenWork: () => true,
            }),
          ),
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              dispatch: () =>
                Effect.suspend(() => {
                  attempts++;
                  return failures-- > 0
                    ? (Effect.fail({ _tag: "ProjectionBusy" }) as never)
                    : Effect.succeed({ sequence: 0, storedEvents: [] });
                }),
              streamDomainEvents: Stream.never,
              getThreadShell: () => Effect.succeed(null),
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("discards a failed monitor wake when Stop invalidates it during backoff", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("stopped");
    const events = yield* Queue.unbounded<MonitorService.MonitorEvent>();
    const attempts = yield* Queue.unbounded<void>();
    const acknowledged = yield* Queue.unbounded<number>();
    let generation = 0;
    yield* Effect.gen(function* () {
      yield* Queue.offer(events, {
        monitorId: "monitor:build",
        durable: true,
        threadId,
        generation,
        sequence: 1,
        text: "Build finished",
        notification: { source: { kind: "monitor" }, outcome: "completed", summary: "Done" },
      });
      yield* Queue.take(attempts);
      generation++;
      yield* TestClock.adjust("3 seconds");
      expect(yield* Queue.size(attempts)).toBe(0);
      expect(yield* Queue.take(acknowledged)).toBe(1);
    }).pipe(
      Effect.provide(
        MonitorDelivery.layer.pipe(
          Layer.provide(
            Layer.mock(MonitorService.MonitorService)({
              events: Stream.fromQueue(events),
              acknowledge: (event) => Queue.offer(acknowledged, event.sequence).pipe(Effect.asVoid),
              canDeliver: (event) => event.generation === generation,
              hasOpenWork: () => true,
              ownsCwd: () => false,
              recover: () => Effect.void,
            }),
          ),
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              dispatch: () =>
                Queue.offer(attempts, undefined).pipe(
                  Effect.andThen(new Orchestrator.OrchestratorProjectionError({ threadId })),
                ),
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);

it.effect("keeps retrying adoption after startup with a bounded delay", () =>
  Effect.gen(function* () {
    const attempts = yield* Queue.unbounded<number>();
    let count = 0;
    yield* Effect.gen(function* () {
      expect(yield* Queue.take(attempts)).toBe(1);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Queue.take(attempts)).toBe(2);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.take(attempts)).toBe(3);
      yield* TestClock.adjust("20 seconds");
      expect(yield* Queue.take(attempts)).toBe(4);
      yield* TestClock.adjust("40 seconds");
      expect(yield* Queue.take(attempts)).toBe(5);
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.take(attempts)).toBe(6);
    }).pipe(
      Effect.provide(
        MonitorDelivery.layer.pipe(
          Layer.provide(
            Layer.mock(MonitorService.MonitorService)({
              events: Stream.never,
              hasOpenWork: () => true,
              ownsCwd: () => false,
              canDeliver: () => true,
              recover: () => Queue.offer(attempts, ++count).pipe(Effect.asVoid),
            }),
          ),
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({ getThreadShell: () => Effect.succeed(null) }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped),
);
