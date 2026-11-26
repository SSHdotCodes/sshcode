import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpClient, HttpRouter } from "effect/http";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { countWorkingThreads } from "./WorkingThreads.ts";
import * as WorkingThreadsHttp from "./WorkingThreadsHttp.ts";

const insertRun = (input: {
  readonly runId: string;
  readonly threadId: string;
  readonly ordinal: number;
  readonly status: string;
  readonly providerThreadId?: string;
}) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, payload_json)
      VALUES (${input.runId}, ${input.threadId}, ${input.ordinal}, 'codex',
        ${input.providerThreadId ?? null}, ${input.status}, '2026-11-25T12:00:00.000Z', '{}')
    `;
  });

const insertProviderThread = (providerThreadId: string, payload: object) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_provider_threads
        (provider_thread_id, provider, status, updated_at, payload_json)
      VALUES (${providerThreadId}, 'antigravity', 'active', '2026-11-25T12:00:00.000Z',
        ${JSON.stringify(payload)})
    `;
  });

it.effect("counts chats a restart would cut, not work a restart carries on", () =>
  Effect.gen(function* () {
    expect(yield* countWorkingThreads).toBe(0);

    // Queued (held or not) and finished runs are carried over or done.
    yield* insertRun({ runId: "run:queued", threadId: "thread:a", ordinal: 1, status: "queued" });
    yield* insertRun({ runId: "run:done", threadId: "thread:a", ordinal: 2, status: "completed" });
    expect(yield* countWorkingThreads).toBe(0);

    // An agent whose reply ended but keeps its prompt open for background work.
    yield* insertProviderThread("provider-thread:agy", { waitingOnBackgroundWork: true });
    yield* insertRun({
      runId: "run:agy",
      threadId: "thread:b",
      ordinal: 1,
      status: "running",
      providerThreadId: "provider-thread:agy",
    });
    expect(yield* countWorkingThreads).toBe(0);

    yield* insertProviderThread("provider-thread:busy", {});
    yield* insertRun({
      runId: "run:busy",
      threadId: "thread:c",
      ordinal: 1,
      status: "running",
      providerThreadId: "provider-thread:busy",
    });
    yield* insertRun({
      runId: "run:starting",
      threadId: "thread:d",
      ordinal: 1,
      status: "starting",
    });
    // Preparing has no provider thread yet; a checkpoint capture is still the turn's work.
    yield* insertRun({ runId: "run:prep", threadId: "thread:e", ordinal: 1, status: "preparing" });
    yield* insertRun({ runId: "run:capture", threadId: "thread:f", ordinal: 1, status: "waiting" });
    expect(yield* countWorkingThreads).toBe(4);

    // Chats, not runs.
    yield* insertRun({ runId: "run:busy-2", threadId: "thread:c", ordinal: 2, status: "running" });
    expect(yield* countWorkingThreads).toBe(4);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("answers only direct local requests", () =>
  Effect.gen(function* () {
    yield* insertRun({ runId: "run:busy", threadId: "thread:a", ordinal: 1, status: "running" });
    const services = yield* Layer.build(
      HttpRouter.serve(WorkingThreadsHttp.layer, { disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
      ),
    );
    const client = Context.get(services, HttpClient.HttpClient);
    const local = yield* client.get("/api/local/activity");
    expect(local.status).toBe(200);
    expect(local.headers["cache-control"]).toBe("no-store");
    expect(yield* local.json).toEqual({ working: 1 });

    expect(
      (yield* client.get("/api/local/activity", {
        headers: { origin: "https://example.invalid" },
      })).status,
    ).toBe(403);
    // Tailscale Serve and the T3 Connect relay reach the server from loopback too.
    for (const forwarded of [
      { "x-forwarded-for": "203.0.113.9" },
      { "cf-connecting-ip": "203.0.113.9" },
      { forwarded: "for=203.0.113.9" },
    ]) {
      expect((yield* client.get("/api/local/activity", { headers: forwarded })).status).toBe(403);
    }
  }).pipe(Effect.scoped, Effect.provide(SqlitePersistence.layerMemory)),
);
