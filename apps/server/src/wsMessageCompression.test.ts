import { assert, describe, it } from "@effect/vitest";
import { WS_MESSAGE_COMPRESSION_QUERY_PARAM } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { RpcSerialization } from "effect/rpc";
import * as NodeZlib from "node:zlib";
import * as Socket from "effect/socket/Socket";
import { inflatingJson } from "../../../packages/client-runtime/src/rpc/messageCompression.ts";

import {
  chunkSocketMessages,
  deflatedJson,
  rpcSerializationLayerFor,
} from "./wsMessageCompression.ts";

const serializationFor = (url: string) =>
  Effect.gen(function* () {
    return yield* RpcSerialization.RpcSerialization;
  }).pipe(Effect.provide(rpcSerializationLayerFor(new URL(url))));

describe("WebSocket message compression", () => {
  it.effect("delivers bounded independent messages that reassemble into the original RPC", () =>
    Effect.gen(function* () {
      const frames: Array<Uint8Array | string> = [];
      const firstPart = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const socket = Socket.make({
        reader: Effect.never,
        writer: Effect.succeed({
          write: (data) =>
            Effect.gen(function* () {
              if (!(data instanceof Socket.CloseEvent)) frames.push(data);
              if (frames.length === 1) {
                yield* Deferred.succeed(firstPart, undefined);
                yield* Deferred.await(release);
              }
            }),
          writeAll: (data) =>
            Effect.sync(() => {
              frames.push(...data);
            }),
        }),
      });
      const writer = yield* chunkSocketMessages(socket).writer;
      const encoded = new Uint8Array(300_000);
      // Deterministic, poorly compressible data so the test exercises many parts.
      let seed = 17;
      for (let index = 0; index < encoded.length; index++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        encoded[index] = seed >>> 24;
      }
      const value = {
        _tag: "Chunk",
        requestId: "1",
        values: [Buffer.from(encoded).toString("base64")],
      };
      const bytes = deflatedJson.makeUnsafe().encode(value)!;
      const transfer = yield* writer.write(bytes).pipe(Effect.forkChild);
      yield* Deferred.await(firstPart);
      yield* writer.write('{"_tag":"Pong"}');
      assert.strictEqual(frames[1], '{"_tag":"Pong"}');
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(transfer);
      assert.isAbove(frames.length, 20);
      assert.isTrue(frames.every((frame) => typeof frame === "string" || frame.byteLength <= 8204));
      const parser = inflatingJson.makeUnsafe();
      assert.deepEqual(
        frames.flatMap((frame) => parser.decode(frame)),
        [{ _tag: "Pong" }, value],
      );
    }).pipe(Effect.scoped),
  );
  it.effect("compresses only for a client that asked for raw deflate", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        yield* serializationFor(
          `http://localhost/ws?${WS_MESSAGE_COMPRESSION_QUERY_PARAM}=deflate-raw`,
        ),
        deflatedJson,
      );
      assert.strictEqual(
        yield* serializationFor(
          `http://localhost/ws?${WS_MESSAGE_COMPRESSION_QUERY_PARAM}=deflate-raw&messageFraming=chunks-v1`,
        ),
        deflatedJson,
      );
      assert.strictEqual(yield* serializationFor("http://localhost/ws"), RpcSerialization.json);
      assert.strictEqual(
        yield* serializationFor(`http://localhost/ws?${WS_MESSAGE_COMPRESSION_QUERY_PARAM}=brotli`),
        RpcSerialization.json,
      );
    }),
  );

  it("sends large messages as raw deflate and small ones as text", () => {
    const parser = deflatedJson.makeUnsafe();
    const large = [{ _tag: "Chunk", requestId: "1", values: ["x".repeat(4096)] }];
    const encoded = parser.encode(large);
    assert.instanceOf(encoded, Uint8Array);
    assert.isBelow((encoded as Uint8Array).byteLength, 200);
    assert.deepEqual(
      JSON.parse(NodeZlib.inflateRawSync(encoded as Uint8Array).toString("utf8")),
      large,
    );
    assert.strictEqual(parser.encode({ _tag: "Pong" }), '{"_tag":"Pong"}');
    assert.deepEqual(parser.decode('{"_tag":"Ping"}'), [{ _tag: "Ping" }]);
  });
});
