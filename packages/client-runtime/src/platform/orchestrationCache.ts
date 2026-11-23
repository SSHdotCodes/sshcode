import {
  EnvironmentId,
  OrchestrationV2ShellSnapshotJson,
  type OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjectionJson,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ORCHESTRATION_CACHE_SCHEMA_VERSION = 3 as const;
const APP_OWNED_SUBAGENT_SHELL_CACHE_VERSION = 4 as const;

/** Older clients must refresh instead of resuming an app-owned-omitted cache. */
export function orchestrationShellCacheSchemaVersion(snapshot: OrchestrationV2ShellSnapshot) {
  return snapshot.idleAppOwnedSubagentsOmitted === true
    ? APP_OWNED_SUBAGENT_SHELL_CACHE_VERSION
    : ORCHESTRATION_CACHE_SCHEMA_VERSION;
}
// Older caches may contain human turns that bypassed server history budgets.
export const ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION = 5 as const;

export const StoredOrchestrationShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literals([
    ORCHESTRATION_CACHE_SCHEMA_VERSION,
    APP_OWNED_SUBAGENT_SHELL_CACHE_VERSION,
  ]),
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshotJson,
});

export const StoredOrchestrationThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  snapshot: OrchestrationV2ThreadDetailSnapshot.mapFields((fields) => ({
    ...fields,
    projection: OrchestrationV2ThreadProjectionJson,
  })),
});

/** Invalid orchestration caches are disposable and must never block live synchronization. */
export function decodeOrDiscardOrchestrationCache<A, E, R, E2, R2>(
  decode: Effect.Effect<Option.Option<A>, E, R>,
  discard: Effect.Effect<void, E2, R2>,
) {
  return decode.pipe(Effect.catch(() => discard.pipe(Effect.as(Option.none<A>()))));
}
