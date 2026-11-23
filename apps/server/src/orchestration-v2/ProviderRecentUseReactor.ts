/**
 * Puts how much each provider instance ran lately on its snapshot
 * (`ServerProvider.recentUse`), read from the run history on a database reader
 * every few minutes, so clients can order plans by use.
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import {
  RECENT_USE_HORIZON_MS,
  recentUseByInstance,
  type RecentUseRun,
} from "../provider/providerRecentUse.ts";
import { forkParked } from "../serverActivation.ts";

const REFRESH_INTERVAL = "10 minutes";

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const pass = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const since = DateTime.formatIso(DateTime.makeUnsafe(now - RECENT_USE_HORIZON_MS));
      const runs = yield* sql<RecentUseRun>`
        SELECT
          provider_instance_id AS "instanceId",
          requested_at AS "requestedAt",
          completed_at AS "completedAt"
        FROM orchestration_v2_projection_runs
        WHERE requested_at >= ${since}
      `.pipe(NodeSqliteClient.readOnly);
      yield* providers.setProviderRecentUse(recentUseByInstance(runs, now));
    }).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Could not read recent provider use", cause)),
    );
    yield* forkParked(pass.pipe(Effect.repeat(Schedule.spaced(REFRESH_INTERVAL))));
  }),
);
