// @effect-diagnostics nodeBuiltinImport:off -- untrusted regexes run outside the server's event loop.
import * as NodeWorkerThreads from "node:worker_threads";

import { MonitorError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
const pattern = new RegExp(workerData);
parentPort.on("message", (lines) => {
  parentPort.postMessage(lines.filter((line) => pattern.test(line)));
});
parentPort.postMessage(null);
`;

/** One sequential matcher per follower. A stuck regex loses its worker, never its job. */
export const make = (source: string) =>
  Effect.gen(function* () {
    const worker = yield* Effect.acquireRelease(
      Effect.try({
        try: () => {
          const worker = new NodeWorkerThreads.Worker(workerSource, {
            eval: true,
            workerData: source,
            resourceLimits: { maxOldGenerationSizeMb: 16, stackSizeMb: 1 },
          });
          // Errors between requests must not become uncaught EventEmitter errors.
          worker.on("error", () => {});
          return worker;
        },
        catch: (cause) => new MonitorError({ reason: "match", cause }),
      }),
      (worker) => Effect.promise(() => worker.terminate()).pipe(Effect.asVoid),
    );
    const receive = Effect.callback<ReadonlyArray<string> | null, MonitorError>((resume) => {
      const message = (lines: ReadonlyArray<string> | null) => {
        cleanup();
        resume(Effect.succeed(lines));
      };
      const error = (cause: unknown) => {
        cleanup();
        resume(Effect.fail(new MonitorError({ reason: "match", cause })));
      };
      const exit = () => error(undefined);
      const cleanup = () => {
        worker.off("message", message);
        worker.off("error", error);
        worker.off("exit", exit);
      };
      worker.once("message", message);
      worker.once("error", error);
      worker.once("exit", exit);
      return Effect.sync(cleanup);
    });
    // Startup gets its own allowance; matching has a shorter deadline.
    yield* receive.pipe(
      Effect.timeoutOrElse({
        duration: "5 seconds",
        orElse: () => Effect.fail(new MonitorError({ reason: "match" })),
      }),
    );
    return (lines: ReadonlyArray<string>) =>
      Effect.gen(function* () {
        // eslint-disable-next-line unicorn/require-post-message-target-origin -- Node workers do not accept a browser targetOrigin.
        worker.postMessage(lines);
        return (yield* receive) ?? [];
      }).pipe(
        // Generous: a busy machine must not disable a wake. Runaway patterns never finish.
        Effect.timeoutOrElse({
          duration: "2 seconds",
          orElse: () => Effect.fail(new MonitorError({ reason: "match" })),
        }),
        Effect.onError(() => Effect.promise(() => worker.terminate()).pipe(Effect.asVoid)),
      );
  });
