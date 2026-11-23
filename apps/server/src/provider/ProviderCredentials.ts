import {
  ProviderCredentialReplaceError,
  type ProviderCredentialRecovery,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  type ReplaceProviderCredentialInput,
  type ReplaceProviderCredentialResult,
  type ServerSettings,
  type ServerSettingsPatch,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";

import * as Settings from "../serverSettings.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as Registry from "./ProviderInstanceRegistry.ts";
import * as RegistryMutator from "./ProviderInstanceRegistryMutator.ts";
import {
  affectedCredentialInstances,
  isRejectedApiCredential,
  resolveCredentialTarget,
  openCodeProvidersForKeyVariable,
  type CredentialTarget,
} from "./credentialResolution.ts";

const isCredentialReplaceError = Schema.is(ProviderCredentialReplaceError);

export class ProviderCredentials extends Context.Service<
  ProviderCredentials,
  {
    readonly enrichRun: (
      run: OrchestrationV2Run,
      failure?: OrchestrationV2ProviderFailure,
    ) => Effect.Effect<OrchestrationV2Run>;
    readonly enrichProjection: (
      projection: OrchestrationV2ThreadProjection,
    ) => Effect.Effect<OrchestrationV2ThreadProjection>;
    readonly refreshesOnResume: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly enrichEvent: (
      event: OrchestrationV2DomainEvent,
    ) => Effect.Effect<OrchestrationV2DomainEvent>;
    readonly replace: (
      input: ReplaceProviderCredentialInput,
    ) => Effect.Effect<ReplaceProviderCredentialResult, ProviderCredentialReplaceError>;
  }
>()("t3/provider/ProviderCredentials") {}

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const registry = yield* Registry.ProviderInstanceRegistry;
  const mutator = yield* Effect.serviceOption(RegistryMutator.ProviderInstanceRegistryMutator);
  const crypto = yield* Crypto.Crypto;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const writes = yield* Semaphore.make(1);
  const refs = new Map<
    string,
    { target: CredentialTarget; run: OrchestrationV2Run; label: string }
  >();
  const targetKey = (target: CredentialTarget) =>
    JSON.stringify(
      target.kind === "shared"
        ? [target.kind, target.instanceId, target.sharedKeyId]
        : target.kind === "variable"
          ? [target.kind, target.instanceId, target.variableName, target.previousValue]
          : [target.kind, target.instanceId, target.providerId, target.store],
    );
  const identifyStores = (instances: ReadonlyArray<ProviderInstance>) =>
    Effect.forEach(
      instances.filter((instance) => instance.driverKind === "opencode"),
      (instance) =>
        instance.apiKeyStoreId === undefined
          ? Effect.succeed(undefined)
          : instance.apiKeyStoreId.pipe(
              Effect.map((id) => [instance.instanceId, id] as const),
              Effect.orElseSucceed(() => undefined),
            ),
      { concurrency: 4 },
    ).pipe(Effect.map((entries) => new Map(entries.filter((entry) => entry !== undefined))));

  const resolve = (
    current: ServerSettings,
    run: OrchestrationV2Run,
    instances: ReadonlyArray<ProviderInstance>,
    stores: ReadonlyMap<ProviderInstanceId, string>,
  ) => {
    const live = instances.find((instance) => instance.instanceId === run.providerInstanceId);
    const implicit =
      live?.driverKind === "opencode" && live.replaceApiKey !== undefined
        ? { driver: live.driverKind, displayName: live.displayName }
        : undefined;
    const resolved = resolveCredentialTarget(current, run, implicit);
    // Inline auth overrides and unidentified stores cannot be repaired by setting an env var.
    if (live?.driverKind === "opencode" && !stores.has(live.instanceId)) return undefined;
    if (resolved?.target.kind !== "opencode") return resolved;
    if (live?.replaceApiKey === undefined) return undefined;
    return {
      ...resolved,
      target: { ...resolved.target, store: stores.get(live.instanceId)! },
    };
  };

  const affected = (
    current: ServerSettings,
    target: CredentialTarget,
    instances: ReadonlyArray<ProviderInstance>,
    stores: ReadonlyMap<ProviderInstanceId, string>,
  ) => {
    if (target.kind === "opencode")
      return instances
        .filter(
          (instance) =>
            instance.replaceApiKey !== undefined &&
            stores.get(instance.instanceId) === target.store,
        )
        .map((instance) => instance.instanceId);
    const ids = affectedCredentialInstances(current, target);
    // Setting an OpenCode env key must also replace its higher-priority stored key.
    const touchedStores = new Set(ids.flatMap((id) => (stores.has(id) ? [stores.get(id)!] : [])));
    return [
      ...new Set([
        ...ids,
        ...instances
          .filter((instance) => touchedStores.has(stores.get(instance.instanceId) ?? ""))
          .map((instance) => instance.instanceId),
      ]),
    ];
  };

  const enrichRun = (
    run: OrchestrationV2Run,
    failure?: OrchestrationV2ProviderFailure,
  ): Effect.Effect<OrchestrationV2Run> => {
    if (run.status !== "failed") return Effect.succeed(run);
    return Effect.gen(function* () {
      const error =
        failure ??
        (yield* projections.getThreadRecords(run.threadId, ["turnItems"], {
          turnItemRunIds: [run.id],
          turnItemTypes: ["error"],
        })).turnItems.findLast((item) => item.type === "error")?.failure;
      if (error === undefined || !isRejectedApiCredential(error)) return run;
      const current = yield* settings.getSettings;
      const instances = yield* registry.listInstances;
      const stores = yield* identifyStores(instances);
      const resolved = resolve(current, run, instances, stores);
      if (resolved === undefined) return run;
      const credentialRef =
        [...refs].find(
          ([, entry]) => targetKey(entry.target) === targetKey(resolved.target),
        )?.[0] ?? (yield* crypto.randomUUIDv4());
      if (!refs.has(credentialRef) && refs.size >= 1_024) {
        const oldest = refs.keys().next().value;
        if (oldest !== undefined) refs.delete(oldest);
      }
      refs.set(credentialRef, { target: resolved.target, run, label: resolved.label });
      const alsoUsedBy = affected(current, resolved.target, instances, stores)
        .filter((id) => id !== run.providerInstanceId)
        .map(
          (id) =>
            current.providerInstances[id]?.displayName ??
            instances.find((instance) => instance.instanceId === id)?.displayName ??
            id,
        );
      const credentialRecovery: ProviderCredentialRecovery = {
        credentialRef,
        label: resolved.label,
        ...(resolved.consoleUrl === undefined ? {} : { consoleUrl: resolved.consoleUrl }),
        alsoUsedBy: [...new Set(alsoUsedBy)],
      };
      return { ...run, credentialRecovery };
    }).pipe(Effect.orElseSucceed(() => run));
  };

  const replace: ProviderCredentials["Service"]["replace"] = (input) =>
    writes.withPermit(
      Effect.gen(function* () {
        const value = input.value.trim();
        if (!value || value.includes("\r") || value.includes("\n") || value.includes("\0"))
          return yield* new ProviderCredentialReplaceError({ reason: "invalid-value" });
        const ref = refs.get(input.credentialRef);
        if (ref === undefined)
          return yield* new ProviderCredentialReplaceError({ reason: "unavailable" });
        const instances = yield* registry.listInstances;
        const stores = yield* identifyStores(instances);
        let updatedInstanceIds: ProviderInstanceId[] = [];
        const target = ref.target;
        const validate = (current: ServerSettings) => {
          const resolved = resolve(current, ref.run, instances, stores);
          return resolved !== undefined && targetKey(resolved.target) === targetKey(ref.target);
        };
        if (target.kind === "opencode") {
          yield* settings
            .withSettingsSnapshot((current) =>
              Effect.gen(function* () {
                if (!validate(current))
                  return yield* new ProviderCredentialReplaceError({ reason: "unavailable" });
                const instance = instances.find(
                  (candidate) => candidate.instanceId === target.instanceId,
                );
                if (instance?.replaceApiKey === undefined)
                  return yield* new ProviderCredentialReplaceError({ reason: "unavailable" });
                yield* instance
                  .replaceApiKey(target.providerId, value)
                  .pipe(
                    Effect.mapError(() => new ProviderCredentialReplaceError({ reason: "save" })),
                  );
                updatedInstanceIds = affected(current, target, instances, stores);
              }),
            )
            .pipe(
              Effect.mapError((error) =>
                isCredentialReplaceError(error)
                  ? error
                  : new ProviderCredentialReplaceError({ reason: "save" }),
              ),
            );
        } else {
          let promotedId: string | undefined;
          yield* settings
            .modifySettings((current) =>
              Effect.gen(function* () {
                if (!validate(current))
                  return yield* new ProviderCredentialReplaceError({ reason: "unavailable" });
                updatedInstanceIds = affected(current, target, instances, stores);
                if (target.kind === "shared")
                  return {
                    sharedKeys: {
                      [target.sharedKeyId]: {
                        label: current.sharedKeys[target.sharedKeyId]!.label,
                        value,
                      },
                    },
                  };
                promotedId = `key-${yield* crypto.randomUUIDv4()}`;
                const providerInstances = Object.fromEntries(
                  Object.entries(current.providerInstances).map(([id, instance]) => [
                    id,
                    {
                      ...instance,
                      ...(updatedInstanceIds.includes(id as ProviderInstanceId)
                        ? {
                            environment: instance.environment?.map((variable) =>
                              variable.sharedKey === undefined &&
                              variable.sensitive &&
                              (/(?:API_?KEY|API_TOKEN)$/iu.test(variable.name) ||
                                variable.name === "ANTHROPIC_AUTH_TOKEN") &&
                              variable.value === target.previousValue
                                ? {
                                    name: variable.name,
                                    sensitive: true,
                                    value: "",
                                    sharedKey: promotedId!,
                                  }
                                : variable,
                            ),
                          }
                        : {}),
                    },
                  ]),
                ) as ProviderInstanceConfigMap;
                return {
                  sharedKeys: { [promotedId]: { label: ref.label.slice(0, 80), value } },
                  providerInstances,
                } satisfies ServerSettingsPatch;
              }),
            )
            .pipe(
              Effect.mapError((error) =>
                isCredentialReplaceError(error)
                  ? error
                  : new ProviderCredentialReplaceError({ reason: "save" }),
              ),
            );
          if (promotedId !== undefined)
            ref.target = { kind: "shared", instanceId: target.instanceId, sharedKeyId: promotedId };
          // OpenCode prefers active stored credentials to environment keys. Keep the native
          // stores in sync, including other instances that share those stores.
          yield* settings
            .withSettingsSnapshot((current) =>
              Effect.gen(function* () {
                const written = new Set<string>();
                for (const instance of instances) {
                  if (instance.replaceApiKey === undefined || !stores.has(instance.instanceId))
                    continue;
                  const providers = new Set(
                    (current.providerInstances[instance.instanceId]?.environment ?? [])
                      .filter(
                        (variable) =>
                          ref.target.kind === "shared" &&
                          variable.sharedKey === ref.target.sharedKeyId,
                      )
                      .flatMap((variable) => openCodeProvidersForKeyVariable(variable.name)),
                  );
                  if (
                    instance.instanceId === target.instanceId &&
                    instance.driverKind === "opencode"
                  ) {
                    const providerId = /^([\w.-]+)\//u.exec(ref.run.modelSelection.model)?.[1];
                    if (providerId) providers.add(providerId);
                  }
                  for (const providerId of providers) {
                    const identity = `${stores.get(instance.instanceId)}:${providerId}`;
                    if (written.has(identity)) continue;
                    yield* instance
                      .replaceApiKey(providerId, value)
                      .pipe(
                        Effect.mapError(
                          () => new ProviderCredentialReplaceError({ reason: "save" }),
                        ),
                      );
                    written.add(identity);
                  }
                }
              }),
            )
            .pipe(
              Effect.mapError((error) =>
                isCredentialReplaceError(error)
                  ? error
                  : new ProviderCredentialReplaceError({ reason: "save" }),
              ),
            );
          // Reconcile synchronously so an immediate retry cannot reuse an adapter with the old env.
          yield* settings
            .withSettingsSnapshot((current) =>
              Option.isSome(mutator)
                ? mutator.value.patch(current.providerInstances)
                : Effect.fail(new ProviderCredentialReplaceError({ reason: "refresh" })),
            )
            .pipe(Effect.mapError(() => new ProviderCredentialReplaceError({ reason: "refresh" })));
        }
        if (!updatedInstanceIds.includes(target.instanceId))
          updatedInstanceIds.push(target.instanceId);
        yield* Effect.forEach(
          updatedInstanceIds,
          (id) =>
            // Idle sessions restart with the new key; running chats on the same
            // instance (other providers or models) keep going.
            (sessions.closeIdleInstance ?? sessions.closeInstance)(id).pipe(
              Effect.andThen(
                Effect.flatMap(
                  registry.getInstance(id),
                  (instance) => instance?.invalidateCaches ?? Effect.void,
                ),
              ),
            ),
          { discard: true },
        ).pipe(Effect.mapError(() => new ProviderCredentialReplaceError({ reason: "refresh" })));
        return { updatedInstanceIds };
      }),
    );

  return ProviderCredentials.of({
    enrichRun,
    // Recovery refs are process-local. A resumed failed chat needs a fresh descriptor,
    // including when its target was removed while this client was disconnected.
    refreshesOnResume: (threadId) =>
      Effect.gen(function* () {
        const shell = yield* projections.getThreadShell(threadId);
        if (shell?.status !== "failed" || shell.latestRunId === null) return false;
        const { turnItems } = yield* projections.getThreadRecords(threadId, ["turnItems"], {
          turnItemRunIds: [shell.latestRunId],
          turnItemTypes: ["error"],
        });
        const failure = turnItems.findLast((item) => item.type === "error")?.failure;
        return failure !== undefined && isRejectedApiCredential(failure);
      }).pipe(Effect.orElseSucceed(() => false)),
    enrichProjection: (projection) =>
      Effect.gen(function* () {
        const latest = projection.runs.at(-1);
        if (latest?.status !== "failed") return projection;
        const error = projection.turnItems.findLast(
          (item) => item.runId === latest.id && item.type === "error",
        );
        const run = yield* enrichRun(latest, error?.type === "error" ? error.failure : undefined);
        return run === latest
          ? projection
          : {
              ...projection,
              runs: projection.runs.map((candidate) => (candidate.id === run.id ? run : candidate)),
            };
      }),
    enrichEvent: (event) =>
      event.type === "run.updated" && event.payload.status === "failed"
        ? enrichRun(event.payload).pipe(Effect.map((payload) => ({ ...event, payload })))
        : Effect.succeed(event),
    replace,
  });
});

export const layer = Layer.effect(ProviderCredentials, make);
