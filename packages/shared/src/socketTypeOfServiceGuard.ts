// @effect-diagnostics nodeBuiltinImport:off -- Patches a Node built-in before anything else runs.
/**
 * Keeps a failed socket marking from taking the server down.
 *
 * Node's built-in `fetch` sets a type of service on the socket of every
 * HTTP/1 request. macOS refuses that for some sockets with EINVAL, and the
 * Node this app ships (24.22) lets the throw escape from a socket event
 * handler, where nothing can catch it: the whole server exits and every
 * running chat is cut off (seen 2026-11-10). Newer undici wraps the call in a
 * try/catch; this does the same from the outside. The marking is only a
 * network hint, so skipping it costs nothing.
 *
 * @module socketTypeOfServiceGuard
 */
import * as NodeNet from "node:net";

interface MarkableSocket {
  setTypeOfService?: (...args: Array<unknown>) => unknown;
}

export function guardSocketTypeOfService(
  prototype: MarkableSocket = NodeNet.Socket.prototype as MarkableSocket,
): void {
  const original = prototype.setTypeOfService;
  if (typeof original !== "function") return;
  prototype.setTypeOfService = function (this: unknown, ...args: Array<unknown>) {
    try {
      return original.apply(this, args);
    } catch {
      return this;
    }
  };
}
