import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as MonitorService from "./MonitorService.ts";

const threadId = ThreadId.make("thread:monitor-restart-test");

/** One server lifetime: the layer's scope closing is the server shutting down. */
const serverRun =
  (baseDir: string) =>
  <A, E>(body: (service: MonitorService.MonitorService["Service"]) => Effect.Effect<A, E>) =>
    Effect.gen(function* () {
      return yield* body(yield* MonitorService.MonitorService);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        MonitorService.layer.pipe(
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );

const journalFile = (baseDir: string) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(baseDir, "userdata", "monitors.json");
  });

const readJournal = (baseDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* journalFile(baseDir);
    if (!(yield* fs.exists(file))) return [];
    return (
      JSON.parse(yield* fs.readFileString(file)) as { monitors: Array<{ monitorId: string }> }
    ).monitors;
  });

const start = (
  service: MonitorService.MonitorService["Service"],
  input: Partial<Parameters<MonitorService.MonitorService["Service"]["start"]>[0]> & {
    readonly command: string;
  },
) =>
  service.start({
    threadId,
    cwd: process.cwd(),
    requestNamespace: "test",
    description: "Restart test",
    ...input,
  });

describe("monitors across a server restart", () => {
  it.live.each([undefined, "^line|^after"])(
    "relaunches a restartable monitor without repeating what it reported (wakeOn=%s)",
    (wakeOn) =>
      Effect.gen(function* () {
        if ((yield* HostProcess.Platform) === "win32") return;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "monitor-restart-" });
        const mark = path.join(baseDir, "ran-once");
        // Prints the same two lines every launch, and one more after the first.
        const command = `printf 'line-a\\nline-b\\nnoise\\n'; if [ -f '${mark}' ]; then echo after-restart; fi; touch '${mark}'; sleep 600`;

        const first = yield* serverRun(baseDir)((service) =>
          Effect.gen(function* () {
            const { monitorId } = yield* start(service, {
              command,
              restartable: true,
              ...(wakeOn === undefined ? {} : { wakeOn }),
            });
            const [event] = yield* service.events.pipe(Stream.take(1), Stream.runCollect);
            expect(event?.notification.detail).toBe(
              wakeOn === undefined ? "line-a\nline-b\nnoise" : "line-a\nline-b",
            );
            const info = (yield* service.list(threadId))[0];
            expect(info).toMatchObject({ monitorId, restartable: true });
            return { monitorId, sequence: event!.sequence };
          }),
        );
        // The shutdown kept it in the private journal.
        expect((yield* readJournal(baseDir)).map((entry) => entry.monitorId)).toEqual([
          first.monitorId,
        ]);
        const file = yield* journalFile(baseDir);
        expect((yield* fs.stat(file)).mode & 0o777).toBe(0o600);

        yield* serverRun(baseDir)((service) =>
          Effect.gen(function* () {
            // Until recovery runs, a waiting delegated task still counts it as open.
            expect(service.hasOpenWork(threadId)).toBe(true);
            expect(yield* service.list(threadId)).toMatchObject([
              { monitorId: first.monitorId, state: "recovering", restartable: true },
            ]);
            yield* service.recover(() => Effect.succeed("ok"));
            const [event] = yield* service.events.pipe(Stream.take(1), Stream.runCollect);
            expect(event?.monitorId).toBe(first.monitorId);
            expect(event?.notification.detail).toBe("after-restart");
            // New ids, so delivery never mistakes it for an event already handled.
            expect(event!.sequence).toBeGreaterThan(first.sequence);
            const [monitor] = yield* service.list(threadId);
            expect(monitor?.monitorId).toBe(first.monitorId);
            expect(monitor?.state).toBeUndefined();
            expect(yield* service.stop(threadId, first.monitorId)).toBe(true);
          }),
        );
        // Stopped and reported: the next restart has nothing to bring back.
        expect(yield* readJournal(baseDir)).toEqual([]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("returns the recovered watcher when its caller retries the same request", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "monitor-retry-" });
      const request = { command: "sleep 600", restartable: true, clientRequestId: "wait-1" };
      const first = yield* serverRun(baseDir)((service) => start(service, request));
      for (const requestNamespace of ["second-session", "third-session"]) {
        yield* serverRun(baseDir)((service) =>
          Effect.gen(function* () {
            const retry = { ...request, requestNamespace };
            expect(yield* start(service, retry)).toEqual(first);
            yield* service.recover(() => Effect.succeed("ok"));
            expect(yield* start(service, retry)).toEqual(first);
            const conflict = yield* start(service, { ...retry, command: "sleep 601" }).pipe(
              Effect.flip,
            );
            expect(conflict.reason).toBe("invalid-request");
            expect((yield* service.list(threadId)).map((entry) => entry.monitorId)).toEqual([
              first.monitorId,
            ]);
          }),
        );
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("tells the thread about a monitor the restart ended", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "monitor-restart-" });
      const { monitorId } = yield* serverRun(baseDir)((service) =>
        start(service, { command: "sleep 600", description: "Wait for training" }),
      );

      yield* serverRun(baseDir)((service) =>
        Effect.gen(function* () {
          yield* service.recover(() => Effect.succeed("ok"));
          const [event] = yield* service.events.pipe(Stream.take(1), Stream.runCollect);
          expect(event?.monitorId).toBe(monitorId);
          expect(event?.notification).toMatchObject({
            outcome: "failed",
            summary: "Wait for training: ended: the server restarted before it reported a result",
          });
          expect(event?.notification.detail).toContain("restartable:true");
          expect(yield* service.list(threadId)).toEqual([]);
        }),
      );
      expect(yield* readJournal(baseDir)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops an individual restartable watcher before recovery can relaunch it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "monitor-stop-recovery-" });
      const first = yield* serverRun(baseDir)((service) =>
        start(service, { command: "sleep 600", restartable: true }),
      );
      yield* serverRun(baseDir)((service) =>
        Effect.gen(function* () {
          expect(yield* service.stop(threadId, first.monitorId)).toBe(true);
          yield* service.recover(() => Effect.succeed("ok"));
          expect(service.hasOpenWork(threadId)).toBe(false);
          expect(yield* service.list(threadId)).toEqual([]);
        }),
      );
      expect(yield* readJournal(baseDir)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("removes a recovering restartable monitor when the thread no longer allows it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "monitor-restart-denied-" });
      const { monitorId } = yield* serverRun(baseDir)((service) =>
        start(service, { command: "sleep 600", restartable: true }),
      );
      yield* serverRun(baseDir)((service) =>
        Effect.gen(function* () {
          expect(yield* service.list(threadId)).toMatchObject([{ monitorId, state: "recovering" }]);
          yield* service.recover(() => Effect.succeed("denied"));
          const [event] = yield* service.events.pipe(Stream.take(1), Stream.runCollect);
          expect(event?.monitorId).toBe(monitorId);
          expect(event?.notification.outcome).toBe("failed");
          expect(yield* service.list(threadId)).toEqual([]);
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("forgets monitors of threads that are gone, and those stopped before recovery", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "monitor-restart-" });
      yield* serverRun(baseDir)((service) =>
        start(service, { command: "sleep 600", restartable: true }),
      );
      yield* serverRun(baseDir)((service) =>
        Effect.gen(function* () {
          yield* service.recover(() => Effect.succeed("gone"));
          expect(service.hasOpenWork(threadId)).toBe(false);
          expect(yield* service.list(threadId)).toEqual([]);
        }),
      );
      expect(yield* readJournal(baseDir)).toEqual([]);

      yield* serverRun(baseDir)((service) =>
        start(service, { command: "sleep 600", restartable: true }),
      );
      yield* serverRun(baseDir)((service) =>
        Effect.gen(function* () {
          // The user pressed Stop before recovery ran: never relaunch it.
          yield* service.stopThread(threadId);
          yield* service.recover(() => Effect.succeed("ok"));
          expect(yield* service.list(threadId)).toEqual([]);
        }),
      );
      expect(yield* readJournal(baseDir)).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("wakes once when the command goes quiet, and again only after new output", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      yield* Effect.gen(function* () {
        const service = yield* MonitorService.MonitorService;
        yield* service.start({
          threadId,
          cwd: process.cwd(),
          requestNamespace: "test",
          command: "echo started; sleep 600",
          description: "Training",
          silenceMs: 1_500,
        });
        const events = yield* service.events.pipe(Stream.take(2), Stream.runCollect);
        expect(events.map((event) => event.notification.summary)).toEqual([
          "Training: output",
          "Training: no output for 0 min",
        ]);
        expect(events[1]?.notification.outcome).toBe("updated");
        // Still quiet: no second silence wake.
        const more = yield* service.events.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.timeoutOption("2500 millis"),
        );
        expect(more._tag).toBe("None");
      }).pipe(
        Effect.scoped,
        Effect.provide(MonitorService.layer.pipe(Layer.provide(NodeServices.layer))),
      );
    }),
  );
});
