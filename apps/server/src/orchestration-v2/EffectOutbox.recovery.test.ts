import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

it.effect(
  "replays pending and failed undelivered steering after process loss, preserving other receipts",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread:lost-steer");
      const providerTurnId = ProviderTurnId.make("turn:lost-steer");
      const request = {
        type: "provider-turn.steer" as const,
        providerSessionId: ProviderSessionId.make("session:lost-steer"),
        providerThreadId: ProviderThreadId.make("provider-thread:lost-steer"),
        providerTurnId,
        messageId: MessageId.make("message:lost-steer"),
      };
      yield* outbox.enqueue(
        ["failed", "pending", "running", "succeeded", "cancelled", "foreign-turn"].map((id) => ({
          id,
          threadId,
          commandId: CommandId.make(`command:${id}`),
          request:
            id === "foreign-turn"
              ? { ...request, providerTurnId: ProviderTurnId.make("turn:other") }
              : request,
        })),
      );
      for (const status of ["failed", "running", "succeeded", "cancelled"] as const) {
        yield* sql`UPDATE orchestration_v2_effect_outbox SET status = ${status}, attempt_count = 5 WHERE effect_id = ${status}`;
      }
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'failed' WHERE effect_id = 'foreign-turn'`;
      const reconciled = yield* outbox.reconcileAfterProcessLoss;
      assert.equal(reconciled.requeued, 1);
      assert.equal(reconciled.cancelled, 0);
      assert.equal(
        yield* outbox.requeueFailedSteers({ threadId, providerTurnIds: [providerTurnId] }),
        1,
      );
      const read = (id: string) => outbox.get(id).pipe(Effect.map(Option.getOrThrow));
      for (const id of ["failed", "pending", "running"])
        assert.equal((yield* read(id)).status, "pending");
      assert.equal((yield* read("failed")).attemptCount, 0);
      assert.equal((yield* read("succeeded")).status, "succeeded");
      assert.equal((yield* read("cancelled")).status, "cancelled");
      assert.equal((yield* read("foreign-turn")).status, "failed");
      assert.equal(
        yield* outbox.requeueFailedSteers({ threadId, providerTurnIds: [providerTurnId] }),
        0,
      );
      const plan = yield* sql<{ detail: string }>`EXPLAIN QUERY PLAN
      SELECT * FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${threadId} AND status = 'failed' AND effect_type = 'provider-turn.steer'
      ORDER BY rowid DESC
      LIMIT 100`;
      assert.isTrue(
        plan.some((row) => row.detail.includes("orchestration_v2_effect_outbox_thread_status_idx")),
      );
    assert.isFalse(plan.some((row) => row.detail.includes("TEMP B-TREE")));
      // Explicit Stop keeps cancelling steering, unlike process loss.
      assert.include(EffectOutbox.PROCESS_BOUND_EFFECT_TYPES, "provider-turn.steer");
    }).pipe(
      Effect.provide(EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory))),
    ),
);
