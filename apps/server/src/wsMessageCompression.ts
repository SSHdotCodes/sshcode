/**
 * Compression for WebSocket clients that cannot negotiate permessage-deflate.
 *
 * React Native's iOS WebSocket (SocketRocket) offers no extensions, so the
 * phone would get every message uncompressed: a long chat's snapshot is
 * megabytes, which a weak cellular link cannot deliver before the client's
 * liveness timeout. Clients opt into raw deflate on the /ws URL. The chunked
 * variant splits large compressed messages so iOS can observe receive progress.
 * Messages below {@link MIN_COMPRESSED_MESSAGE_LENGTH} stay text, since
 * compressing a ping or a token delta saves nothing.
 *
 * @module wsMessageCompression
 */
import {
  WS_MESSAGE_COMPRESSION_DEFLATE_RAW,
  WS_MESSAGE_FRAMING_QUERY_PARAM,
  WS_MESSAGE_FRAMING_CHUNKS_V1,
  WS_MESSAGE_COMPRESSION_QUERY_PARAM,
  WS_MESSAGE_CHUNK_MAGIC,
  WS_MESSAGE_CHUNK_HEADER_BYTES,
  WS_MESSAGE_CHUNK_BYTES,
} from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";
import * as Socket from "effect/socket/Socket";
import type * as HttpServerRequest from "effect/http/HttpServerRequest";
import { RpcSerialization } from "effect/rpc";
import * as NodeZlib from "node:zlib";

export const MIN_COMPRESSED_MESSAGE_LENGTH = 1024;

export const deflatedJson = RpcSerialization.RpcSerialization.of({
  ...RpcSerialization.json,
  makeUnsafe: () => {
    const parser = RpcSerialization.json.makeUnsafe();
    return {
      decode: parser.decode,
      encode: (response) => {
        const encoded = parser.encode(response);
        return typeof encoded === "string" && encoded.length >= MIN_COMPRESSED_MESSAGE_LENGTH
          ? NodeZlib.deflateRawSync(encoded)
          : encoded;
      },
    };
  },
});

/** The serialization a /ws connection asked for: deflated JSON or plain JSON. */
export function rpcSerializationLayerFor(url: URL): Layer.Layer<RpcSerialization.RpcSerialization> {
  return url.searchParams.get(WS_MESSAGE_COMPRESSION_QUERY_PARAM) ===
    WS_MESSAGE_COMPRESSION_DEFLATE_RAW
    ? Layer.succeed(RpcSerialization.RpcSerialization, deflatedJson)
    : RpcSerialization.layerJson;
}

/** Independent messages expose progress to iOS, which hides WebSocket fragments until FIN. */
export function chunkSocketMessages(socket: Socket.Socket): Socket.Socket {
  return Socket.make({
    reader: socket.reader,
    writer: Effect.gen(function* () {
      const writer = yield* socket.writer;
      const lock = yield* Semaphore.make(1);
      const write: Socket.Writer["write"] = (data) => {
        if (!(data instanceof Uint8Array) || data.byteLength <= WS_MESSAGE_CHUNK_BYTES)
          return writer.write(data);
        return lock.withPermit(
          Effect.gen(function* () {
            for (let offset = 0; offset < data.byteLength; offset += WS_MESSAGE_CHUNK_BYTES) {
              const part = data.subarray(offset, offset + WS_MESSAGE_CHUNK_BYTES);
              const bytes = new Uint8Array(WS_MESSAGE_CHUNK_HEADER_BYTES + part.byteLength);
              const header = new DataView(bytes.buffer);
              header.setUint32(0, WS_MESSAGE_CHUNK_MAGIC);
              header.setUint32(4, data.byteLength);
              header.setUint32(8, offset);
              bytes.set(part, WS_MESSAGE_CHUNK_HEADER_BYTES);
              yield* writer.write(bytes);
            }
          }),
        );
      };
      return {
        write,
        writeAll: (chunks) => Effect.forEach(chunks, write, { discard: true }),
      } satisfies Socket.Writer;
    }),
  });
}

/** Only changes framing after authentication; locality is never an authorization signal. */
export function withChunkedMessages(
  request: HttpServerRequest.HttpServerRequest,
  url: URL,
): HttpServerRequest.HttpServerRequest {
  if (
    url.searchParams.get(WS_MESSAGE_COMPRESSION_QUERY_PARAM) !==
      WS_MESSAGE_COMPRESSION_DEFLATE_RAW ||
    url.searchParams.get(WS_MESSAGE_FRAMING_QUERY_PARAM) !== WS_MESSAGE_FRAMING_CHUNKS_V1
  )
    return request;
  return Object.create(request, {
    upgrade: { get: () => request.upgrade.pipe(Effect.map(chunkSocketMessages)) },
  }) as HttpServerRequest.HttpServerRequest;
}
