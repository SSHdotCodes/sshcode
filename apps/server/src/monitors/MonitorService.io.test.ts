import { CommandId } from "@t3tools/contracts";
import * as ExecutionResources from "../execution/ExecutionResources.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { MonitorError, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { systemError } from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as DurableJobProcess from "./DurableJobProcess.ts";
import * as MonitorService from "./MonitorService.ts";

const threadId = ThreadId.make("monitor-io");
const input = {
  threadId,
  cwd: "/checkout/nested",
  requestNamespace: "test",
  command: "build",
  description: "Build",
  durable: true,
};
type Read = Effect.Success<ReturnType<DurableJobProcess.DurableJobProcess["Service"]["read"]>>;
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "monitor-io-" });
  const attempts = yield* Queue.unbounded<{
    operation: "start" | "read" | "stop" | "adopt" | "storage";
    pid?: number;
  }>();
  const records = new Map<
    number,
    {
      job: DurableJobProcess.DurableJob;
      read: Deferred.Deferred<Read, MonitorError>;
      stop: Deferred.Deferred<void>;
      stopGate?: Deferred.Deferred<void>;
      failStop: boolean;
      failAdopt: boolean;
      stopped: boolean;
      releases: number;
    }
  >();
  let failWrites = false;
  let failReads = false;
  let startGate: Deferred.Deferred<void> | undefined;
  const jobs = DurableJobProcess.DurableJobProcess.of({
    start: ({ directory }) =>
      Effect.gen(function* () {
        const job = {
          pid: records.size + 100,
          startTime: "test",
          logPath: `${directory}/output.log`,
          exitPath: `${directory}/exit`,
          gatePath: `${directory}/start`,
          offset: 0,
          partial: "",
        };
        records.set(job.pid, {
          job,
          read: yield* Deferred.make<Read, MonitorError>(),
          stop: yield* Deferred.make<void>(),
          failStop: false,
          failAdopt: false,
          stopped: false,
          releases: 0,
        });
        yield* Queue.offer(attempts, { operation: "start", pid: job.pid });
        if (startGate !== undefined) yield* Deferred.await(startGate);
        return job;
      }),
    release: (job) =>
      Effect.gen(function* () {
        yield* Queue.offer(attempts, { operation: "adopt", pid: job.pid });
        const record = records.get(job.pid)!;
        if (record.failAdopt) return yield* new MonitorError({ reason: "adopt" });
        record.releases++;
      }),
    alive: (job) => Effect.sync(() => !records.get(job.pid)!.stopped),
    read: (job) =>
      Queue.offer(attempts, { operation: "read", pid: job.pid }).pipe(
        Effect.andThen(Deferred.await(records.get(job.pid)!.read)),
      ),
    tail: () => Effect.succeed("last line"),
    stop: (job) =>
      Effect.gen(function* () {
        const record = records.get(job.pid)!;
        yield* Queue.offer(attempts, { operation: "stop", pid: job.pid });
        if (record.failStop) return yield* new MonitorError({ reason: "stop" });
        if (record.stopGate !== undefined) yield* Deferred.await(record.stopGate);
        record.stopped = true;
        yield* Deferred.succeed(record.stop, undefined);
      }),
  });
  const storage = {
    ...fs,
    readFileString: (...args: Parameters<typeof fs.readFileString>) =>
      Effect.suspend(() =>
        failReads && args[0].endsWith("monitors.json")
          ? Effect.fail(
              systemError({ _tag: "Unknown", module: "FileSystem", method: "readFileString" }),
            )
          : fs.readFileString(...args),
      ),
    writeFileString: (...args: Parameters<typeof fs.writeFileString>) =>
      Effect.gen(function* () {
        if (failWrites && args[0].endsWith("monitors.json.partial")) {
          yield* Queue.offer(attempts, { operation: "storage" });
          return yield* Effect.fail(
            systemError({ _tag: "Unknown", module: "FileSystem", method: "writeFileString" }),
          );
        }
        return yield* fs.writeFileString(...args);
      }),
  };
  const run = <A, E, R>(
    body: (service: MonitorService.MonitorService["Service"]) => Effect.Effect<A, E, R>,
  ) =>
    Effect.flatMap(MonitorService.MonitorService, body).pipe(
      Effect.scoped,
      Effect.provide(
        MonitorService.layerWithJobs.pipe(
          Layer.provide(Layer.succeed(DurableJobProcess.DurableJobProcess, jobs)),
        ),
      ),
      Effect.provideService(FileSystem.FileSystem, storage),
      Effect.provide(ServerConfig.layerTest(process.cwd(), base)),
    );
  const nextAttempt = (operation: "start" | "read" | "stop" | "adopt" | "storage", pid?: number) =>
    Effect.gen(function* () {
      while (true) {
        const attempt = yield* Queue.take(attempts);
        if (attempt.operation === operation && (pid === undefined || attempt.pid === pid)) return;
      }
    });
  return {
    run,
    records,
    nextAttempt,
    setStartGate: (gate: Deferred.Deferred<void>) => {
      startGate = gate;
    },
    clearAttempts: Queue.clear(attempts),
    failReads: (fail: boolean) => {
      failReads = fail;
    },
    failWrites: (fail: boolean) => {
      failWrites = fail;
    },
    fs,
    base,
  };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

it.effect.each([
  [undefined, 0],
  [undefined, 7],
  [false, 0],
  [false, 7],
  ["^ready", 0],
  ["^ready", 7],
] as const)("durable monitors retain their wake behavior (wakeOn=%s, code=%s)", ([wakeOn, code]) =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run((service) =>
        Effect.gen(function* () {
          yield* service.start({ ...input, ...(wakeOn === undefined ? {} : { wakeOn }) });
          yield* f.nextAttempt("read");
          const record = [...f.records.values()][0]!;
          const feed = (output: string, exitCode?: number) =>
            Effect.gen(function* () {
              const waiting = record.read;
              record.read = yield* Deferred.make<Read, MonitorError>();
              yield* Deferred.succeed(waiting, {
                output,
                offset: output.length,
                end: exitCode !== undefined,
                exitCode,
              });
            });
          const events = yield* Queue.unbounded<MonitorService.MonitorEvent>();
          yield* service.events.pipe(
            Stream.runForEach((event) => Queue.offer(events, event)),
            Effect.forkChild,
          );
          yield* feed("progress\n");
          yield* f.nextAttempt("read");
          yield* TestClock.adjust("3 minutes");
          expect(yield* Queue.size(events)).toBe(0);
          yield* feed("ready milestone\n");
          yield* f.nextAttempt("read");
          if (typeof wakeOn === "string") {
            expect((yield* Queue.take(events)).notification).toMatchObject({
              outcome: "updated",
              detail: "ready milestone",
            });
          } else {
            expect(yield* Queue.size(events)).toBe(0);
          }
          yield* feed("unmatched final\n", code);
          const end = yield* Queue.take(events);
          expect(end.notification).toMatchObject({
            outcome: code === 0 ? "completed" : "failed",
            summary: `Build: exited with code ${code}`,
          });
          expect(end.notification.detail).toContain("Log:");
          yield* service.acknowledge(end);
        }),
      );
    }),
  ),
);

it.effect("wakes for a matching durable log line larger than the notification budget", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run((service) =>
        Effect.gen(function* () {
          yield* service.start({ ...input, wakeOn: "^READY" });
          yield* f.nextAttempt("read");
          yield* TestClock.adjust("6 seconds");
          const record = [...f.records.values()][0]!;
          const first = record.read;
          record.read = yield* Deferred.make<Read, MonitorError>();
          const output = "READY " + "x".repeat(2_000) + "\n";
          yield* Deferred.succeed(first, {
            output,
            offset: output.length,
            end: false,
            exitCode: undefined,
          });
          yield* f.nextAttempt("read");
          yield* Deferred.succeed(record.read, {
            output: "",
            offset: output.length,
            end: true,
            exitCode: 0,
          });
          const [notice] = yield* service.events.pipe(Stream.take(1), Stream.runCollect);
          expect(notice?.notification.outcome).toBe("updated");
          expect(notice?.notification.detail).toMatch(/^READY .* \[line truncated\]$/);
          expect(notice?.notification.detail?.length).toBeLessThanOrEqual(1_500);
        }),
      );
    }),
  ),
);

it.effect.each([false, true])(
  "a new provider session retries a durable start (legacy receipt: %s)",
  (legacyReceipt) =>
    provide(
      Effect.gen(function* () {
        const f = yield* fixture;
        const request = { ...input, clientRequestId: "build:1" };
        const first = yield* f.run((service) => service.start(request));
        if (legacyReceipt) {
          const path = `${f.base}/userdata/monitors.json`;
          const journal = JSON.parse(yield* f.fs.readFileString(path));
          journal.monitors[0].requestKey = "10:monitor-io4:test7:build:1";
          yield* f.fs.writeFileString(path, JSON.stringify(journal));
        }
        yield* f.run((service) =>
          Effect.gen(function* () {
            const retry = { ...request, requestNamespace: "new-session" };
            expect(yield* service.start(retry)).toEqual(first);
            yield* service.recover(() => Effect.succeed("ok"));
            expect(yield* service.start(retry)).toEqual(first);
            expect(f.records.size).toBe(1);
            const conflict = yield* service
              .start({ ...retry, command: "different" })
              .pipe(Effect.flip);
            expect(conflict.reason).toBe("invalid-request");
          }),
        );
      }),
    ),
);

it.effect("protects running and recoverable job cwd ancestors, but not sibling paths", () =>
  provide(
    Effect.gen(function* () {
      const { run, nextAttempt } = yield* fixture;
      const started = yield* run((service) =>
        Effect.gen(function* () {
          const started = yield* service.start(input);
          yield* nextAttempt("read");
          expect(service.ownsCwd("/checkout")).toBe(true);
          expect(service.ownsCwd("/checkout/nested")).toBe(true);
          expect(service.ownsCwd("/check")).toBe(false);
          expect(service.ownsCwd("/checkout/nested/child")).toBe(false);
          return started;
        }),
      );
      yield* run((service) =>
        Effect.gen(function* () {
          // No provider session or adoption is needed to keep the saved job's checkout.
          expect(service.ownsCwd("/checkout")).toBe(true);
          yield* service.stop(threadId, started.monitorId);
          expect(service.ownsCwd("/checkout")).toBe(false);
        }),
      );
    }),
  ),
);

it.effect.each(["blocked", "failed"] as const)(
  "stop kills a job independently of a %s log read",
  (mode) =>
    provide(
      Effect.gen(function* () {
        const { run, records, nextAttempt } = yield* fixture;
        yield* run((service) =>
          Effect.gen(function* () {
            const started = yield* service.start(input);
            yield* nextAttempt("read");
            const record = [...records.values()][0]!;
            if (mode === "failed")
              yield* Deferred.fail(record.read, new MonitorError({ reason: "read" }));
            expect(yield* service.stop(threadId, started.monitorId)).toBe(true);
            expect(record.stopped).toBe(true);
            expect(yield* service.list(threadId)).toEqual([]);
          }),
        );
      }),
    ),
);

it.effect("a slow shutdown does not hold global monitor admission", () =>
  provide(
    Effect.gen(function* () {
      const { run, records, nextAttempt } = yield* fixture;
      yield* run((service) =>
        Effect.gen(function* () {
          const first = yield* service.start(input);
          yield* nextAttempt("read");
          const record = [...records.values()][0]!;
          record.stopGate = yield* Deferred.make<void>();
          const stopping = yield* service.stop(threadId, first.monitorId).pipe(Effect.forkChild);
          yield* nextAttempt("stop");
          const second = yield* service.start({ ...input, threadId: ThreadId.make("other") });
          expect(second.monitorId).not.toBe(first.monitorId);
          yield* Deferred.succeed(record.stopGate, undefined);
          expect(yield* Fiber.join(stopping)).toBe(true);
          yield* service.stop(ThreadId.make("other"), second.monitorId);
        }),
      );
    }),
  ),
);

it.effect("stop returns a bounded storage failure and retains the completion for recovery", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run((service) =>
        Effect.gen(function* () {
          const started = yield* service.start(input);
          yield* f.nextAttempt("read");
          const record = [...f.records.values()][0]!;
          f.failWrites(true);
          const stopping = yield* service
            .stop(threadId, started.monitorId)
            .pipe(Effect.flip, Effect.forkChild);
          yield* f.nextAttempt("storage");
          expect(record.stopped).toBe(true);
          // Each retry includes a real filesystem step before its next clock wait.
          for (let retry = 0; retry < 2; retry++) {
            yield* TestClock.adjust("1 second");
            yield* f.nextAttempt("storage");
          }
          expect((yield* Fiber.join(stopping)).reason).toBe("storage");
          expect(service.hasOpenWork(threadId)).toBe(true);
          f.failWrites(false);
          yield* service.recover(() => Effect.succeed("ok"));
          const event = yield* service.events.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
          expect(event.notification.outcome).toBe("cancelled");
          yield* service.acknowledge(event);
          expect(service.hasOpenWork(threadId)).toBe(false);
        }),
      );
    }),
  ),
);

it.effect.each(["adopt", "stop"] as const)(
  "recovery isolates an entry's %s failure and retries it",
  (operation) =>
    provide(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.run((service) =>
          Effect.gen(function* () {
            yield* service.start(input);
            yield* service.start({ ...input, cwd: "/other-checkout" });
          }),
        );
        yield* f.clearAttempts;
        const [first, second] = [...f.records.values()];
        first!.failAdopt = operation === "adopt";
        first!.failStop = operation === "stop";
        yield* f.run((service) =>
          Effect.gen(function* () {
            yield* service.recover(() => Effect.succeed(operation === "stop" ? "denied" : "ok"));
            expect(operation === "adopt" ? second!.releases : Number(second!.stopped)).toBe(
              operation === "adopt" ? 2 : 1,
            );
            expect(service.ownsCwd("/checkout")).toBe(true);
            first!.failAdopt = false;
            first!.failStop = false;
            yield* TestClock.adjust("1 second");
            yield* f.nextAttempt(operation, first!.job.pid);
            if (operation === "adopt") {
              yield* f.nextAttempt("read", first!.job.pid);
              expect(first!.releases).toBe(2);
              yield* service.stopThread(threadId);
            } else {
              yield* Deferred.await(first!.stop);
              yield* service.recover(() => Effect.succeed("gone"));
              expect(first!.stopped).toBe(true);
            }
          }),
        );
      }),
    ),
);

it.live("a pathological wakeOn is disabled without stopping the durable job", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run((service) =>
        Effect.gen(function* () {
          const started = yield* service.start({ ...input, wakeOn: "(a+)+$" });
          yield* f.nextAttempt("read");
          const record = [...f.records.values()][0]!;
          yield* Deferred.succeed(record.read, {
            output: `${"a".repeat(7_900)}!\n`,
            offset: 7_902,
            end: true,
            exitCode: undefined,
          });
          const event = yield* service.events.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
          expect(event.notification.summary).toBe("Build: wakeOn disabled");
          expect(record.stopped).toBe(false);
          expect(yield* service.stop(threadId, started.monitorId)).toBe(true);
          expect(record.stopped).toBe(true);
        }),
      );
    }),
  ),
);

it.effect("holds the child result and protects its cwd during durable job admission", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      const gate = yield* Deferred.make<void>();
      f.setStartGate(gate);
      yield* f.run((service) =>
        Effect.gen(function* () {
          const starting = yield* service.start(input).pipe(Effect.forkChild);
          yield* f.nextAttempt("start");
          const openDuringAdmission = service.hasOpenWork(threadId);
          expect(service.ownsCwd("/checkout")).toBe(true);
          yield* Deferred.succeed(gate, undefined);
          const result = yield* Fiber.join(starting);
          yield* service.stop(threadId, result.monitorId);
          expect(service.ownsCwd("/checkout")).toBe(false);
          expect(openDuringAdmission).toBe(true);
        }),
      );
    }),
  ),
);

it.effect("recovery retries are bounded and leave a failed entry recoverable", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run((service) => service.start(input));
      yield* f.clearAttempts;
      const record = [...f.records.values()][0]!;
      record.failAdopt = true;
      yield* f.run((service) =>
        Effect.gen(function* () {
          yield* service.recover(() => Effect.succeed("ok"));
          yield* f.clearAttempts;
          for (let attempt = 0; attempt < 3; attempt++) {
            yield* TestClock.adjust("1 second");
            yield* f.nextAttempt("adopt", record.job.pid);
          }
          yield* TestClock.adjust("1 minute");
          expect(yield* f.clearAttempts).toEqual([]);
          expect(service.ownsCwd("/checkout")).toBe(true);
          record.failAdopt = false;
          yield* service.recover(() => Effect.succeed("ok"));
          yield* f.nextAttempt("read", record.job.pid);
          expect(f.records.size).toBe(1);
          yield* service.stopThread(threadId);
        }),
      );
    }),
  ),
);

it.effect("thread stop cancels delivery despite log and notification I/O failures", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run((service) =>
        Effect.gen(function* () {
          yield* service.start(input);
          yield* f.nextAttempt("read");
          const record = [...f.records.values()][0]!;
          yield* Deferred.fail(record.read, new MonitorError({ reason: "read" }));
          f.failWrites(true);
          const stopping = yield* service.stopThread(threadId).pipe(Effect.forkChild);
          yield* f.nextAttempt("storage");
          expect(record.stopped).toBe(true);
          f.failWrites(false);
          yield* TestClock.adjust("1 second");
          yield* Fiber.join(stopping);
          const event = yield* service.events.pipe(Stream.runHead, Effect.map(Option.getOrThrow));
          expect(service.canDeliver(event)).toBe(false);
          expect(service.hasOpenWork(threadId)).toBe(false);
        }),
      );
    }),
  ),
);

it.effect.each(["stop", "stopThread"] as const)(
  "%s wins while recovery checks a saved durable job's thread",
  (method) =>
    provide(
      Effect.gen(function* () {
        const f = yield* fixture;
        const saved = yield* f.run((service) => service.start(input));
        yield* f.clearAttempts;
        const record = [...f.records.values()][0]!;
        const stopGate = yield* Deferred.make<void>();
        record.stopGate = stopGate;
        yield* f.run((service) =>
          Effect.gen(function* () {
            const checking = yield* Deferred.make<void>();
            const allow = yield* Deferred.make<"ok">();
            const recovery = yield* service
              .recover(() =>
                Deferred.succeed(checking, undefined).pipe(Effect.andThen(Deferred.await(allow))),
              )
              .pipe(Effect.forkChild);
            yield* Deferred.await(checking);
            const stopping = yield* (
              method === "stop"
                ? service.stop(threadId, saved.monitorId).pipe(Effect.asVoid)
                : service.stopThread(threadId)
            ).pipe(Effect.forkChild);
            yield* f.nextAttempt("stop");
            yield* Deferred.succeed(allow, "ok");
            yield* Fiber.join(recovery);
            yield* Deferred.succeed(stopGate, undefined);
            yield* Fiber.join(stopping);
            expect(record.releases).toBe(1);
            expect(service.hasOpenWork(threadId)).toBe(false);
          }),
        );
      }),
    ),
);

it.effect("a failed thread stop keeps cwd ownership and retries shutdown after restart", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run((service) =>
        Effect.gen(function* () {
          yield* service.start(input);
          yield* f.nextAttempt("read");
          const record = [...f.records.values()][0]!;
          record.failStop = true;
          yield* service.stopThread(threadId);
          expect(record.stopped).toBe(false);
          expect(service.ownsCwd("/checkout")).toBe(true);
        }),
      );
      const record = [...f.records.values()][0]!;
      record.failStop = false;
      yield* f.run((service) =>
        Effect.gen(function* () {
          yield* service.recover(() => Effect.succeed("ok"));
          expect(record.stopped).toBe(true);
          expect(record.releases).toBe(1);
          expect(service.ownsCwd("/checkout")).toBe(false);
          expect(service.hasOpenWork(threadId)).toBe(false);
        }),
      );
    }),
  ),
);

it.effect("enrolls a monitor before release and rebuilds ownership before recovery", () =>
  provide(
    Effect.gen(function* () {
      const { run, nextAttempt, setStartGate, fs, base } = yield* fixture;
      const gate = yield* Deferred.make<void>();
      setStartGate(gate);
      yield* run((service) =>
        Effect.gen(function* () {
          const ownership = yield* ExecutionResources.ExecutionResources;
          const starting = yield* service.start(input).pipe(Effect.forkChild);
          yield* nextAttempt("start");
          expect(yield* ownership.query({ directory: "/checkout", pinsOnly: true })).toMatchObject([
            { state: "admitted", owner: { threadId }, cleanupPin: true },
          ]);
          yield* Deferred.succeed(gate, undefined);
          yield* Fiber.join(starting);
          yield* nextAttempt("read");
        }),
      );
      // Older receipts have no generation; Stop must still find and kill them.
      const journalPath = `${base}/userdata/monitors.json`;
      yield* fs.writeFileString(
        journalPath,
        (yield* fs.readFileString(journalPath)).replace(/,"generation":\d+/g, ""),
      );
      yield* run(() =>
        Effect.gen(function* () {
          const ownership = yield* ExecutionResources.ExecutionResources;
          expect(yield* ownership.query({ threadId })).toMatchObject([
            { state: "recovering", cleanupPin: true },
          ]);
          yield* ownership.stopOwned({ threadId, commandId: CommandId.make("stop-recovered") });
          expect(yield* ownership.query({ directory: "/checkout", pinsOnly: true })).toEqual([]);
        }),
      );
    }),
  ),
);

it.effect(
  "refuses cleanup and new admission, but not Stop, when restart ownership cannot be read",
  () =>
    provide(
      Effect.gen(function* () {
        const { run, records, nextAttempt, failReads } = yield* fixture;
        yield* run((service) => service.start(input).pipe(Effect.andThen(nextAttempt("read"))));
        failReads(true);
        yield* run((service) =>
          Effect.gen(function* () {
            const ownership = yield* ExecutionResources.ExecutionResources;
            expect(
              (yield* Effect.result(ownership.query({ directory: "/checkout", pinsOnly: true })))
                ._tag,
            ).toBe("Failure");
            expect((yield* Effect.result(service.start(input)))._tag).toBe("Failure");
            // Stop still sees the monitors this process knows about.
            expect((yield* Effect.result(ownership.query({ threadId })))._tag).toBe("Success");
            expect(records.size).toBe(1);
          }),
        );
        failReads(false);
        yield* run(() =>
          Effect.gen(function* () {
            const ownership = yield* ExecutionResources.ExecutionResources;
            yield* ownership.stopOwned({
              threadId,
              commandId: CommandId.make("stop-after-storage-recovery"),
            });
            expect([...records.values()][0]!.stopped).toBe(true);
            expect(yield* ownership.query({ directory: "/checkout", pinsOnly: true })).toEqual([]);
          }),
        );
      }),
    ),
);

it.effect("reports a failed owned shutdown and retains its pin until retry succeeds", () =>
  provide(
    Effect.gen(function* () {
      const { run, records, nextAttempt } = yield* fixture;
      yield* run((service) =>
        Effect.gen(function* () {
          const ownership = yield* ExecutionResources.ExecutionResources;
          yield* service.start(input);
          yield* nextAttempt("read");
          const record = [...records.values()][0]!;
          record.failStop = true;
          const request = { threadId, commandId: CommandId.make("failed-owned-stop") };
          expect((yield* Effect.result(ownership.stopOwned(request)))._tag).toBe("Failure");
          expect(yield* ownership.query({ directory: "/checkout", pinsOnly: true })).toMatchObject([
            { state: "stopping", cleanupPin: true },
          ]);
          record.failStop = false;
          yield* ownership.stopOwned(request);
          expect(yield* ownership.query({ directory: "/checkout", pinsOnly: true })).toEqual([]);
        }),
      );
    }),
  ),
);

it.effect(
  "publishes recovering after follower I/O retries are exhausted and resumes the same job",
  () =>
    provide(
      Effect.gen(function* () {
        const f = yield* fixture;
        yield* f.run((service) =>
          Effect.gen(function* () {
            const started = yield* service.start(input);
            yield* f.nextAttempt("read");
            const record = [...f.records.values()][0]!;
            const recovering = yield* service.stream(threadId).pipe(
              Stream.filter((entries) => entries.some((entry) => entry.state === "recovering")),
              Stream.runHead,
              Effect.forkChild,
            );
            yield* Deferred.fail(record.read, new MonitorError({ reason: "read" }));
            for (let i = 0; i < 2; i++) {
              yield* TestClock.adjust("1 second");
              yield* f.nextAttempt("read");
            }
            expect(Option.getOrThrow(yield* Fiber.join(recovering))).toMatchObject([
              { monitorId: started.monitorId, state: "recovering" },
            ]);
            record.read = yield* Deferred.make<Read, MonitorError>();
            yield* service.recover(() => Effect.succeed("ok"));
            yield* f.nextAttempt("read");
            expect((yield* service.list(threadId))[0]?.state).toBeUndefined();
            expect(f.records.size).toBe(1);
            yield* service.stop(threadId, started.monitorId);
          }),
        );
      }),
    ),
);

it.effect("retains a recoverable job when its thread access cannot be read", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* f.run((service) => service.start(input));
      const record = [...f.records.values()][0]!;
      yield* f.run((service) =>
        Effect.gen(function* () {
          yield* service.recover(() => Effect.succeed("retry"));
          expect(record.stopped).toBe(false);
          expect(record.releases).toBe(1);
          expect((yield* service.list(threadId))[0]?.state).toBe("recovering");
          yield* service.recover(() => Effect.succeed("ok"));
          yield* f.nextAttempt("read");
          expect(record.releases).toBe(2);
          yield* service.stopThread(threadId);
        }),
      );
    }),
  ),
);

/** Feeds a fake durable job's next read and waits until the follower took it in. */
const makeFeed = (f: Effect.Success<typeof fixture>) => {
  let offset = 0;
  return (output: string, exitCode?: number) =>
    Effect.gen(function* () {
      const record = [...f.records.values()][0]!;
      const waiting = record.read;
      record.read = yield* Deferred.make<Read, MonitorError>();
      offset += output.length;
      yield* Deferred.succeed(waiting, { output, offset, end: exitCode !== undefined, exitCode });
      if (exitCode === undefined) yield* f.nextAttempt("read");
    });
};
const collect = (service: MonitorService.MonitorService["Service"]) =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<MonitorService.MonitorEvent>();
    yield* service.events.pipe(
      Stream.runForEach((event) => Queue.offer(events, event)),
      Effect.forkChild,
    );
    return events;
  });
const crash =
  "Traceback (most recent call last):\n" +
  '  File "/pkg/modal/_container_entrypoint.py", line 362, in hydrate_function\n' +
  "ModuleNotFoundError: No module named 'train'\n" +
  "Function fu-4pkLqHwJRQdvrYFnMI4eYy failed during startup.\n";

it.effect("a durable job repeating an error wakes once and keeps that across adoption", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      const feed = makeFeed(f);
      yield* f.run((service) =>
        Effect.gen(function* () {
          yield* service.start(input);
          yield* f.nextAttempt("read");
          const events = yield* collect(service);
          for (const minutes of [1, 1, 2]) {
            yield* feed(crash);
            yield* TestClock.adjust(`${minutes} minutes`);
          }
          // Three crashes arm it; the job still failing minutes later wakes the thread.
          expect(yield* Queue.size(events)).toBe(0);
          yield* feed(crash);
          const stuck = yield* Queue.take(events);
          expect(stuck).toMatchObject({
            urgent: true,
            notification: {
              outcome: "updated",
              summary:
                "Build: still running, same error 4× in 4 min: ModuleNotFoundError: No module named 'train'",
            },
          });
          expect(stuck.text).toBe(
            `Monitor "Build" (${stuck.monitorId}): still running, same error 4× in 4 min: ModuleNotFoundError: No module named 'train'`,
          );
          yield* feed(crash);
          expect(yield* Queue.size(events)).toBe(0);
        }),
      );
      yield* TestClock.adjust("10 minutes");
      yield* f.run((service) =>
        Effect.gen(function* () {
          const events = yield* collect(service);
          yield* service.recover(() => Effect.succeed("ok"));
          yield* f.nextAttempt("read");
          // The adopted follower remembers it already reported this error.
          yield* feed(crash);
          expect(yield* Queue.size(events)).toBe(0);
          for (const minutes of [1, 1, 2]) {
            yield* TestClock.adjust(`${minutes} minutes`);
            yield* feed("Error: connect ECONNREFUSED 127.0.0.1:5432\n");
          }
          expect(yield* Queue.size(events)).toBe(0);
          yield* TestClock.adjust("2 minutes");
          yield* feed("Error: connect ECONNREFUSED 127.0.0.1:5432\n");
          expect((yield* Queue.take(events)).notification.summary).toBe(
            "Build: still running, same error 4× in 5 min: Error: connect ECONNREFUSED 127.0.0.1:5432",
          );
          yield* feed(crash, 1);
          expect((yield* Queue.take(events)).notification.summary).toBe(
            "Build: exited with code 1",
          );
        }),
      );
    }),
  ),
);

it.effect("a durable job past its expected time wakes once, counted from its start", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      const feed = makeFeed(f);
      yield* f.run((service) =>
        Effect.gen(function* () {
          const events = yield* collect(service);
          yield* service.start({ ...input, expectMinutes: 5 });
          yield* f.nextAttempt("read");
          yield* feed("epoch 1\n");
          // Overdue at the later of 1.5× and ten minutes past the expected five.
          yield* TestClock.adjust("14 minutes");
          yield* feed("");
          expect(yield* Queue.size(events)).toBe(0);
        }),
      );
      // The deadline passes while the server is down.
      yield* TestClock.adjust("2 minutes");
      yield* f.run((service) =>
        Effect.gen(function* () {
          const events = yield* collect(service);
          yield* service.recover(() => Effect.succeed("ok"));
          yield* f.nextAttempt("read");
          yield* feed("");
          expect(yield* Queue.take(events)).toMatchObject({
            urgent: true,
            notification: {
              outcome: "updated",
              summary: "Build: still running after 16 min (expected 5 min); last output: last line",
            },
          });
          yield* TestClock.adjust("1 hour");
          yield* feed("");
          expect(yield* Queue.size(events)).toBe(0);
        }),
      );
      yield* f.run((service) =>
        Effect.gen(function* () {
          const events = yield* collect(service);
          yield* service.recover(() => Effect.succeed("ok"));
          yield* f.nextAttempt("read");
          yield* feed("");
          yield* feed("done\n", 0);
          // Adopted again: its exit is the only thing left to report.
          expect((yield* Queue.take(events)).notification.summary).toBe(
            "Build: exited with code 0",
          );
        }),
      );
    }),
  ),
);

it.effect("a durable job that exited while the server was down never wakes as overdue", () =>
  provide(
    Effect.gen(function* () {
      const f = yield* fixture;
      const feed = makeFeed(f);
      yield* f.run((service) => service.start({ ...input, expectMinutes: 5 }));
      yield* TestClock.adjust("1 hour");
      yield* f.run((service) =>
        Effect.gen(function* () {
          const events = yield* collect(service);
          yield* service.recover(() => Effect.succeed("ok"));
          yield* f.nextAttempt("read");
          yield* feed("done\n", 0);
          expect((yield* Queue.take(events)).notification.summary).toBe(
            "Build: exited with code 0",
          );
          yield* TestClock.adjust("1 hour");
          expect(yield* Queue.size(events)).toBe(0);
        }),
      );
    }),
  ),
);
