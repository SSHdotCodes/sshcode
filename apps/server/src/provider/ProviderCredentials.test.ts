import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  MessageId,
  type OrchestrationV2Run,
  type ProviderInstanceConfigMap,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";
import * as Settings from "../serverSettings.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Sessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Registry from "./ProviderInstanceRegistry.ts";
import * as Mutator from "./ProviderInstanceRegistryMutator.ts";
import * as Credentials from "./ProviderCredentials.ts";

const instanceId = ProviderInstanceId.make("opencode");
const otherId = ProviderInstanceId.make("other");
const isolatedId = ProviderInstanceId.make("isolated");
const driver = ProviderDriverKind.make("opencode");
const run: OrchestrationV2Run = {
  id: RunId.make("failed-run"),
  threadId: ThreadId.make("thread"),
  ordinal: 1,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: "opencode/inkling-2-small-free" },
  providerThreadId: null,
  userMessageId: MessageId.make("message"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "failed",
  requestedAt: DateTime.makeUnsafe("2026-11-07T00:00:00Z"),
  startedAt: null,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const failure = {
  class: "provider_error" as const,
  message:
    "This API key has expired. Create a new API key in OpenCode Console and replace it in your client or secret store. Signing in again will not renew this key.",
  code: null,
  retryable: false,
};
const keyVariable = (value: string) => ({ name: "OPENCODE_API_KEY", sensitive: true, value });

function harness(
  providerInstances: ProviderInstanceConfigMap,
  sharedKeys = {},
  extra: { failWrite?: boolean; failRefresh?: boolean } = {},
) {
  const put = vi.fn((_providerId: string, _value: string) =>
    extra.failWrite ? Effect.fail({ _tag: "FakeWriteError" }) : Effect.void,
  );
  const invalidate = vi.fn(() => Effect.void);
  const instances = [instanceId, otherId, isolatedId].map(
    (id) =>
      ({
        instanceId: id,
        driverKind: providerInstances[id]?.driver ?? driver,
        displayName: id === otherId ? "Other OpenCode" : id,
        apiKeyStoreId: Effect.succeed(id === isolatedId ? "isolated-store" : "same-store"),
        replaceApiKey: put,
        invalidateCaches: Effect.suspend(invalidate),
      }) as unknown as ProviderInstance,
  );
  const close = vi.fn((_id: ProviderInstanceId) =>
    extra.failRefresh ? Effect.fail({ _tag: "FakeCloseError" }) : Effect.void,
  );
  const patch = vi.fn((_config: ProviderInstanceConfigMap) => Effect.void);
  const base = Layer.mergeAll(
    Settings.layerTest({ providerInstances, sharedKeys }),
    Layer.succeed(Registry.ProviderInstanceRegistry, {
      listInstances: Effect.succeed(instances),
      getInstance: (id: ProviderInstanceId) =>
        Effect.succeed(instances.find((instance) => instance.instanceId === id)),
    } as unknown as Registry.ProviderInstanceRegistry["Service"]),
    Layer.succeed(Mutator.ProviderInstanceRegistryMutator, { reconcile: () => Effect.void, patch }),
    Layer.succeed(Sessions.ProviderSessionManagerV2, {
      closeInstance: close,
    } as unknown as Sessions.ProviderSessionManagerV2["Service"]),
    Layer.succeed(ProjectionStore.ProjectionStoreV2, {
      getThreadShell: () => Effect.succeed({ latestRunId: run.id, status: "failed" }),
      getThreadRecords: () =>
        Effect.succeed({ turnItems: [{ type: "error", runId: run.id, failure }] }),
    } as unknown as ProjectionStore.ProjectionStoreV2["Service"]),
  );
  return {
    put,
    close,
    patch,
    invalidate,
    layer: Credentials.layer.pipe(Layer.provideMerge(base), Layer.provideMerge(NodeServices.layer)),
  };
}

describe("provider credential replacement", () => {
  it.effect("updates a shared key and refreshes every linked instance", () => {
    const h = harness(
      {
        [instanceId]: { driver, environment: [{ ...keyVariable(""), sharedKey: "zen" }] },
        [otherId]: {
          driver,
          displayName: "Other",
          environment: [{ name: "OPENAI_API_KEY", value: "", sensitive: true, sharedKey: "zen" }],
        },
      },
      { zen: { label: "Zen key", value: "synthetic-old-key" } },
    );
    return Effect.gen(function* () {
      const credentials = yield* Credentials.ProviderCredentials;
      const recovery = (yield* credentials.enrichRun(run, failure)).credentialRecovery!;
      expect(recovery).toMatchObject({ label: "Zen key", alsoUsedBy: ["Other"] });
      expect(JSON.stringify(recovery)).not.toContain("synthetic-old-key");
      expect(recovery.credentialRef).not.toContain("zen");
      expect(
        yield* credentials.replace({
          credentialRef: recovery.credentialRef,
          value: "synthetic-new-key",
        }),
      ).toEqual({ updatedInstanceIds: [instanceId, otherId] });
      expect(
        (yield* (yield* Settings.ServerSettingsService).getSettings).sharedKeys.zen?.value,
      ).toBe("synthetic-new-key");
      expect(h.close.mock.calls.map(([id]) => id)).toEqual([instanceId, otherId]);
      expect(h.put.mock.calls.map(([provider]) => provider)).toEqual([
        "opencode",
        "opencode-go",
        "openai",
      ]);
      expect(h.patch).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("promotes identical direct keys across drivers to one shared key", () => {
    const h = harness({
      [instanceId]: { driver, environment: [keyVariable("synthetic-old-key")] },
      [otherId]: {
        driver: ProviderDriverKind.make("acpRegistry"),
        environment: [{ name: "OPENAI_API_KEY", value: "synthetic-old-key", sensitive: true }],
      },
      [isolatedId]: { driver, environment: [keyVariable("different-test-key")] },
    });
    return Effect.gen(function* () {
      const credentials = yield* Credentials.ProviderCredentials;
      const recovery = (yield* credentials.enrichRun(run, failure)).credentialRecovery!;
      yield* credentials.replace({ credentialRef: recovery.credentialRef, value: "new-test-key" });
      const current = yield* (yield* Settings.ServerSettingsService).getSettings;
      const first = current.providerInstances[instanceId]?.environment?.[0];
      const second = current.providerInstances[otherId]?.environment?.[0];
      expect(first?.sharedKey).toBeDefined();
      expect(second?.sharedKey).toBe(first?.sharedKey);
      expect(current.sharedKeys[first!.sharedKey!]?.value).toBe("new-test-key");
      expect(current.providerInstances[isolatedId]?.environment?.[0]?.sharedKey).toBeUndefined();
      expect(h.close.mock.calls.map(([id]) => id)).toEqual([instanceId, otherId]);
      // A refresh retry after promotion must keep working with the original opaque reference.
      yield* credentials.replace({
        credentialRef: recovery.credentialRef,
        value: "another-test-key",
      });
    }).pipe(Effect.provide(h.layer));
  });

  it.effect(
    "writes OpenCode credentials through its provider hook and groups the live store",
    () => {
      const h = harness({
        [instanceId]: { driver },
        [otherId]: { driver, displayName: "Other OpenCode" },
        [isolatedId]: { driver },
      });
      return Effect.gen(function* () {
        const credentials = yield* Credentials.ProviderCredentials;
        const recovery = (yield* credentials.enrichRun(run, failure)).credentialRecovery!;
        expect(recovery).toMatchObject({
          label: "OpenCode Zen API key",
          alsoUsedBy: ["Other OpenCode"],
        });
        expect(
          yield* credentials.replace({
            credentialRef: recovery.credentialRef,
            value: "new-test-key",
          }),
        ).toEqual({ updatedInstanceIds: [instanceId, otherId] });
        expect(h.put).toHaveBeenCalledExactlyOnceWith("opencode", "new-test-key");
        expect(h.patch).not.toHaveBeenCalled();
        expect(h.close.mock.calls.map(([id]) => id)).toEqual([instanceId, otherId]);
      }).pipe(Effect.provide(h.layer));
    },
  );

  it.effect("does not offer replacement on a non-auth failure or running turn", () => {
    const h = harness({ [instanceId]: { driver } });
    return Effect.gen(function* () {
      const credentials = yield* Credentials.ProviderCredentials;
      expect(
        (yield* credentials.enrichRun(run, { ...failure, message: "Rate limit exceeded" }))
          .credentialRecovery,
      ).toBeUndefined();
      expect(
        (yield* credentials.enrichRun({ ...run, status: "running" }, failure)).credentialRecovery,
      ).toBeUndefined();
      expect(yield* credentials.refreshesOnResume(run.threadId)).toBe(true);
      const projection = {
        runs: [run],
        turnItems: [{ type: "error", runId: run.id, failure }],
      } as unknown as OrchestrationV2ThreadProjection;
      expect(
        (yield* credentials.enrichProjection(projection)).runs[0]?.credentialRecovery,
      ).toBeDefined();
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("rejects unknown and stale references without writing", () => {
    const h = harness({ [instanceId]: { driver, environment: [keyVariable("old-test-key")] } });
    return Effect.gen(function* () {
      const credentials = yield* Credentials.ProviderCredentials;
      expect(
        yield* credentials
          .replace({ credentialRef: "unknown", value: "new-test-key" })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "unavailable" });
      const ref = (yield* credentials.enrichRun(run, failure)).credentialRecovery!.credentialRef;
      yield* (yield* Settings.ServerSettingsService).updateSettings({
        providerInstances: {
          [instanceId]: { driver, environment: [keyVariable("changed-test-key")] },
        },
      });
      expect(
        yield* credentials.replace({ credentialRef: ref, value: "new-test-key" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "unavailable" });
      expect(h.patch).not.toHaveBeenCalled();
      expect(h.close).not.toHaveBeenCalled();
    }).pipe(Effect.provide(h.layer));
  });

  it.effect("returns a safe inline failure when OpenCode refuses the write", () => {
    const h = harness({ [instanceId]: { driver } }, {}, { failWrite: true });
    return Effect.gen(function* () {
      const credentials = yield* Credentials.ProviderCredentials;
      const ref = (yield* credentials.enrichRun(run, failure)).credentialRecovery!.credentialRef;
      const error = yield* credentials
        .replace({ credentialRef: ref, value: "synthetic-new-key" })
        .pipe(Effect.flip);
      expect(error.reason).toBe("save");
      expect(JSON.stringify(error)).not.toContain("synthetic-new-key");
      expect(h.close).not.toHaveBeenCalled();
    }).pipe(Effect.provide(h.layer));
  });
});
