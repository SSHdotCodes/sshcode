import { Deflate, strToU8 } from "fflate";

/** A valid RPC with oversized padding, without allocating its expanded input. */
export function compressedRpcBomb() {
  const parts: Uint8Array[] = [];
  const compressor = new Deflate({ level: 1 }, (part) => parts.push(part));
  const prefix = strToU8('{"_tag":"Pong"}');
  compressor.push(prefix);
  const padding = new Uint8Array(64 * 1024).fill(32);
  let remaining = 128 * 1024 * 1024 + 1 - prefix.length;
  while (remaining > padding.length) {
    compressor.push(padding);
    remaining -= padding.length;
  }
  compressor.push(padding.subarray(0, remaining), true);
  const compressed = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    compressed.set(part, offset);
    offset += part.length;
  }
  return compressed;
}
