import { sha256 } from "@noble/hashes/sha2";
import * as Base64Url from "effect/encoding/Base64Url";

const MAX_CACHED = 2048;
const cache = new Map<string, string>();

/**
 * The short handle agents see for a delegated task, as the server's taskReference makes it: ids
 * up to 16 characters stay as they are, longer ones become "t" plus 15 characters of their
 * SHA-256. Clients use it to tie a delegate_task row to the subagent card it started.
 */
export function delegatedTaskHandle(id: string): string {
  if (id.length <= 16) return id;
  const cached = cache.get(id);
  if (cached !== undefined) return cached;
  const handle = `t${Base64Url.encode(sha256(new TextEncoder().encode(id))).slice(0, 15)}`;
  if (cache.size >= MAX_CACHED) cache.clear();
  cache.set(id, handle);
  return handle;
}
