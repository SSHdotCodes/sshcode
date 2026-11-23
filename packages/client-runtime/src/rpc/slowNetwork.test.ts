import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";

import { executeEnvironmentHttpRequest, layerRemoteHttpClient } from "./http.ts";

/** TCP loss delays delivery for a retransmit; it does not silently drop application bytes. */
const link = (rttMs: number, kbitPerSecond: number, lossPercent: number) => {
  const chunk = new Uint8Array(8_000).fill(120);
  const chunks = 40;
  const interval = (chunk.length * 8) / kbitPerSecond;
  const packetsPerChunk = Math.ceil(chunk.length / 1_400);
  const lossesThrough = (index: number) =>
    Math.floor((index * packetsPerChunk * lossPercent) / 100);
  const body = Stream.range(1, chunks).pipe(
    Stream.mapEffect((index) =>
      Effect.sleep(interval + (lossesThrough(index) - lossesThrough(index - 1)) * rttMs).pipe(
        Effect.as(chunk),
      ),
    ),
  );
  return {
    body: Stream.concat(Stream.fromEffect(Effect.sleep(rttMs)).pipe(Stream.drain), body),
    bytes: chunks * chunk.length,
    durationMs: rttMs + interval * chunks + lossesThrough(chunks) * rttMs,
  };
};

describe("slow network HTTP transfers", () => {
  it.effect("preserves empty successful response bodies", () =>
    executeEnvironmentHttpRequest(
      "https://mac.test/empty",
      20_000,
      HttpClient.get("https://mac.test/empty").pipe(Effect.flatMap((response) => response.text)),
    ).pipe(
      Effect.provide(layerRemoteHttpClient(async () => new Response(null, { status: 204 }))),
      Effect.tap((text) =>
        Effect.sync(() => {
          expect(text).toBe("");
        }),
      ),
    ),
  );

  it.effect.each([
    [300, 200, 1],
    [900, 100, 3],
    [1_500, 50, 5],
  ] as const)(
    "finishes at %i ms RTT / %i kbit/s / %i percent loss without restarting",
    ([rtt, rate, loss]) =>
      Effect.gen(function* () {
        for (const previousTotalDeadline of [true, false]) {
          const network = link(rtt, rate, loss);
          const body = yield* Stream.toReadableStreamEffect(network.body);
          const requested = yield* Deferred.make<void>();
          let requests = 0;
          let elapsedMs = 0;
          const startedAt = yield* Clock.currentTimeMillis;
          const fetchFn: typeof fetch = async () => {
            requests++;
            return new Response(body);
          };
          const transfer = executeEnvironmentHttpRequest(
            "https://mac.test/snapshot",
            20_000,
            HttpClient.get("https://mac.test/snapshot").pipe(
              Effect.tap(() => Deferred.succeed(requested, undefined)),
              Effect.flatMap((response) => response.text),
            ),
          );
          // Reproduce the former total deadline on the identical byte stream.
          const request = (
            previousTotalDeadline
              ? transfer.pipe(
                  Effect.timeoutOrElse({
                    duration: 20_000,
                    orElse: () => Effect.fail("previous total deadline" as const),
                  }),
                )
              : transfer
          ).pipe(
            Effect.onExit(() =>
              Clock.currentTimeMillis.pipe(
                Effect.tap((now) =>
                  Effect.sync(() => {
                    elapsedMs = now - startedAt;
                  }),
                ),
              ),
            ),
            Effect.provide(layerRemoteHttpClient(fetchFn)),
          );
          const result = yield* request.pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(requested);
          yield* TestClock.adjust(network.durationMs + rtt + 1_000);
          const completed = yield* Fiber.join(result);
          const shouldFinish = !previousTotalDeadline || network.durationMs < 20_000;
          expect(completed._tag).toBe(shouldFinish ? "Success" : "Failure");
          if (completed._tag === "Success") expect(completed.success.length).toBe(network.bytes);
          expect(elapsedMs).toBe(shouldFinish ? network.durationMs : 20_000);
          expect(requests).toBe(1);
          yield* Effect.logInfo(
            JSON.stringify({
              rtt,
              rate,
              loss,
              bytes: network.bytes,
              policy: previousTotalDeadline ? "before" : "after",
              elapsedMs,
              outcome: completed._tag,
              requests,
            }),
          ).pipe(
            Effect.provideService(References.MinimumLogLevel, "Info"),
            Effect.provideService(Console.Console, Console.Console.defaultValue()),
          );
        }
      }).pipe(Effect.scoped),
  );

  it.effect("caps a continuously trickling HTTP body at five minutes", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const body = yield* Stream.toReadableStreamEffect(
        Stream.fromEffectRepeat(Effect.sleep("10 seconds").pipe(Effect.as(new Uint8Array([32])))),
      );
      const result = yield* executeEnvironmentHttpRequest(
        "https://mac.test/trickle",
        20_000,
        HttpClient.get("https://mac.test/trickle").pipe(
          Effect.tap(() => Deferred.succeed(requested, undefined)),
          Effect.flatMap((response) => response.text),
        ),
      ).pipe(
        Effect.provide(layerRemoteHttpClient(async () => new Response(body))),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(requested);
      yield* TestClock.adjust("299 seconds");
      expect(result.pollUnsafe()).toBeUndefined();
      yield* TestClock.adjust("1 second");
      expect(result.pollUnsafe()).toBeDefined();
      if (result.pollUnsafe() !== undefined) {
        expect(yield* Fiber.join(result)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "RemoteEnvironmentAuthTimeoutError", timeoutMs: 300_000 },
        });
      }
    }).pipe(Effect.scoped),
  );

  it.effect("still times out a body that stops delivering bytes", () =>
    Effect.gen(function* () {
      const body = yield* Stream.toReadableStreamEffect(
        Stream.concat(Stream.make(new Uint8Array([120])), Stream.never),
      );
      const requested = yield* Deferred.make<void>();
      const result = yield* executeEnvironmentHttpRequest(
        "https://mac.test/snapshot",
        20_000,
        HttpClient.get("https://mac.test/snapshot").pipe(
          Effect.tap(() => Deferred.succeed(requested, undefined)),
          Effect.flatMap((response) => response.text),
        ),
      ).pipe(
        Effect.provide(layerRemoteHttpClient(async () => new Response(body))),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(requested);
      yield* TestClock.adjust("21 seconds");
      expect(yield* Fiber.join(result)).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "RemoteEnvironmentAuthTimeoutError" },
      });
    }).pipe(Effect.scoped),
  );
});
