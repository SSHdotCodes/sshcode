import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

describe("ACP raw process exit", () => {
  it.effect("terminates on macOS when a descendant holds stdout open", () =>
    Effect.gen(function* () {
      const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const written = yield* Deferred.make<void>();
      const terminated = yield* Deferred.make<EffectAcpErrors.AcpError>();
      const stdout = yield* Queue.unbounded<Uint8Array>();
      const spawner = ChildProcessSpawner.make(() =>
        Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(999_999_999),
            exitCode: Deferred.await(exited),
            isRunning: Deferred.isDone(exited).pipe(Effect.map((done) => !done)),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.forEach(() => Deferred.succeed(written, undefined)),
            stdout: Stream.fromQueue(stdout),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
      const runtime = yield* AcpSessionRuntime.make({
        spawn: { command: "fake-acp", args: [], shell: false },
        cwd: "/tmp",
        clientInfo: { name: "test", version: "0.0.0" },
        onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      const pending = yield* runtime
        .request("test/pending", {})
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(written);
      yield* Deferred.succeed(exited, ChildProcessSpawner.ExitCode(19));
      // The exit observer is independent of stdout EOF and Linux containment.
      yield* TestClock.adjust("2 seconds");
      assert.isTrue(yield* Deferred.isDone(terminated), "raw exit must terminate the transport");
      const error = yield* Deferred.await(terminated);
      assert.equal(error._tag, "AcpProcessExitedError");
      if (error._tag === "AcpProcessExitedError") assert.equal(error.code, 19);
      assert.isDefined(pending.pollUnsafe(), "pending requests must fail on raw exit");
      assert.equal((yield* Fiber.join(pending))._tag, "Failure");
      const event = yield* runtime.getEvents().pipe(Stream.runHead);
      assert.isTrue(Option.isSome(event) && event.value._tag === "ConnectionTerminated");
      const later = yield* runtime.request("test/later", {}).pipe(Effect.result);
      assert.equal(later._tag, "Failure");
      if (later._tag === "Failure") assert.equal(later.failure._tag, "AcpProcessExitedError");
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(AgentScope, {
        ...AgentScope.defaultValue(),
        wrap: ({ command, args }) => Effect.succeed({ command, args }),
      }),
      Effect.provide(NodeServices.layer),
    ),
  );
});
