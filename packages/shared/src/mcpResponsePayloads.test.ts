import { it } from "@effect/vitest";
import { expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { responsePayloads } from "./mcpResponsePayloads.ts";

it.effect.each(["text/event-stream", "application/json"])(
  "releases a stalled %s response body when its consumer is interrupted",
  (contentType) =>
    Effect.gen(function* () {
      const reading = Promise.withResolvers<void>();
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>(
        {
          start(value) {
            controller = value;
          },
          pull() {
            reading.resolve();
          },
        },
        { highWaterMark: 0 },
      );
      const response = new Response(body, { headers: { "content-type": contentType } });
      const consumer = yield* Stream.runDrain(responsePayloads(response, String)).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => reading.promise);
      yield* Fiber.interrupt(consumer);
      try {
        expect(
          () => controller.enqueue(new TextEncoder().encode("late response bytes")),
          "interrupted MCP response must stop accepting body bytes",
        ).toThrow(TypeError);
        expect(body.locked, "interrupted MCP response must release its body").toBe(false);
      } finally {
        if (body.locked) controller.close();
      }
    }),
);

it.effect("reads a multi-megabyte SSE event delivered in small chunks", () =>
  Effect.gen(function* () {
    const text = "x".repeat(8 * 1024 * 1024);
    const bytes = new TextEncoder().encode(
      `data: ${JSON.stringify({ id: 1, result: { text } })}\n\n`,
    );
    let offset = 0;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (offset === bytes.length) return controller.close();
          controller.enqueue(bytes.subarray(offset, offset + 256));
          offset = Math.min(offset + 256, bytes.length);
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const payloads = yield* Stream.runCollect(
      responsePayloads(response, (cause) => ({ _tag: "ResponsePayloadError" as const, cause })),
    );
    expect(Array.from(payloads)).toEqual([{ id: 1, result: { text } }]);
  }),
);

it.effect.each(["\n", "\r\n"])("reads multiple events one byte at a time (%j)", (newline) =>
  Effect.gen(function* () {
    const frames = ["one🌲", "two"].map((value) => `data: "${value}"${newline}${newline}`).join("");
    const bytes = new TextEncoder().encode(frames);
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
    const values = yield* Stream.runCollect(responsePayloads(response, String));
    expect(Array.from(values)).toEqual(["one🌲", "two"]);
  }),
);
