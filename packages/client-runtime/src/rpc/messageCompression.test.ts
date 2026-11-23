import { WS_MESSAGE_COMPRESSION_QUERY_PARAM } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { deflateSync, strToU8 } from "fflate";

import { compressedRpcBomb } from "./messageCompression.test-fixtures.ts";
import { inflatingJson, withMessageCompression } from "./messageCompression.ts";

describe("WebSocket message compression", () => {
  it("asks for it on the socket URL and keeps the ticket", () => {
    const url = new URL(withMessageCompression("ws://100.64.0.1:3773/ws?wsTicket=abc"));
    expect(url.searchParams.get("wsTicket")).toBe("abc");
    expect(url.searchParams.get(WS_MESSAGE_COMPRESSION_QUERY_PARAM)).toBe("deflate-raw");
    expect(url.searchParams.get("messageFraming")).toBe("chunks-v1");
  });

  it("inflates binary frames and reads text frames as they are", () => {
    const parser = inflatingJson.makeUnsafe();
    const batch = [{ _tag: "Chunk", requestId: "1", values: ["x".repeat(4096)] }];
    expect(parser.decode(deflateSync(strToU8(JSON.stringify(batch))))).toEqual(batch);
    expect(parser.decode(JSON.stringify({ _tag: "Pong" }))).toEqual([{ _tag: "Pong" }]);
    expect(parser.encode({ _tag: "Ping" })).toBe('{"_tag":"Ping"}');
  });

  it("counts partial compressed bytes as liveness without exposing an incomplete RPC", () => {
    const parser = inflatingJson.makeUnsafe();
    const value = { _tag: "Chunk", requestId: "large", values: ["hello".repeat(40_000)] };
    const compressed = deflateSync(strToU8(JSON.stringify(value)));
    const split = Math.floor(compressed.length / 2);
    const frame = (offset: number, end: number) => {
      const bytes = new Uint8Array(12 + end - offset);
      bytes.set([84, 51, 67, 49]);
      const header = new DataView(bytes.buffer);
      header.setUint32(4, compressed.length);
      header.setUint32(8, offset);
      bytes.set(compressed.subarray(offset, end), 12);
      return bytes;
    };
    expect(parser.decode(frame(0, split))).toEqual([]);
    // Other requests may complete between parts of a large snapshot.
    expect(parser.decode('{"_tag":"Pong"}')).toEqual([{ _tag: "Pong" }]);
    expect(parser.decode(frame(split, compressed.length))).toEqual([value]);
  });

  it.each([false, true])(
    "rejects a deflate bomb (chunked: %s)",
    (chunked) => {
      const compressed = compressedRpcBomb();
      expect(compressed.byteLength).toBeLessThan(16 * 1024 * 1024);
      const parser = inflatingJson.makeUnsafe();
      expect(() => {
        if (!chunked) {
          parser.decode(compressed);
          return;
        }
        for (let offset = 0; offset < compressed.length; offset += 8192) {
          const part = compressed.subarray(offset, offset + 8192);
          const frame = new Uint8Array(12 + part.length);
          const header = new DataView(frame.buffer);
          header.setUint32(0, 0x54334331);
          header.setUint32(4, compressed.length);
          header.setUint32(8, offset);
          frame.set(part, 12);
          parser.decode(frame);
        }
      }).toThrow("Decompressed WebSocket message exceeds size limit");
    },
    30_000,
  );

  it("rejects out-of-order and oversized partial frames before allocating", () => {
    const bytes = new Uint8Array(13);
    bytes.set([84, 51, 67, 49]);
    new DataView(bytes.buffer).setUint32(4, 0xffffffff);
    expect(() => inflatingJson.makeUnsafe().decode(bytes)).toThrow();
    new DataView(bytes.buffer).setUint32(4, 100);
    new DataView(bytes.buffer).setUint32(8, 10);
    expect(() => inflatingJson.makeUnsafe().decode(bytes)).toThrow();
  });
});
