import { type ServerConfigStreamEvent, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import { RpcClient } from "effect/rpc";

import { DEFAULT_CONNECTION_TIMINGS } from "../connection/timings.ts";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
type RawWsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;
type ConfigMethod = RawWsRpcProtocolClient[typeof WS_METHODS.subscribeServerConfig];
type ExpandedConfigStream<S> =
  S extends Stream.Stream<infer _A, infer E, infer R>
    ? Stream.Stream<ServerConfigStreamEvent, E, R>
    : never;

/** The session expands transport-only config shapes before exposing this client. */
export type WsRpcProtocolClient = Omit<
  RawWsRpcProtocolClient,
  typeof WS_METHODS.subscribeServerConfig
> & {
  readonly [WS_METHODS.subscribeServerConfig]: (
    input: Parameters<ConfigMethod>[0],
  ) => ExpandedConfigStream<ReturnType<ConfigMethod>>;
};

// Pings go out every 5 seconds, and a server busy for a few seconds stops
// answering them. Allow 15 seconds without any frame before dropping the socket.
// Connections take theirs from ConnectionTimings, which a phone raises.
export const PING_TIMEOUT = DEFAULT_CONNECTION_TIMINGS.pingTimeout;
