import { expect, it } from "@effect/vitest";
import { SideChatId, ThreadId, type SideChatState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { decodeSideChatStream } from "./server.ts";

const initial: SideChatState = {
  sideChatId: SideChatId.make("side"),
  threadId: ThreadId.make("thread"),
  kind: "btw",
  status: "running",
  error: null,
  messages: [
    { id: "answer", role: "assistant", text: "hello", status: "streaming", activities: [] },
  ],
};

it.effect("reconstructs appends and accepts legacy snapshots", () =>
  Effect.gen(function* () {
    const completed: SideChatState = {
      ...initial,
      status: "idle",
      messages: [{ ...initial.messages[0]!, text: "hello world", status: "complete" }],
    };
    const values = yield* decodeSideChatStream(
      Stream.make(
        initial,
        {
          kind: "text-append" as const,
          sideChatId: initial.sideChatId,
          messageId: "answer",
          previousLength: 5,
          text: " world",
        },
        completed,
      ),
    ).pipe(Stream.runCollect);
    expect(Array.from(values)).toEqual([
      initial,
      { ...initial, messages: [{ ...initial.messages[0]!, text: "hello world" }] },
      completed,
    ]);
  }),
);

it.effect("recovers from an invalid append by resubscribing for a snapshot", () =>
  Effect.gen(function* () {
    let subscriptions = 0;
    const resumed: SideChatState = {
      ...initial,
      messages: [{ ...initial.messages[0]!, text: "corrected" }],
    };
    const stream = Stream.suspend(() =>
      ++subscriptions === 1
        ? Stream.make(initial, {
            kind: "text-append" as const,
            sideChatId: initial.sideChatId,
            messageId: "answer",
            previousLength: 99,
            text: " lost",
          })
        : Stream.make(resumed),
    );
    expect(Array.from(yield* decodeSideChatStream(stream).pipe(Stream.runCollect))).toEqual([
      initial,
      resumed,
    ]);
    expect(subscriptions).toBe(2);
  }),
);
