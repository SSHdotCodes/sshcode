import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as MonitorService from "./MonitorService.ts";

const threadId = ThreadId.make("thread:monitor-process-test");

describe("monitor process groups", () => {
  it.live("reports an exit signal", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const service = yield* MonitorService.MonitorService;
      yield* service.start({
        threadId,
        cwd: process.cwd(),
        requestNamespace: "test",
        command: "kill -TERM $$",
        description: "Signal test",
      });
      const [event] = yield* service.events.pipe(Stream.take(1), Stream.runCollect);
      expect(event?.notification).toMatchObject({
        outcome: "failed",
        summary: "Signal test: exited on signal SIGTERM",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(MonitorService.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  );

  it.live("kills descendants that ignore SIGTERM", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const service = yield* MonitorService.MonitorService;
      const { monitorId } = yield* service.start({
        threadId,
        cwd: process.cwd(),
        requestNamespace: "test",
        command: "sh -c 'trap \"\" TERM; echo descendant:$$; while :; do sleep 60; done' & wait",
        description: "Process group test",
      });
      const [event] = yield* service.events.pipe(Stream.take(1), Stream.runCollect);
      const pid = Number(/descendant:(\d+)/.exec(event?.notification.detail ?? "")?.[1]);
      expect(pid).toBeGreaterThan(1);
      expect(yield* service.stop(threadId, monitorId)).toBe(true);
      // This PID came from the child we spawned, never from matching other processes.
      expect(() => process.kill(pid, 0)).toThrow();
    }).pipe(
      Effect.scoped,
      Effect.provide(MonitorService.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  );

  it.live("delivers buffered output and stderr with the exit status", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) === "win32") return;
      const service = yield* MonitorService.MonitorService;
      yield* service.start({
        threadId,
        cwd: process.cwd(),
        requestNamespace: "test",
        command: "printf 'one\\ntwo'; printf 'problem' >&2; exit 4",
        description: "Exit test",
      });
      const events = yield* service.events.pipe(
        Stream.takeUntil((event) => event.notification.outcome === "failed"),
        Stream.runCollect,
      );
      // Output still batched at exit rides with the exit status: one wake.
      expect(events.map((event) => event.notification.detail)).toEqual([
        "one\ntwo\nStderr tail:\nproblem",
      ]);
      expect(events.at(-1)?.notification.summary).toBe("Exit test: exited with code 4");
    }).pipe(
      Effect.scoped,
      Effect.provide(MonitorService.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
  );
});
