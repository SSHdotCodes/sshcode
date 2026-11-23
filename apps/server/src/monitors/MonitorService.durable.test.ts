// @effect-diagnostics nodeBuiltinImport:off -- real process and filesystem milestones verify restart survival.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as DurableJobProcess from "./DurableJobProcess.ts";
import * as MonitorService from "./MonitorService.ts";

const threadId = ThreadId.make("thread:durable-test");
const input = {
  threadId,
  cwd: process.cwd(),
  requestNamespace: "durable-test",
  description: "Build",
  durable: true,
};
const decodeJob = Schema.decodeUnknownEffect(DurableJobProcess.DurableJob);
const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const serverRun = <A, E>(
  base: string,
  body: (service: MonitorService.MonitorService["Service"]) => Effect.Effect<A, E>,
) =>
  Effect.flatMap(MonitorService.MonitorService, body).pipe(
    Effect.scoped,
    Effect.provide(
      MonitorService.layer.pipe(
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), base)),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );
const nextEvent = (service: MonitorService.MonitorService["Service"]) =>
  service.events.pipe(
    Stream.take(1),
    Stream.runCollect,
    Effect.map((events) => events[0]!),
  );
const fileExists = (path: string) =>
  Effect.promise(() =>
    NodeFSP.access(path).then(
      () => true,
      () => false,
    ),
  );
const watchFile = (path: string) =>
  Effect.callback<void>((resume) => {
    let closed = false;
    const check = () => {
      void NodeFSP.access(path).then(
        () => {
          if (!closed) resume(Effect.void);
        },
        () => undefined,
      );
    };
    const watcher = NodeFS.watch(NodePath.dirname(path), check);
    check();
    return Effect.sync(() => {
      closed = true;
      watcher.close();
    });
  });
// The watch alone hung this file for its whole two minutes when macOS delivered the event
// late or not at all (a loaded fseventsd), so the file is also looked for directly.
const waitFile = (path: string) =>
  Effect.raceFirst(
    watchFile(path),
    fileExists(path).pipe(
      Effect.repeat({ until: (exists) => exists, schedule: Schedule.spaced("100 millis") }),
      Effect.asVoid,
    ),
  );
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const base = yield* fs.makeTempDirectoryScoped({ prefix: "durable-job-" });
  const processes = yield* DurableJobProcess.DurableJobProcess;
  const saved = Effect.gen(function* () {
    const journal = JSON.parse(yield* fs.readFileString(`${base}/userdata/monitors.json`)) as {
      monitors: Array<{ job: unknown }>;
    };
    return yield* decodeJob(journal.monitors[0]!.job);
  });
  // Even a failed assertion must not leave the test's own detached job running.
  yield* Effect.addFinalizer(() => saved.pipe(Effect.flatMap(processes.stop), Effect.ignoreCause));
  return { fs, base, saved, processes };
});
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    return yield* effect;
  }).pipe(
    Effect.scoped,
    Effect.provide(DurableJobProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  );

describe("durable monitors", () => {
  it.live("retains old job logs when the durable journal cannot be decoded", () =>
    provide(
      Effect.gen(function* () {
        const { base, fs } = yield* fixture;
        const directory = `${base}/userdata/jobs/monitor-00000000-0000-0000-0000-000000000000`;
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(`${directory}/output.log`, "recoverable output");
        yield* fs.writeFileString(`${directory}/exit`, "0\n");
        yield* fs.utimes(`${directory}/exit`, 0, 0);
        yield* fs.writeFileString(`${base}/userdata/monitors.json`, "unreadable journal");
        yield* serverRun(base, () =>
          Effect.gen(function* () {
            expect(yield* fs.readFileString(`${directory}/output.log`)).toBe("recoverable output");
          }),
        );
      }),
    ),
  );

  it.live("expires a delivered completed job after seven days when the server next opens", () =>
    provide(
      Effect.gen(function* () {
        const { base, fs } = yield* fixture;
        let logPath = "";
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            const result = yield* service.start({ ...input, command: "echo completed" });
            logPath = result.logPath!;
            const event = yield* nextEvent(service);
            yield* service.acknowledge(event);
            const marker = NodePath.join(NodePath.dirname(logPath), ".delivered.json");
            expect(yield* fs.exists(marker)).toBe(true);
            yield* fs.writeFileString(marker, JSON.stringify({ version: 1, deliveredAt: 0 }));
            expect(yield* fs.readFileString(logPath)).toBe("completed\n");
          }),
        );
        yield* serverRun(base, () =>
          Effect.gen(function* () {
            expect(yield* fs.exists(NodePath.dirname(logPath))).toBe(false);
          }),
        );
      }),
    ),
  );

  it.live("keeps a finished job's full log after delivering its bounded result", () =>
    provide(
      Effect.gen(function* () {
        const { base, fs } = yield* fixture;
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            const result = yield* service.start({
              ...input,
              command:
                "echo first-line; i=0; while [ $i -lt 1000 ]; do echo output-line-$i; i=$((i+1)); done; echo final-result",
            });
            const event = yield* nextEvent(service);
            expect(event.notification.outcome).toBe("completed");
            expect(event.notification.detail).toContain(`Log: ${result.logPath}`);
            expect(event.notification.detail).toContain("final-result");
            expect(event.notification.detail).not.toContain("first-line");
            expect(Buffer.byteLength(event.notification.detail!)).toBeLessThan(2_000);
            yield* service.acknowledge(event);
            expect(yield* service.list(threadId)).toEqual([]);
            const log = yield* fs.readFileString(result.logPath!);
            expect(log).toContain("first-line");
            expect(log).toContain("output-line-999");
            expect(log).toContain("final-result");
          }),
        );
      }),
    ),
  );

  it.live("appends stdout and stderr and wakes once on exit with a compact tail", () =>
    provide(
      Effect.gen(function* () {
        const { base, fs } = yield* fixture;
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            const result = yield* service.start({
              ...input,
              command: "printf 'hello\\n'; printf 'problem\\n' >&2; exit 7",
            });
            expect(result.logPath).toContain("/jobs/monitor-");
            const event = yield* nextEvent(service);
            yield* service.acknowledge(event);
            expect(event.notification.summary).toBe("Build: exited with code 7");
            expect(event.notification.outcome).toBe("failed");
            expect(event.notification.detail).toContain("hello\nproblem");
            expect(yield* fs.readFileString(result.logPath!)).toBe("hello\nproblem\n");
            expect(yield* service.list(threadId)).toEqual([]);
            expect(
              JSON.parse(yield* fs.readFileString(`${base}/userdata/monitors.json`)).monitors,
            ).toEqual([]);
          }),
        );
      }),
    ),
  );

  it.live("filters wake lines and never stops a job for output volume", () =>
    provide(
      Effect.gen(function* () {
        const { base, saved, processes, fs } = yield* fixture;
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            const result = yield* service.start({
              ...input,
              wakeOn: "^ready",
              command:
                "i=0; while [ $i -lt 20000 ]; do printf '%080d\\n' 0; i=$((i+1)); done; echo ready; echo ready-again; sleep 600",
            });
            const event = yield* nextEvent(service);
            expect(event.notification.summary).toBe("Build: output");
            expect(event.notification.detail).toBe("ready\nready-again");
            expect(yield* processes.alive(yield* saved)).toBe(true);
            expect(Number((yield* fs.stat(result.logPath!)).size)).toBeGreaterThan(1_048_576);
            expect(yield* service.stop(threadId, result.monitorId)).toBe(true);
            const stopped = yield* nextEvent(service);
            yield* service.acknowledge(stopped);
            expect(stopped.notification.outcome).toBe("cancelled");
            expect(stopped.notification.detail!.length).toBeLessThan(2_000);
          }),
        );
      }),
    ),
  );

  it.live(
    "shutdown leaves the group alive; adoption follows the same job without replay or relaunch",
    () =>
      provide(
        Effect.gen(function* () {
          const { base, saved, processes, fs } = yield* fixture;
          const fifo = `${base}/continue`;
          yield* Effect.promise(() => execFile("/usr/bin/mkfifo", [fifo]));
          const command = `echo launch >> '${base}/launches'; echo ready; read x < '${fifo}'; echo after; sleep 600`;
          const first = yield* serverRun(base, (service) =>
            Effect.gen(function* () {
              const result = yield* service.start({
                ...input,
                command,
                wakeOn: "ready|after",
                clientRequestId: "one",
              });
              expect((yield* nextEvent(service)).notification.detail).toBe("ready");
              return result;
            }),
          );
          const job = yield* saved;
          expect(yield* processes.alive(job)).toBe(true);
          yield* serverRun(base, (service) =>
            Effect.gen(function* () {
              expect(service.hasOpenWork(threadId)).toBe(true);
              expect((yield* service.list(threadId))[0]?.monitorId).toBe(first.monitorId);
              yield* service.recover(() => Effect.succeed("ok"));
              yield* service.recover(() => Effect.succeed("ok"));
              expect((yield* service.list(threadId))[0]).toMatchObject({
                ...first,
                durable: true,
                timeoutMs: null,
              });
              expect(
                yield* service.start({
                  ...input,
                  command,
                  wakeOn: "ready|after",
                  clientRequestId: "one",
                }),
              ).toEqual(first);
              yield* Effect.promise(() => NodeFSP.writeFile(fifo, "continue\n"));
              const event = yield* nextEvent(service);
              expect(event.notification.detail).toBe("after");
              expect(yield* fs.readFileString(`${base}/launches`)).toBe("launch\n");
              expect((yield* saved).pid).toBe(job.pid);
              yield* service.stopThread(threadId);
              expect(yield* processes.alive(job)).toBe(false);
              expect(service.canDeliver(yield* nextEvent(service))).toBe(false);
            }),
          );
        }),
      ),
  );

  it.live("an exit while the server is down produces one exit wake and is never relaunched", () =>
    provide(
      Effect.gen(function* () {
        const { base, fs, saved } = yield* fixture;
        const fifo = `${base}/continue`;
        yield* Effect.promise(() => execFile("/usr/bin/mkfifo", [fifo]));
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            yield* service.start({
              ...input,
              wakeOn: "ready",
              command: `echo launch >> '${base}/launches'; echo ready; read x < '${fifo}'; echo finished; exit 3`,
            });
            yield* nextEvent(service);
          }),
        );
        yield* Effect.promise(() => NodeFSP.writeFile(fifo, "continue\n"));
        yield* waitFile((yield* saved).exitPath);
        // The exit receipt exists before the next server is constructed.
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            yield* service.recover(() => Effect.succeed("ok"));
            const event = yield* nextEvent(service);
            yield* service.acknowledge(event);
            expect(event.notification.summary).toBe("Build: exited with code 3");
            expect(event.notification.detail).toContain("finished");
            yield* service.recover(() => Effect.succeed("ok"));
            expect(yield* service.list(threadId)).toEqual([]);
            expect(yield* fs.readFileString(`${base}/launches`)).toBe("launch\n");
          }),
        );
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            yield* service.recover(() => Effect.succeed("ok"));
            expect(service.hasOpenWork(threadId)).toBe(false);
          }),
        );
      }),
    ),
  );

  it.live("reuses an unacknowledged exit event id across recovery, then forgets it", () =>
    provide(
      Effect.gen(function* () {
        const { base } = yield* fixture;
        const first = yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            yield* service.start({ ...input, command: "echo done" });
            return yield* nextEvent(service);
          }),
        );
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            yield* service.recover(() => Effect.succeed("ok"));
            const event = yield* nextEvent(service);
            expect(event).toEqual(first);
            yield* service.acknowledge(event);
          }),
        );
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            yield* service.recover(() => Effect.succeed("ok"));
            expect(service.hasOpenWork(threadId)).toBe(false);
          }),
        );
      }),
    ),
  );

  it.live("rejects a reused PID identity on adoption and stop", () =>
    provide(
      Effect.gen(function* () {
        const { base, saved, processes, fs } = yield* fixture;
        const first = yield* serverRun(base, (service) =>
          service.start({ ...input, command: "sleep 600" }),
        );
        const job = yield* saved;
        yield* Effect.addFinalizer(() => processes.stop(job).pipe(Effect.ignoreCause));
        const foreign = { ...job, startTime: "a different process start" };
        yield* processes.stop(foreign);
        expect(yield* processes.alive(job)).toBe(true);
        const path = `${base}/userdata/monitors.json`;
        const journal = JSON.parse(yield* fs.readFileString(path));
        journal.monitors[0].job = foreign;
        yield* fs.writeFileString(path, JSON.stringify(journal));
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            yield* service.recover(() => Effect.succeed("ok"));
            const event = yield* nextEvent(service);
            yield* service.acknowledge(event);
            expect(event.monitorId).toBe(first.monitorId);
            expect(event.notification.summary).toContain("disappeared without an exit receipt");
            expect(yield* processes.alive(job)).toBe(true);
            yield* processes.stop(job);
          }),
        );
      }),
    ),
  );

  it.live("stop lets a TERM handler finish its checkpoint before reaping the group", () =>
    provide(
      Effect.gen(function* () {
        const { base, saved, processes, fs } = yield* fixture;
        yield* fs.writeFileString(
          `${base}/job.sh`,
          [
            "trap 'printf term > term; read -r resumed < continue; printf checkpoint > checkpoint; exit 0' TERM",
            "printf ready > ready",
            "while :; do sleep 3600; done",
          ].join("\n"),
        );
        yield* Effect.promise(() => execFile("/usr/bin/mkfifo", [`${base}/continue`]));
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            const result = yield* service.start({
              ...input,
              cwd: base,
              command: "exec /bin/sh ./job.sh",
            });
            const job = yield* saved;
            yield* waitFile(`${base}/ready`);
            const stopping = yield* service.stop(threadId, result.monitorId).pipe(Effect.forkChild);
            yield* waitFile(`${base}/term`);
            expect(stopping.pollUnsafe()).toBeUndefined();
            expect(yield* processes.alive(job)).toBe(true);
            yield* Effect.promise(() => NodeFSP.writeFile(`${base}/continue`, "finish\n"));
            expect(yield* Fiber.join(stopping)).toBe(true);
            expect(yield* fs.readFileString(`${base}/checkpoint`)).toBe("checkpoint");
            expect(yield* fs.readFileString(job.exitPath)).toBe("0\n");
            expect(yield* processes.alive(job)).toBe(false);
            yield* service.acknowledge(yield* nextEvent(service));
          }),
        );
      }),
    ),
  );

  it.live("stop escalates after ten seconds when the job handles TERM without exiting", () =>
    provide(
      Effect.gen(function* () {
        const { base, saved, processes, fs } = yield* fixture;
        yield* fs.writeFileString(
          `${base}/job.sh`,
          [
            "trap 'printf term > term' TERM",
            "printf ready > ready",
            "while :; do sleep 3600; done",
          ].join("\n"),
        );
        yield* serverRun(base, (service) =>
          service.start({ ...input, cwd: base, command: "exec /bin/sh ./job.sh" }),
        );
        const job = yield* saved;
        yield* waitFile(`${base}/ready`);
        const started = yield* Clock.currentTimeMillis;
        const stopping = yield* processes.stop(job).pipe(Effect.forkChild);
        yield* waitFile(`${base}/term`);
        expect(stopping.pollUnsafe()).toBeUndefined();
        expect(yield* processes.alive(job)).toBe(true);
        yield* Fiber.join(stopping);
        expect((yield* Clock.currentTimeMillis) - started).toBeGreaterThanOrEqual(10_000);
        expect(yield* processes.alive(job)).toBe(false);
        expect(yield* fs.exists(job.exitPath)).toBe(false);
      }),
    ),
  );

  it.live("stop kills descendants that ignore TERM, including before recovery", () =>
    provide(
      Effect.gen(function* () {
        const { base, saved, processes } = yield* fixture;
        const result = yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            const result = yield* service.start({
              ...input,
              wakeOn: "^descendant:",
              command:
                "sh -c 'trap \"\" TERM; echo descendant:$$; while :; do sleep 60; done' & wait",
            });
            const event = yield* nextEvent(service);
            const pid = Number(/descendant:(\d+)/.exec(event.notification.detail!)?.[1]);
            expect(pid).toBeGreaterThan(1);
            return { ...result, pid };
          }),
        );
        const job = yield* saved;
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            expect(yield* service.stop(threadId, result.monitorId)).toBe(true);
            yield* service.recover(() => Effect.succeed("ok"));
            expect(service.hasOpenWork(threadId)).toBe(false);
          }),
        );
        expect(yield* processes.alive(job)).toBe(false);
        // This PID came from the command we spawned, never from process-name matching.
        expect(() => process.kill(result.pid, 0)).toThrow();
      }),
    ),
  );

  it.live("stop still kills the group when its log was removed", () =>
    provide(
      Effect.gen(function* () {
        const { base, fs, saved, processes } = yield* fixture;
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            const result = yield* service.start({ ...input, command: "sleep 600" });
            const job = yield* saved;
            yield* fs.remove(result.logPath!);
            expect(yield* service.stop(threadId, result.monitorId)).toBe(true);
            expect(yield* processes.alive(job)).toBe(false);
            yield* service.acknowledge(yield* nextEvent(service));
          }),
        );
      }),
    ),
  );

  it.live("rejects invalid filters and incompatible restart options before launch", () =>
    provide(
      Effect.gen(function* () {
        const { base } = yield* fixture;
        yield* serverRun(base, (service) =>
          Effect.gen(function* () {
            for (const options of [{ wakeOn: "[" }, { restartable: true }, { silenceMs: 60_000 }]) {
              expect(
                (yield* service
                  .start({ ...input, command: "exit 0", ...options })
                  .pipe(Effect.flip)).reason,
              ).toBe("invalid-options");
            }
            expect(yield* service.list(threadId)).toEqual([]);
            yield* service.start({ ...input, command: "sleep 600", clientRequestId: "filter" });
            expect(
              (yield* service
                .start({ ...input, command: "sleep 600", clientRequestId: "filter", wakeOn: "" })
                .pipe(Effect.flip)).reason,
            ).toBe("invalid-request");
            yield* service.stopThread(threadId);
          }),
        );
      }),
    ),
  );
});
