import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { MonitorError } from "@t3tools/contracts";
import * as DurableJobProcess from "./DurableJobProcess.ts";

import { completeUtf8Length } from "./DurableJobProcess.ts";

it("stops a log read before a UTF-8 character that isn't all written yet", () => {
  const text = Buffer.from("ok 🎉 ✓");
  // Every cut inside the emoji or the check mark backs up to the character's start.
  for (let cut = 0; cut <= text.length; cut++) {
    const kept = completeUtf8Length(text, cut);
    expect(text.subarray(0, kept).toString("utf8")).not.toContain("�");
    expect(cut - kept).toBeLessThan(4);
  }
  expect(completeUtf8Length(text, text.length)).toBe(text.length);
  expect(completeUtf8Length(Buffer.from("plain"), 5)).toBe(5);
  // "ok " + the emoji's first two bytes: only "ok " is whole.
  expect(completeUtf8Length(text, 5)).toBe(3);
});

it.live("names read and adoption failures instead of reporting a start failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "monitor-errors-" });
    const jobs = yield* DurableJobProcess.DurableJobProcess;
    const job = {
      pid: 2,
      startTime: "not-a-process",
      logPath: directory,
      exitPath: `${directory}/missing`,
      gatePath: `${directory}/missing/start`,
      offset: 0,
      partial: "",
    };
    expect((yield* jobs.read(job).pipe(Effect.flip)).reason).toBe("read");
    expect((yield* jobs.tail(job).pipe(Effect.flip)).reason).toBe("read");
    expect((yield* jobs.release(job).pipe(Effect.flip)).reason).toBe("adopt");
  }).pipe(
    Effect.scoped,
    Effect.provide(DurableJobProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

it.live("names a process shutdown failure as stop", () =>
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) === "win32") return;
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "monitor-stop-error-" });
    const jobs = yield* DurableJobProcess.DurableJobProcess;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const ready = `${directory}/ready`;
    expect(Number(yield* spawner.exitCode(ChildProcess.make("mkfifo", [ready])))).toBe(0);
    const job = yield* jobs.start({ directory, cwd: directory, command: "printf ready > ready" });
    yield* Effect.addFinalizer(() => jobs.stop(job).pipe(Effect.ignoreCause));
    yield* jobs.release(job);
    // The child command runs after the leader installs its TERM trap. Until then
    // stopping can succeed without reading the intentionally invalid receipt.
    expect(yield* fs.readFileString(ready)).toBe("ready");
    expect((yield* jobs.stop({ ...job, exitPath: directory }).pipe(Effect.flip)).reason).toBe(
      "stop",
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(DurableJobProcess.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  ),
);

it.each([
  ["read", "Could not read the monitor output or process state."],
  ["stop", "Could not stop the monitor command."],
  ["adopt", "Could not adopt the durable monitor command."],
  ["storage", "Could not save the monitor state."],
] as const)("reports the %s operation in the surfaced error", (reason, message) => {
  expect(new MonitorError({ reason }).message).toBe(message);
});
