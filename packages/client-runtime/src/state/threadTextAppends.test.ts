import {
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationV2ThreadStreamItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { restoreThreadTextAppends } from "./threadTextAppends.ts";

const event = (
  text: string,
  textAppendFrom?: number,
  threadId = v2ThreadId,
): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence: 1,
  ...(textAppendFrom === undefined ? {} : { textAppendFrom }),
  event: {
    type: "message.updated",
    id: EventId.make("event"),
    threadId,
    occurredAt: v2Now,
    payload: {
      id: MessageId.make("message"),
      threadId,
      runId: null,
      nodeId: null,
      role: "assistant",
      text,
      streaming: true,
      attachments: [],
      createdBy: "agent",
      creationSource: "provider",
      createdAt: v2Now,
      updatedAt: v2Now,
    },
  },
});

describe("thread text appends", () => {
  it.effect(
    "restores ordered suffixes and keeps edits, duplicate updates and reconnects whole",
    () =>
      Effect.gen(function* () {
        const values = [event("a"), event("🦊", 1), event("", 3), event("edited"), event("!", 6)];
        const restored = yield* restoreThreadTextAppends(Stream.fromIterable(values)).pipe(
          Stream.runCollect,
        );
        expect(restored).toEqual([
          event("a"),
          event("a🦊"),
          event("a🦊"),
          event("edited"),
          event("edited!"),
        ]);
        expect(
          yield* restoreThreadTextAppends(Stream.succeed(event("fresh"))).pipe(Stream.runCollect),
        ).toEqual([event("fresh")]);
      }),
  );
  it.effect("fails before emitting text with a missing, stale or other-thread base", () =>
    Effect.gen(function* () {
      for (const values of [
        [event("suffix", 3)],
        [event("old"), event("suffix", 4)],
        [event("old"), event("suffix", 3, ThreadId.make("other"))],
        [
          event("old"),
          { kind: "snapshot" as const, snapshotSequence: 2, projection: v2Projection },
          event("suffix", 3),
        ],
      ]) {
        const result = yield* restoreThreadTextAppends(Stream.fromIterable(values)).pipe(
          Stream.runCollect,
          Effect.result,
        );
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "OrchestrationV2GetThreadProjectionError" },
        });
      }
    }),
  );
});
