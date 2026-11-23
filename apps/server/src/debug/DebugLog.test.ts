import * as Logger from "effect/Logger";
import {
  CLOUD_ENDPOINT_HTTP_BASE_URL,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINK_REVOKED,
} from "../cloud/config.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Option from "effect/Option";
import * as Clock from "effect/Clock";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter } from "effect/http";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import { layerBrowserApiCors } from "../http.ts";
import * as DebugLog from "./DebugLog.ts";
import * as DebugLogHttp from "./DebugLogHttp.ts";

const thread = ThreadId.make("debug-owner");
const other = ThreadId.make("debug-other");
const secrets = Layer.mock(ServerSecretStore.ServerSecretStore)({
  get: () => Effect.succeed(Option.none()),
});
const config = Layer.mock(ServerConfig.ServerConfig)({
  port: 45679,
  devUrl: new URL("http://localhost:45680"),
  devAllowedOrigins: [],
} as unknown as ServerConfig.ServerConfig["Service"]);
const layer = DebugLog.layer.pipe(
  Layer.provide(secrets),
  Layer.provide(
    Layer.merge(
      config,
      Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
    ),
  ),
);
const body = (text: string) => Stream.make(new TextEncoder().encode(text));
const credentials = (url: string) => new URL(url).pathname.split("/").slice(-2) as [string, string];
const status = <A>(effect: Effect.Effect<A, DebugLog.DebugLogError>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.status),
  );

it.effect(
  "owns sessions by thread; cursor/filter reads advance without losing events; stop erases capture",
  () =>
    Effect.gen(function* () {
      const log = yield* DebugLog.DebugLog;
      const session = yield* log.start(thread);
      expect(new URL(session.ingestUrl).hostname).toBe("127.0.0.1");
      const [id, token] = credentials(session.ingestUrl);
      expect(token).toMatch(/^[a-f0-9]{64}$/);
      for (const text of ["skip", '{"hypothesis":"a"}', "skip", "a again"])
        yield* log.ingest(id, token, body(text));
      expect(yield* status(log.read(other, { sessionId: id }))).toBe(404);
      expect(yield* status(log.stop(other, id))).toBe(404);
      const first = yield* log.read(thread, { sessionId: id, filter: "a", limit: 1 });
      expect(first.events.map((e) => e.text)).toEqual(['{"hypothesis":"a"}']);
      expect(first).toMatchObject({ nextCursor: 3, hasMore: true });
      const second = yield* log.read(thread, {
        sessionId: id,
        cursor: first.nextCursor,
        filter: "a",
      });
      expect(second.events.map((e) => e.text)).toEqual(["a again"]);
      expect(second).toMatchObject({ nextCursor: 4, hasMore: false });
      expect((yield* log.read(thread, { sessionId: id, filter: "missing" })).nextCursor).toBe(4);
      yield* log.stop(thread, id);
      expect(yield* status(log.read(thread, { sessionId: id }))).toBe(404);
      expect(yield* status(log.ingest(id, token, body("late")))).toBe(404);
    }).pipe(Effect.provide(layer)),
);

it.effect("expires idle captures and rejects bodies that finish after stop", () =>
  Effect.gen(function* () {
    const log = yield* DebugLog.DebugLog;
    let session = yield* log.start(thread);
    const [id, token] = credentials(session.ingestUrl);
    yield* TestClock.adjust(DebugLog.IDLE_MS - 1);
    yield* log.read(thread, { sessionId: id });
    yield* TestClock.adjust(DebugLog.IDLE_MS);
    expect(yield* status(log.ingest(id, token, body("expired")))).toBe(404);
    session = yield* log.start(thread);
    const [nextId, nextToken] = credentials(session.ingestUrl);
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const delayed = Stream.fromEffect(
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Deferred.await(finish)),
        Effect.as(new Uint8Array([1])),
      ),
    );
    const pending = yield* status(log.ingest(nextId, nextToken, delayed)).pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* log.stop(thread, nextId);
    yield* Deferred.succeed(finish, undefined);
    expect(yield* Fiber.join(pending)).toBe(404);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "bounds event size, stored bytes, event count, session count, and escaped read bytes",
  () =>
    Effect.gen(function* () {
      const log = yield* DebugLog.DebugLog;
      const session = yield* log.start(thread);
      const [id, token] = credentials(session.ingestUrl);
      expect(
        yield* status(log.ingest(id, token, body("x".repeat(DebugLog.MAX_EVENT_BYTES + 1)))),
      ).toBe(413);
      const escaped = "\u0000".repeat(DebugLog.MAX_EVENT_BYTES);
      yield* log.ingest(id, token, body(escaped));
      yield* log.ingest(id, token, body(escaped));
      const read = yield* log.read(thread, { sessionId: id });
      expect(Buffer.byteLength(JSON.stringify(read))).toBeLessThanOrEqual(DebugLog.MAX_READ_BYTES);
      expect(read).toMatchObject({ nextCursor: 1, hasMore: true });
      let accepted = 2;
      while (true) {
        const result = yield* log.ingest(id, token, body(escaped)).pipe(Effect.result);
        if (result._tag === "Failure") {
          expect(result.failure.status).toBe(429);
          break;
        }
        accepted++;
      }
      expect(accepted).toBeLessThan(20);
      const countSession = yield* log.start(thread);
      const [countId, countToken] = credentials(countSession.ingestUrl);
      for (let i = 0; i < DebugLog.MAX_EVENTS; i++)
        yield* log.ingest(countId, countToken, body(""));
      expect(yield* status(log.ingest(countId, countToken, body("")))).toBe(429);
      yield* log.start(thread);
      yield* log.start(thread);
      expect(yield* status(log.start(thread))).toBe(429);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "HTTP requires a token even behind a loopback proxy, stays write-only, and supports cross-origin posts in dev",
  () =>
    Effect.gen(function* () {
      const log = yield* DebugLog.DebugLog;
      const session = yield* log.start(thread);
      const clock = yield* Clock.Clock;
      const requestLogs: unknown[] = [];
      const route = DebugLogHttp.layer.pipe(
        Layer.provide(layerBrowserApiCors),
        Layer.provide(config),
        Layer.provideMerge(Layer.succeed(DebugLog.DebugLog, log)),
        Layer.provideMerge(Layer.succeed(Clock.Clock, clock)),
        Layer.provideMerge(
          Logger.layer(
            [
              Logger.make(({ message }) => {
                requestLogs.push(message);
              }),
            ],
            { mergeWithExisting: false },
          ),
        ),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(route);
      yield* Effect.addFinalizer(() => Effect.promise(dispose));
      const request = (url: string, method: string, data?: string) =>
        Effect.promise(() =>
          handler(
            new Request(url, {
              method,
              headers: {
                origin: "https://runtime.example",
                "x-forwarded-for": "203.0.113.1",
                "x-forwarded-host": "relay.example",
                "content-type": "application/json",
              },
              ...(data === undefined ? {} : { body: data }),
            }),
          ),
        );
      const noToken = session.ingestUrl.slice(0, session.ingestUrl.lastIndexOf("/"));
      expect((yield* request(noToken, "POST", "no token")).status).toBe(404);
      expect((yield* request(`${noToken}/${"0".repeat(64)}`, "POST", "wrong token")).status).toBe(
        404,
      );
      expect((yield* request(session.ingestUrl, "GET")).status).toBe(405);
      const preflight = yield* request(session.ingestUrl, "OPTIONS");
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-origin")).toBe("*");
      const posted = yield* request(session.ingestUrl, "POST", '{"event":"phone"}');
      expect(posted.status).toBe(204);
      expect(posted.headers.get("access-control-allow-origin")).toBe("*");
      expect((yield* log.read(thread, { sessionId: session.sessionId })).events).toHaveLength(1);
      expect(
        (yield* request(session.ingestUrl, "POST", "x".repeat(DebugLog.MAX_EVENT_BYTES + 1)))
          .status,
      ).toBe(413);
      const [id, token] = credentials(session.ingestUrl);
      while (
        (yield* log
          .ingest(id, token, body("x".repeat(DebugLog.MAX_EVENT_BYTES)))
          .pipe(Effect.result))._tag === "Success"
      ) {}
      expect(
        (yield* request(session.ingestUrl, "POST", "x".repeat(DebugLog.MAX_EVENT_BYTES))).status,
      ).toBe(429);
      expect(requestLogs).toEqual([]);
      yield* log.stop(thread, session.sessionId);
      expect((yield* request(session.ingestUrl, "POST", "stopped")).status).toBe(404);
    }).pipe(Effect.provide(layer)),
);

it.effect("posts locally and offers a known phone-reachable base", () =>
  Effect.gen(function* () {
    const log = yield* DebugLog.DebugLog;
    const session = yield* log.start(thread);
    expect(new URL(session.ingestUrl).origin).toBe("http://127.0.0.1:45679");
    expect(new URL(session.remoteUrl!).origin).toBe("https://machine.tail.test");
    expect(new URL(session.remoteUrl!).pathname).toBe(new URL(session.ingestUrl).pathname);
  }).pipe(
    Effect.provide(
      DebugLog.layer.pipe(
        Layer.provide(secrets),
        Layer.provide(config),
        Layer.provide(
          Layer.mock(DirectEndpoints.DirectEndpoints)({
            resolve: () =>
              Effect.succeed([
                { kind: "lan", httpBaseUrl: "http://127.0.0.1:45679/" },
                { kind: "tailnet", httpBaseUrl: "https://machine.tail.test/" },
              ]),
          }),
        ),
      ),
    ),
  ),
);

it.effect.each([
  "https://relay-endpoint.test/",
  "https://user:pass@bad.test",
  "http://bad.test",
  "https://bad.test/path",
  null,
  "revoked",
])("uses only a known valid managed relay base: %s", (base) => {
  const values = new Map<string, string>([[CLOUD_ENDPOINT_RUNTIME_CONFIG, "managed"]]);
  if (base !== null)
    values.set(CLOUD_ENDPOINT_HTTP_BASE_URL, base === "revoked" ? "https://old.test/" : base);
  if (base === "revoked") values.set(CLOUD_LINK_REVOKED, "true");
  return Effect.gen(function* () {
    const log = yield* DebugLog.DebugLog;
    const session = yield* log.start(thread);
    expect(new URL(session.ingestUrl).origin).toBe("http://127.0.0.1:45679");
    expect(session.remoteUrl && new URL(session.remoteUrl).origin).toBe(
      base === "https://relay-endpoint.test/" ? "https://relay-endpoint.test" : undefined,
    );
  }).pipe(
    Effect.provide(
      DebugLog.layer.pipe(
        Layer.provide(config),
        Layer.provide(
          Layer.mock(DirectEndpoints.DirectEndpoints)({ resolve: () => Effect.succeed([]) }),
        ),
        Layer.provide(
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: (name) =>
              Effect.succeed(
                Option.map(Option.fromNullishOr(values.get(name)), (value) =>
                  new TextEncoder().encode(value),
                ),
              ),
          }),
        ),
      ),
    ),
  );
});

it.effect("limits total sessions and rejects invalid tokens before reading the body", () =>
  Effect.gen(function* () {
    const log = yield* DebugLog.DebugLog;
    const session = yield* log.start(thread);
    const [id] = credentials(session.ingestUrl);
    let consumed = false;
    const untrusted = Stream.fromEffect(
      Effect.sync(() => {
        consumed = true;
        return new Uint8Array([1]);
      }),
    );
    expect(yield* status(log.ingest(id, "", untrusted))).toBe(404);
    expect(yield* status(log.ingest(id, "bad", untrusted))).toBe(404);
    expect(consumed).toBe(false);
    for (let i = 1; i < 32; i++) yield* log.start(ThreadId.make(`owner-${i}`));
    expect(yield* status(log.start(ThreadId.make("overflow")))).toBe(429);
    yield* log.stop(thread, id);
    yield* log.start(ThreadId.make("reclaimed"));
  }).pipe(Effect.provide(layer)),
);
