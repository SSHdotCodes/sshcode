// @effect-diagnostics nodeBuiltinImport:off -- capability tokens need timingSafeEqual.
import { readManagedEndpointBaseUrl } from "../cloud/config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as NodeCrypto from "node:crypto";
import type { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";

export const ROUTE_PREFIX = "/api/debug-log";
export const MAX_EVENT_BYTES = 64 * 1024;
export const MAX_SESSION_BYTES = 5 * 1024 * 1024;
export const MAX_EVENTS = 10_000;
export const MAX_READ_BYTES = 512 * 1024;
export const IDLE_MS = 2 * 60 * 60 * 1000;
const MAX_SESSIONS = 32;

export class DebugLogError extends Schema.TaggedError<DebugLogError>()("DebugLogError", {
  status: Schema.Literals([400, 404, 413, 429]),
}) {
  override get message() {
    switch (this.status) {
      case 400:
        return "Could not read the event body.";
      case 404:
        return "Debug session not found.";
      case 413:
        return "Debug event exceeds 64 KiB.";
      case 429:
        return "Debug capture limit reached; stop the session and start another.";
    }
  }
}

interface Event {
  readonly cursor: number;
  readonly time: number;
  readonly text: string;
}
interface Session {
  readonly threadId: ThreadId;
  readonly token: Buffer;
  readonly events: Event[];
  bytes: number;
  touched: number;
}

export class DebugLog extends Context.Service<
  DebugLog,
  {
    readonly start: (threadId: ThreadId) => Effect.Effect<
      {
        sessionId: string;
        ingestUrl: string;
        remoteUrl?: string;
      },
      DebugLogError
    >;
    readonly read: (
      threadId: ThreadId,
      input: {
        sessionId: string;
        cursor?: number | undefined;
        filter?: string | undefined;
        limit?: number | undefined;
      },
    ) => Effect.Effect<{ events: Event[]; nextCursor: number; hasMore: boolean }, DebugLogError>;
    readonly stop: (
      threadId: ThreadId,
      sessionId: string,
    ) => Effect.Effect<{ stopped: true }, DebugLogError>;
    readonly ingest: (
      sessionId: string,
      token: string,
      body: Stream.Stream<Uint8Array, unknown>,
    ) => Effect.Effect<void, DebugLogError>;
  }
>()("t3/debug/DebugLog") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const endpoints = yield* DirectEndpoints.DirectEndpoints;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const sessions = new Map<string, Session>();
  const discard = (id: string, session: Session) => {
    session.events.length = 0;
    session.token.fill(0);
    sessions.delete(id);
  };
  const sweep = (now: number) => {
    for (const [id, session] of sessions) {
      if (now - session.touched >= IDLE_MS) discard(id, session);
    }
  };
  yield* Clock.currentTimeMillis.pipe(
    Effect.tap((now) => Effect.sync(() => sweep(now))),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const [id, session] of sessions) discard(id, session);
    }),
  );

  const owned = Effect.fnUntraced(function* (threadId: ThreadId, id: string) {
    const now = yield* Clock.currentTimeMillis;
    sweep(now);
    const session = sessions.get(id);
    if (session === undefined || session.threadId !== threadId)
      return yield* new DebugLogError({ status: 404 });
    session.touched = now;
    return session;
  });

  return DebugLog.of({
    start: Effect.fnUntraced(function* (threadId) {
      const relayBase = yield* readManagedEndpointBaseUrl.pipe(
        Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
      );
      const known = yield* endpoints.resolve();
      const now = yield* Clock.currentTimeMillis;
      sweep(now);
      if (
        sessions.size >= MAX_SESSIONS ||
        [...sessions.values()].filter((s) => s.threadId === threadId).length >= 4
      ) {
        return yield* new DebugLogError({ status: 429 });
      }
      const sessionId = NodeCrypto.randomBytes(16).toString("hex");
      const token = NodeCrypto.randomBytes(32);
      sessions.set(sessionId, { threadId, token, touched: now, bytes: 0, events: [] });
      // Code on this machine posts locally so captures never leave it; other devices
      // (the phone, another computer) get the relay or tailnet address when one is known.
      const remote = known.filter((endpoint) => !isLoopbackBase(endpoint.httpBaseUrl));
      const remoteBase =
        relayBase ??
        remote.find((endpoint) => endpoint.httpBaseUrl.startsWith("https:"))?.httpBaseUrl ??
        remote.find((endpoint) => endpoint.kind === "tailnet")?.httpBaseUrl ??
        remote[0]?.httpBaseUrl;
      const path = `${ROUTE_PREFIX}/${sessionId}/${token.toString("hex")}`;
      return {
        sessionId,
        ingestUrl: new URL(path, `http://127.0.0.1:${config.port}`).href,
        ...(remoteBase === undefined ? {} : { remoteUrl: new URL(path, remoteBase).href }),
      };
    }),
    read: Effect.fnUntraced(function* (threadId, input) {
      const session = yield* owned(threadId, input.sessionId);
      const events: Event[] = [];
      let nextCursor = Math.min(Math.max(0, input.cursor ?? 0), session.events.length);
      let bytes = 128;
      const limit = Math.min(1000, Math.max(1, input.limit ?? 100));
      for (const event of session.events.slice(nextCursor)) {
        if (input.filter === undefined || event.text.includes(input.filter)) {
          // Sizes the reply as it will be sent; no decoding involved.
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          const size = Buffer.byteLength(JSON.stringify(event)) + 1;
          if (events.length >= limit || bytes + size > MAX_READ_BYTES) break;
          events.push(event);
          bytes += size;
        }
        nextCursor = event.cursor;
      }
      return { events, nextCursor, hasMore: nextCursor < session.events.length };
    }),
    stop: Effect.fnUntraced(function* (threadId, sessionId) {
      const session = yield* owned(threadId, sessionId);
      discard(sessionId, session);
      return { stopped: true as const };
    }),
    ingest: Effect.fnUntraced(function* (sessionId, token, body) {
      const now = yield* Clock.currentTimeMillis;
      sweep(now);
      const session = sessions.get(sessionId);
      // Never grant trust from the peer address: relay traffic also arrives on loopback.
      const supplied = /^[a-f0-9]{64}$/.test(token) ? Buffer.from(token, "hex") : Buffer.alloc(32);
      const valid = NodeCrypto.timingSafeEqual(session?.token ?? Buffer.alloc(32), supplied);
      if (session === undefined || !valid) return yield* new DebugLogError({ status: 404 });
      const chunks: Uint8Array[] = [];
      let size = 0;
      yield* Stream.runForEach(
        body.pipe(Stream.mapError(() => new DebugLogError({ status: 400 }))),
        (chunk) => {
          size += chunk.byteLength;
          if (size > MAX_EVENT_BYTES) return Effect.fail(new DebugLogError({ status: 413 }));
          chunks.push(chunk);
          return Effect.void;
        },
      );
      // The body can outlive stop or expiry. Recheck before committing, with no async gap.
      const finished = yield* Clock.currentTimeMillis;
      sweep(finished);
      if (sessions.get(sessionId) !== session) return yield* new DebugLogError({ status: 404 });
      const event = {
        cursor: session.events.length + 1,
        time: finished,
        text: Buffer.concat(chunks).toString("utf8"),
      };
      // @effect-diagnostics-next-line preferSchemaOverJson:off
      const storedBytes = Buffer.byteLength(JSON.stringify(event));
      if (session.bytes + storedBytes > MAX_SESSION_BYTES || session.events.length >= MAX_EVENTS) {
        return yield* new DebugLogError({ status: 429 });
      }
      session.events.push(event);
      session.bytes += storedBytes;
      session.touched = finished;
    }),
  });
});

const isLoopbackBase = (base: string) => {
  try {
    const host = new URL(base).hostname;
    return host === "localhost" || host === "[::1]" || host.startsWith("127.");
  } catch {
    return true;
  }
};

export const layer = Layer.effect(DebugLog, make);
