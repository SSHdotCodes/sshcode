import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";

export const STEER_NOTICE = "Read the user's new message now.";

const watchCallerSteer = Effect.fnUntraced(function* (scope: McpInvocationScope) {
  if (scope.thread === undefined) return Effect.never;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const threadId = scope.thread.threadId;
  const watchError = () =>
    new OrchestratorMcpFailure({
      code: "orchestration_error",
      message: "Unable to watch the caller for new messages.",
    });
  const afterSequence = yield* threads
    .getThreadEventSequence(threadId)
    .pipe(Effect.mapError(watchError));
  const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(watchError));
  const runId = shell?.activeRunId;
  if (runId == null || shell?.providerInstanceId !== scope.thread.providerInstanceId)
    return Effect.never;
  return threads
    .streamStoredEventsFrom({ threadId, afterSequence, eventType: "turn-item.updated" })
    .pipe(
      Stream.mapError(watchError),
      Stream.filter(
        ({ sequence, event }) =>
          sequence > afterSequence &&
          event.threadId === threadId &&
          event.type === "turn-item.updated" &&
          event.payload.type === "user_message" &&
          event.payload.runId === runId &&
          (event.payload.inputIntent === "steer" ||
            event.payload.inputIntent === "promoted_queued_to_steer"),
      ),
      Stream.runHead,
      // Ending a stream without a matching message must not end the tool's wait.
      Effect.flatMap((event) => (Option.isSome(event) ? Effect.void : Effect.never)),
      // Nor may losing the watch: the wait then simply goes on unwatched.
      Effect.catch(() => Effect.never),
    );
});

/**
 * Capture before tool setup; replay closes the gap before a wait subscribes. Watching is a
 * courtesy: a caller that cannot be watched still gets its wait, just without the early return.
 */
export const captureCallerSteer = (
  scope: McpInvocationScope,
): Effect.Effect<
  Effect.Effect<void, OrchestratorMcpFailure>,
  never,
  ThreadManagementService.ThreadManagementService
> =>
  watchCallerSteer(scope).pipe(
    Effect.map((steer): Effect.Effect<void, OrchestratorMcpFailure> => steer),
    Effect.orElseSucceed((): Effect.Effect<void, OrchestratorMcpFailure> => Effect.never),
  );

/** Interrupt only the wait, leaving delegated work alive and running its finalizers. */
export const raceWithSteer = <A, E, R>(
  wait: Effect.Effect<A, E, R>,
  steer: Effect.Effect<void, OrchestratorMcpFailure>,
) => Effect.raceFirst(wait.pipe(Effect.map(Option.some)), steer.pipe(Effect.as(Option.none<A>())));
