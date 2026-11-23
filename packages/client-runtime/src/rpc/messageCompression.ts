import {
  WS_MESSAGE_COMPRESSION_DEFLATE_RAW,
  WS_MESSAGE_FRAMING_QUERY_PARAM,
  WS_MESSAGE_FRAMING_CHUNKS_V1,
  WS_MESSAGE_COMPRESSION_QUERY_PARAM,
  WS_MESSAGE_CHUNK_MAGIC,
  WS_MESSAGE_CHUNK_HEADER_BYTES,
  WS_MESSAGE_MAX_COMPRESSED_BYTES,
  WS_MESSAGE_MAX_DECOMPRESSED_BYTES,
} from "@t3tools/contracts";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Predicate from "effect/Predicate";
import { Inflate, DecodeUTF8 } from "fflate";

import { loadMarksEnabled, markLoad } from "../loadMarks.ts";

/** Feed bounded input pieces so a single inflate allocation cannot expand the entire message. */
function inflateMessage(data: Uint8Array): string {
  if (data.byteLength > WS_MESSAGE_MAX_COMPRESSED_BYTES) {
    throw new Error("Compressed WebSocket message exceeds size limit");
  }
  let size = 0;
  const text: string[] = [];
  const decoder = new DecodeUTF8((part) => {
    text.push(part);
  });
  const inflater = new Inflate((part, final) => {
    size += part.byteLength;
    if (size > WS_MESSAGE_MAX_DECOMPRESSED_BYTES) {
      throw new Error("Decompressed WebSocket message exceeds size limit");
    }
    decoder.push(part, final);
  });
  // Raw DEFLATE expands at most about 1032x, bounding each output to roughly 1 MiB.
  for (let offset = 0; offset < data.byteLength; offset += 1024) {
    inflater.push(data.subarray(offset, offset + 1024), offset + 1024 >= data.byteLength);
  }
  return text.join("");
}

/**
 * JSON whose binary frames are raw deflate. The server sends them only to a
 * client that asked with {@link withMessageCompression}; text frames are plain
 * JSON, as are the client's own messages.
 */
export const inflatingJson = RpcSerialization.RpcSerialization.of({
  ...RpcSerialization.json,
  makeUnsafe: () => {
    const parser = RpcSerialization.json.makeUnsafe();
    let partial: Uint8Array | undefined;
    let received = 0;
    return {
      decode: (data) => {
        if (typeof data === "string") return parser.decode(data);
        if (
          data.byteLength >= WS_MESSAGE_CHUNK_HEADER_BYTES &&
          new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0) ===
            WS_MESSAGE_CHUNK_MAGIC
        ) {
          const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
          const total = header.getUint32(4);
          const offset = header.getUint32(8);
          const length = data.byteLength - WS_MESSAGE_CHUNK_HEADER_BYTES;
          if (
            total === 0 ||
            total > WS_MESSAGE_MAX_COMPRESSED_BYTES ||
            length === 0 ||
            offset !== received ||
            offset + length > total ||
            (partial !== undefined && partial.byteLength !== total)
          ) {
            throw new Error("Invalid compressed WebSocket part");
          }
          partial ??= new Uint8Array(total);
          partial.set(data.subarray(WS_MESSAGE_CHUNK_HEADER_BYTES), offset);
          received += length;
          if (received < total) return [];
          data = partial;
          partial = undefined;
          received = 0;
        }
        if (!loadMarksEnabled()) return parser.decode(inflateMessage(data));
        const startedAt = performance.now();
        const text = inflateMessage(data);
        const inflatedAt = performance.now();
        const decoded = parser.decode(text);
        if (text.length >= LARGE_FRAME_CHARS) {
          markLoad("frame.decoded", {
            compressedBytes: data.byteLength,
            chars: text.length,
            inflateMs: Math.round(inflatedAt - startedAt),
            parseMs: Math.round(performance.now() - inflatedAt),
            sources: frameSources(decoded),
          });
        }
        return decoded;
      },
      encode: parser.encode,
    };
  },
});

/** Frames at least this long are worth a timing mark. */
const LARGE_FRAME_CHARS = 64 * 1024;

/** Bounded type labels identify large pushes without logging content or re-encoding it. */
function frameSources(decoded: ReadonlyArray<unknown>): string {
  const sources = new Set<string>();
  for (const message of decoded.slice(0, 8)) {
    if (!Predicate.isObject(message) || !Array.isArray(message.values)) continue;
    for (const value of message.values.slice(0, 8)) {
      if (!Predicate.isObject(value)) continue;
      const event = Predicate.isObject(value.event) ? value.event : value;
      const type =
        typeof event.type === "string"
          ? event.type
          : typeof value.kind === "string"
            ? value.kind
            : "rpc";
      sources.add(type.slice(0, 64));
    }
  }
  return [...sources].join(",");
}

/**
 * Asks the server to compress large messages, for a WebSocket that cannot
 * negotiate permessage-deflate. React Native's iOS socket offers no extensions,
 * so without this the phone downloads every snapshot uncompressed.
 */
export function withMessageCompression(socketUrl: string): string {
  const url = new URL(socketUrl);
  url.searchParams.set(WS_MESSAGE_COMPRESSION_QUERY_PARAM, WS_MESSAGE_COMPRESSION_DEFLATE_RAW);
  url.searchParams.set(WS_MESSAGE_FRAMING_QUERY_PARAM, WS_MESSAGE_FRAMING_CHUNKS_V1);
  return url.toString();
}
