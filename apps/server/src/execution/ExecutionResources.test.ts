import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ExecutionResources from "./ExecutionResources.ts";

const threadId = ThreadId.make("owner");
const request = { threadId, commandId: CommandId.make("stop") };
const resource: ExecutionResources.ExecutionResource = {
  id: "job",
  owner: { threadId, taskId: "task" },
  workspace: { type: "local", cwd: "/checkout/nested" },
  state: "running",
  cleanupPin: true,
  stop: { type: "monitor", monitorId: "job" },
};
const provide = Effect.provide(ExecutionResources.layer.pipe(Layer.provide(NodeServices.layer)));

it.effect("uses one ownership query for thread stop and nested checkout pins", () =>
  Effect.gen(function* () {
    const ownership = yield* ExecutionResources.ExecutionResources;
    let released = false;
    yield* ownership.register("monitor", {
      query: () =>
        Effect.sync(() => [
          { ...resource, cleanupPin: !released, state: released ? "released" : "running" },
        ]),
      stop: (resources, received) =>
        Effect.sync(() => {
          expect(resources).toHaveLength(1);
          expect(received).toEqual(request);
          released = true;
        }),
    });
    expect(yield* ownership.query({ directory: "/checkout", pinsOnly: true })).toHaveLength(1);
    expect(yield* ownership.query({ directory: "/check" })).toHaveLength(0);
    expect(yield* ownership.query({ threadId: ThreadId.make("someone-else") })).toHaveLength(0);
    expect(yield* ownership.query({ directory: "/checkout/nested/child" })).toHaveLength(0);
    yield* ownership.stopOwned(request);
    expect(yield* ownership.query({ directory: "/checkout", pinsOnly: true })).toHaveLength(0);
  }).pipe(provide),
);

it.effect("tries every adapter after a failed stop and retains failed ownership", () =>
  Effect.gen(function* () {
    const ownership = yield* ExecutionResources.ExecutionResources;
    let childStopped = false;
    yield* ownership.register("monitor", {
      query: () => Effect.succeed([resource]),
      stop: () => Effect.fail("shutdown failed"),
    });
    yield* ownership.register("subagent", {
      query: () => Effect.succeed([]),
      stop: () =>
        Effect.sync(() => {
          childStopped = true;
        }),
    });
    const result = yield* Effect.result(ownership.stopOwned(request));
    expect(result._tag).toBe("Failure");
    expect(childStopped).toBe(true);
    expect(yield* ownership.query({ directory: "/checkout", pinsOnly: true })).toHaveLength(1);
  }).pipe(provide),
);

it.effect("fails closed when an ownership record cannot be read", () =>
  Effect.gen(function* () {
    const ownership = yield* ExecutionResources.ExecutionResources;
    yield* ownership.register("subagent", {
      query: () => Effect.fail("storage unavailable"),
      stop: () => Effect.void,
    });
    expect(
      (yield* Effect.result(ownership.query({ directory: "/checkout", pinsOnly: true })))._tag,
    ).toBe("Failure");
  }).pipe(provide),
);
