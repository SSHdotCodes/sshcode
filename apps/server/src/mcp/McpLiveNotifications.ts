/**
 * Idle Streamable HTTP listeners for `notifications/tools/list_changed`.
 *
 * Effect's HTTP MCP transport only delivers server notifications to clients
 * that currently have a POST open. This service keeps one bounded mailbox per
 * initialized session so a GET SSE stream can sit idle and still be told to
 * re-list. There is no event log and no Last-Event-ID replay: a slow reader
 * keeps the newest signal and re-lists the current policy.
 *
 * @module McpLiveNotifications
 */

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import type * as McpInvocationContext from "./McpInvocationContext.ts";

/** Matches Effect's own MCP SSE comment interval. */
export const MCP_SSE_KEEPALIVE = "15 seconds";

/**
 * A client that never sends DELETE must not keep a session forever.
 * An open SSE listener stays. After it disconnects, the entry lives only
 * until this idle bound, and the map also refuses to grow past the cap.
 */
export const MCP_SESSION_IDLE_TTL = "24 hours";
export const MCP_SESSION_LIMIT = 1_024;

const textEncoder = new TextEncoder();
const listChangedFrame = textEncoder.encode(
  `data: ${JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/tools/list_changed",
    params: {},
  })}\n\n`,
);
const keepaliveFrame = textEncoder.encode(": keepalive\n\n");
const openFrame = textEncoder.encode(": open\n\n");

export class McpListenMissingSession extends Schema.TaggedError<McpListenMissingSession>()(
  "McpListenMissingSession",
  {},
) {
  override get message(): string {
    return "An initialized MCP session id is required.";
  }
}

export class McpListenUnknownSession extends Schema.TaggedError<McpListenUnknownSession>()(
  "McpListenUnknownSession",
  {},
) {
  override get message(): string {
    return "The MCP session is unknown.";
  }
}

export class McpListenProtocolMismatch extends Schema.TaggedError<McpListenProtocolMismatch>()(
  "McpListenProtocolMismatch",
  {},
) {
  override get message(): string {
    return "MCP-Protocol-Version header does not match negotiated protocol version.";
  }
}

export class McpListenAlreadyAttached extends Schema.TaggedError<McpListenAlreadyAttached>()(
  "McpListenAlreadyAttached",
  {},
) {
  override get message(): string {
    return "An MCP session already has a listener.";
  }
}

interface LiveSession {
  readonly protocolVersion: string;
  readonly requestNamespace: string;
  readonly environmentId: string;
  listener: Queue.Queue<Uint8Array> | undefined;
  /** Clock millis of the last bind, resume, or disconnect. */
  seenAt: number;
  /** Monotonic order. The test clock does not move between binds. */
  order: number;
}

interface LiveNotificationsOptions {
  readonly limit: number;
  readonly idleTtl: Duration.Duration;
}

export type SessionAccess = "absent" | "owned" | "foreign";

const sameScope = (
  session: LiveSession,
  scope: McpInvocationContext.McpInvocationScope,
): boolean =>
  session.requestNamespace === scope.requestNamespace &&
  session.environmentId === scope.environmentId;

export class McpLiveNotifications extends Context.Service<
  McpLiveNotifications,
  {
    /**
     * Remember an initialized session. Repeating the same id keeps the
     * listener already attached to it. A different caller cannot rebind it.
     */
    readonly bindInitializedSession: (input: {
      readonly sessionId: string;
      readonly protocolVersion: string;
      readonly scope: McpInvocationContext.McpInvocationScope;
    }) => Effect.Effect<void>;

    /** Drop the session and end its listener. Repeating it does nothing. */
    readonly endSession: (sessionId: string) => Effect.Effect<void>;

    /**
     * Whether this caller may use an initialized session.
     * A foreign namespace or environment is refused. An id this process does
     * not know is left for Effect's own admission.
     */
    readonly authorizeExistingSession: (input: {
      readonly sessionId: string;
      readonly scope: McpInvocationContext.McpInvocationScope;
    }) => Effect.Effect<SessionAccess>;

    /**
     * Open the idle GET stream. A missing protocol header is accepted, matching
     * Effect's HTTP admission. A present header must match the initialize result.
     * A foreign namespace or environment is indistinguishable from an unknown id.
     */
    readonly listen: (input: {
      readonly sessionId: string | undefined;
      readonly protocolVersion: string | undefined;
      readonly scope: McpInvocationContext.McpInvocationScope;
    }) => Effect.Effect<
      {
        readonly sessionId: string;
        readonly protocolVersion: string;
        readonly events: Stream.Stream<Uint8Array>;
      },
      | McpListenMissingSession
      | McpListenUnknownSession
      | McpListenProtocolMismatch
      | McpListenAlreadyAttached
    >;

    /** Wake every idle listener. In-flight POSTs are notified separately. */
    readonly publishToolsListChanged: Effect.Effect<void>;

    /**
     * Completes when a listener stream finishes and its slot is cleared.
     * Tests wait on this instead of sleeping. The queue is bounded and drops
     * older signals; it is not a history of sessions.
     */
    readonly awaitListenerReleased: Effect.Effect<string>;
  }
>()("t3/mcp/McpLiveNotifications") {}

const make = (options: LiveNotificationsOptions) =>
  Effect.gen(function* () {
    const sessions = new Map<string, LiveSession>();
    const releases = yield* Queue.sliding<string>(16);
    const idleTtlMs = Duration.toMillis(options.idleTtl);
    let nextOrder = 0;
    const stamp = (session: LiveSession, seenAt: number) => {
      session.seenAt = seenAt;
      session.order = ++nextOrder;
    };

    const shutdownListener = (sessionId: string, queue: Queue.Queue<Uint8Array>) =>
      Queue.shutdown(queue).pipe(
        Effect.andThen(Queue.offer(releases, sessionId).pipe(Effect.ignoreCause)),
      );

    const releaseListener = (sessionId: string, queue: Queue.Queue<Uint8Array>) =>
      Effect.gen(function* () {
        const owned = yield* Effect.sync(() => {
          const session = sessions.get(sessionId);
          if (session?.listener !== queue) return false;
          session.listener = undefined;
          return true;
        });
        if (!owned) {
          yield* Queue.shutdown(queue);
          return;
        }
        const seenAt = yield* Clock.currentTimeMillis;
        yield* Effect.sync(() => {
          const session = sessions.get(sessionId);
          if (session !== undefined) stamp(session, seenAt);
        });
        yield* shutdownListener(sessionId, queue);
      });

    /**
     * Drop disconnected sessions past the idle bound, then evict until `fits`.
     * Idle entries go before an open listener. The newcomer is inserted after
     * this, so it is not itself the eviction victim.
     */
    const reclaim = (fits: (size: number) => boolean) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const queues = yield* Effect.sync(() => {
          const closing: Array<{
            readonly sessionId: string;
            readonly queue: Queue.Queue<Uint8Array>;
          }> = [];
          const close = (sessionId: string, session: LiveSession) => {
            sessions.delete(sessionId);
            if (session.listener === undefined) return;
            closing.push({ sessionId, queue: session.listener });
            session.listener = undefined;
          };
          for (const [sessionId, session] of sessions) {
            if (session.listener === undefined && now - session.seenAt >= idleTtlMs) {
              close(sessionId, session);
            }
          }
          const oldestId = (wantListener: boolean) => {
            let chosen: { readonly sessionId: string; readonly order: number } | undefined;
            for (const [sessionId, session] of sessions) {
              if ((session.listener !== undefined) !== wantListener) continue;
              if (
                chosen === undefined ||
                session.order < chosen.order ||
                (session.order === chosen.order && sessionId < chosen.sessionId)
              ) {
                chosen = { sessionId, order: session.order };
              }
            }
            return chosen?.sessionId;
          };
          while (!fits(sessions.size)) {
            const sessionId = oldestId(false) ?? oldestId(true);
            if (sessionId === undefined) break;
            const session = sessions.get(sessionId);
            if (session === undefined) break;
            close(sessionId, session);
          }
          return closing;
        });
        yield* Effect.forEach(
          queues,
          ({ sessionId, queue }) => shutdownListener(sessionId, queue),
          { discard: true },
        );
      });

    const sweep = reclaim((size) => size <= options.limit);
    const makeRoom = reclaim((size) => size < options.limit);

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        const queues: Array<Queue.Queue<Uint8Array>> = [];
        for (const session of sessions.values()) {
          if (session.listener !== undefined) queues.push(session.listener);
        }
        sessions.clear();
        return queues;
      }).pipe(
        Effect.flatMap((queues) =>
          Effect.forEach(queues, (queue) => Queue.shutdown(queue), { discard: true }),
        ),
      ),
    );

    const bindInitializedSession: McpLiveNotifications["Service"]["bindInitializedSession"] = (
      input,
    ) =>
      Effect.gen(function* () {
        yield* sweep;
        if (input.sessionId.length === 0 || sessions.has(input.sessionId)) return;
        yield* makeRoom;
        const seenAt = yield* Clock.currentTimeMillis;
        yield* Effect.sync(() => {
          if (sessions.has(input.sessionId)) return;
          sessions.set(input.sessionId, {
            protocolVersion: input.protocolVersion,
            requestNamespace: input.scope.requestNamespace,
            environmentId: input.scope.environmentId,
            listener: undefined,
            seenAt,
            order: ++nextOrder,
          });
        });
      });

    const authorizeExistingSession: McpLiveNotifications["Service"]["authorizeExistingSession"] = (
      input,
    ) =>
      Effect.gen(function* () {
        yield* sweep;
        const seenAt = yield* Clock.currentTimeMillis;
        return yield* Effect.sync((): SessionAccess => {
          const session = sessions.get(input.sessionId);
          if (session === undefined) return "absent";
          if (!sameScope(session, input.scope)) return "foreign";
          stamp(session, seenAt);
          return "owned";
        });
      });

    const endSession: McpLiveNotifications["Service"]["endSession"] = (sessionId) =>
      Effect.sync(() => {
        const session = sessions.get(sessionId);
        sessions.delete(sessionId);
        return session?.listener;
      }).pipe(
        Effect.flatMap((queue) => (queue === undefined ? Effect.void : Queue.shutdown(queue))),
      );

    const listen: McpLiveNotifications["Service"]["listen"] = (input) =>
      Effect.gen(function* () {
        if (input.sessionId === undefined || input.sessionId.length === 0) {
          return yield* new McpListenMissingSession();
        }
        yield* sweep;
        const sessionId = input.sessionId;
        const queue = yield* Queue.sliding<Uint8Array>(1);
        const seenAt = yield* Clock.currentTimeMillis;
        const decision = yield* Effect.sync(() => {
          const session = sessions.get(sessionId);
          if (session === undefined || !sameScope(session, input.scope)) return "unknown" as const;
          if (
            input.protocolVersion !== undefined &&
            input.protocolVersion !== session.protocolVersion
          ) {
            return "mismatch" as const;
          }
          if (session.listener !== undefined) return "attached" as const;
          session.listener = queue;
          stamp(session, seenAt);
          return { _tag: "ok" as const, protocolVersion: session.protocolVersion };
        });
        if (decision === "unknown" || decision === "mismatch" || decision === "attached") {
          yield* Queue.shutdown(queue);
          if (decision === "mismatch") return yield* new McpListenProtocolMismatch();
          if (decision === "attached") return yield* new McpListenAlreadyAttached();
          return yield* new McpListenUnknownSession();
        }
        // The comment is not an event. It flushes the HTTP head for clients
        // that wait for the first byte, and it does not depend on the clock.
        const events = Stream.make(openFrame).pipe(
          Stream.concat(
            Stream.fromQueue(queue).pipe(
              Stream.merge(
                Stream.tick(MCP_SSE_KEEPALIVE).pipe(
                  Stream.drop(1),
                  Stream.map(() => keepaliveFrame),
                ),
                { haltStrategy: "left" },
              ),
            ),
          ),
          // The response body is the connection. Ending or interrupting it clears
          // the slot; DELETE shuts this queue down so the same cleanup runs.
          Stream.ensuring(releaseListener(sessionId, queue)),
        );
        return { sessionId, protocolVersion: decision.protocolVersion, events };
      });

    const publishToolsListChanged = Effect.sync(() => {
      const queues: Array<Queue.Queue<Uint8Array>> = [];
      for (const session of sessions.values()) {
        if (session.listener !== undefined) queues.push(session.listener);
      }
      return queues;
    }).pipe(
      Effect.flatMap((queues) =>
        Effect.forEach(
          queues,
          (queue) => Queue.offer(queue, listChangedFrame).pipe(Effect.ignoreCause),
          { discard: true },
        ),
      ),
    );

    yield* sweep.pipe(Effect.repeat(Schedule.spaced(options.idleTtl)), Effect.forkScoped);

    return McpLiveNotifications.of({
      bindInitializedSession,
      endSession,
      authorizeExistingSession,
      listen,
      publishToolsListChanged,
      awaitListenerReleased: Queue.take(releases),
    });
  });

const resolveOptions = (options?: {
  readonly limit?: number;
  readonly idleTtl?: Duration.Input;
}): LiveNotificationsOptions => ({
  limit: options?.limit ?? MCP_SESSION_LIMIT,
  idleTtl: Duration.fromInputUnsafe(options?.idleTtl ?? MCP_SESSION_IDLE_TTL),
});

/** Production bounds. Tests pass a smaller cap or idle TTL. */
export const layerWith = (options?: {
  readonly limit?: number;
  readonly idleTtl?: Duration.Input;
}) => Layer.effect(McpLiveNotifications, make(resolveOptions(options)));

export const layer = layerWith();
