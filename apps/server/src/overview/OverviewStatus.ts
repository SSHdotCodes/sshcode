import { isOverviewThreadId, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { formatOverviewStatus } from "./statusText.ts";

export { OVERVIEW_STATUS_CONTEXT_KEY } from "./statusText.ts";

/**
 * The live status an Overview turn starts with. Other threads get none; so
 * does every thread when this is not provided, as in most tests.
 */
export class OverviewStatus extends Context.Reference<{
  readonly forThread: (threadId: ThreadId) => Effect.Effect<string | null>;
}>("t3/overview/OverviewStatus", {
  defaultValue: () => ({ forThread: () => Effect.succeed(null) }),
}) {}

export const layer = Layer.effect(
  OverviewStatus,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return {
      forThread: (threadId) =>
        isOverviewThreadId(threadId)
          ? Effect.gen(function* () {
              const snapshot = yield* projections.getShellSnapshot();
              const now = DateTime.toEpochMillis(yield* DateTime.now);
              return formatOverviewStatus({ threads: snapshot.threads, now });
            }).pipe(
              // Without the status Overview still answers, from its tools.
              Effect.catch((cause) =>
                Effect.logWarning("Failed to build the Overview status.", { cause }).pipe(
                  Effect.as(null),
                ),
              ),
            )
          : Effect.succeed(null),
    };
  }),
);
