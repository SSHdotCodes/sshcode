import { CommandId, type OrchestrationV2ServerCommand, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as ExecutionResources from "./ExecutionResources.ts";

/** Local thread stop is the adapter; provider process control stays behind thread.stop. */
export const register = <QueryError, StopError, LiveWorkError>(input: {
  readonly query: (
    threadId?: ThreadId,
    pinsOnly?: boolean,
  ) => Effect.Effect<ReadonlyArray<ExecutionResources.ExecutionResource>, QueryError>;
  /** Which of these subagent threads, or anything below them, still have work to stop. */
  readonly liveWork: (
    threadIds: ReadonlyArray<ThreadId>,
    liveThreadIds: ReadonlyArray<ThreadId>,
  ) => Effect.Effect<ReadonlySet<ThreadId>, LiveWorkError>;
  readonly stopThread: (
    command: Extract<OrchestrationV2ServerCommand, { type: "thread.stop" }>,
  ) => Effect.Effect<unknown, StopError>;
}) =>
  Effect.gen(function* () {
    const ownership = yield* ExecutionResources.ExecutionResources;
    // A finished subagent with nothing running below it has nothing to stop. A long chat owns
    // hundreds of them, and a stop for each held the chat's effect lane, so the stopped turn's
    // checkpoint (and with it Edit and Rewind) waited 41 s. Unreadable state stops everything.
    const finishedWithoutWork = (resources: ReadonlyArray<ExecutionResources.ExecutionResource>) =>
      Effect.gen(function* () {
        const released = resources.flatMap((resource) =>
          resource.stop.type === "subagent" && resource.state === "released"
            ? [resource.stop.threadId]
            : [],
        );
        if (released.length === 0) return new Set<ThreadId>();
        // Every listed monitor is starting, running, recovering or stopping.
        const monitorOwners = (yield* ownership.query({ kind: "monitor" })).map(
          (resource) => resource.owner.threadId,
        );
        const live = yield* input.liveWork(released, monitorOwners);
        return new Set(released.filter((threadId) => !live.has(threadId)));
      }).pipe(
        Effect.catch(() =>
          Effect.logWarning("Could not tell finished subagents apart; stopping all of them").pipe(
            Effect.as(new Set<ThreadId>()),
          ),
        ),
      );
    yield* ownership.register("subagent", {
      query: ({ threadId, pinsOnly }) => input.query(threadId, pinsOnly),
      stop: (resources, request) =>
        Effect.gen(function* () {
          const skipped = yield* finishedWithoutWork(resources);
          const visited = new Set<ThreadId>(skipped);
          let failure: StopError | ExecutionResources.ExecutionResourceError | undefined;
          for (const resource of resources) {
            if (resource.stop.type !== "subagent" || visited.has(resource.stop.threadId)) continue;
            const threadId = resource.stop.threadId;
            visited.add(threadId);
            yield* input
              .stopThread({
                type: "thread.stop",
                commandId: CommandId.make(`${request.commandId}:stop:${threadId}`),
                threadId,
                stopDelegatedTasks: false,
                ...(request.reason === undefined ? {} : { reason: request.reason }),
              })
              .pipe(
                Effect.andThen(ownership.stopOwned({ ...request, threadId, kind: "subagent" })),
                Effect.catch((error) =>
                  Effect.logWarning("Unable to stop a subagent", { threadId }).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        failure ??= error;
                      }),
                    ),
                  ),
                ),
              );
          }
          if (failure !== undefined) return yield* Effect.fail(failure);
        }),
    });
  });
