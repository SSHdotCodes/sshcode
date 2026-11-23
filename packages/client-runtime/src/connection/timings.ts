import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";

/**
 * How long connecting and staying connected may take before the client gives
 * up. The defaults suit a desktop on a wired or home network. A phone on weak
 * cellular stalls for many seconds at a time and answers slowly, so it waits
 * longer before dropping a working socket and retries sooner after a failure.
 *
 * Read once, when the connection services are built.
 */
export interface ConnectionTimingsShape {
  /**
   * Pings go out every 5 seconds. This is the minimum receive-idle budget;
   * measured latency can extend it. Compressed message parts count as traffic.
   */
  readonly pingTimeout: Duration.Input;
  readonly socketOpenTimeout: Duration.Input;
  /**
   * Per route: resolve credentials and create the session. Opening the socket
   * and the first config snapshot have their own budgets.
   */
  readonly establishmentTimeout: Duration.Input;
  /**
   * A probe someone is waiting on: a resume, an explicit retry, a network
   * change or an offline report. A probe that misses it replaces the session.
   */
  readonly quickProbeTimeout: Duration.Input;
  /** HTTP requests made while connecting, such as the WebSocket ticket. */
  readonly connectRequestTimeoutMs: number;
  /** Ceiling on the wait before retrying a connection that keeps failing. */
  readonly retryMaxDelayMs: number;
  /** Try a second route after this much receive silence while establishing. */
  readonly routeFallbackDelayMs?: number;
  /** Optional acknowledgment deadline for replayable sends; other RPCs are unchanged. */
  readonly commandAckTimeout?: Duration.Input;
}

export const DEFAULT_CONNECTION_TIMINGS: ConnectionTimingsShape = {
  pingTimeout: "15 seconds",
  socketOpenTimeout: "15 seconds",
  establishmentTimeout: "15 seconds",
  quickProbeTimeout: "3 seconds",
  connectRequestTimeoutMs: 10_000,
  retryMaxDelayMs: 300_000,
};

/**
 * For a phone on cellular. A 20-second stall no longer drops a socket that is
 * still delivering, and a link that keeps failing is retried at least every
 * 30 seconds while the app is open rather than after up to 5 minutes.
 */
export const MOBILE_CONNECTION_TIMINGS: ConnectionTimingsShape = {
  pingTimeout: "40 seconds",
  socketOpenTimeout: "30 seconds",
  establishmentTimeout: "30 seconds",
  quickProbeTimeout: "8 seconds",
  connectRequestTimeoutMs: 20_000,
  retryMaxDelayMs: 30_000,
  routeFallbackDelayMs: 1_200,
  commandAckTimeout: "30 seconds",
};

export class ConnectionTimings extends Context.Reference<ConnectionTimingsShape>(
  "@t3tools/client-runtime/connection/ConnectionTimings",
  { defaultValue: () => DEFAULT_CONNECTION_TIMINGS },
) {}

/** Receive-idle budget while synchronizing the initial configuration. */
export const ROUTE_SYNCHRONIZATION_TIMEOUT = "75 seconds";

/** Total ceiling even when an initial configuration keeps trickling in. */
export const INITIAL_SYNCHRONIZATION_MAX_MS = 5 * 60_000;
