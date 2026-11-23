import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ServerConfig from "../config.ts";
import * as HarnessDefaultsService from "../harnessDefaults/HarnessDefaultsService.ts";
import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { nativeHarnessModelSelection } from "@t3tools/shared/projectSettings";
import { applyNativeModelDefaults } from "./nativeModelDefaults.ts";
import { applyHarnessDefaults } from "./harnessDefaults.ts";

const id = ProviderInstanceId.make("codex");
const catalog: ServerProvider["models"] = ["catalog", "native", "app"].map((slug) => ({
  slug,
  name: slug,
  isCustom: false,
  ...(slug === "catalog" ? { isDefault: true } : {}),
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Effort",
        type: "select",
        currentValue: "low",
        options: ["low", "high", "xhigh"].map((id) => ({
          id,
          label: id,
          ...(id === "low" ? { isDefault: true } : {}),
        })),
      },
    ],
  },
}));
const provider: ServerProvider = {
  instanceId: id,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-15T00:00:00Z",
  slashCommands: [],
  skills: [],
  models: applyNativeModelDefaults(catalog, {
    model: "native",
    options: { reasoningEffort: "high" },
  }),
};

describe("harness defaults projection", () => {
  it("applies app > native > catalog and restores native defaults on reset without changing the cache", () => {
    const [applied] = applyHarnessDefaults([provider], {
      defaultHarness: id,
      harnesses: { [id]: { model: "app", options: { reasoningEffort: "xhigh" } } },
    });
    expect(applied?.nativeModelDefaults).toEqual({
      model: "native",
      options: { reasoningEffort: "high" },
    });
    expect(nativeHarnessModelSelection([applied!], null)).toEqual({
      instanceId: id,
      model: "app",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    });
    expect(provider.models.find((model) => model.isDefault)?.slug).toBe("native");
    const [reset] = applyHarnessDefaults([provider], { harnesses: {} });
    expect(nativeHarnessModelSelection([reset!], { instanceId: id, model: "app" })).toEqual({
      instanceId: id,
      model: "native",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    const [fallback] = applyHarnessDefaults([{ ...provider, models: catalog }], { harnesses: {} });
    expect(fallback?.models.find((model) => model.isDefault)?.slug).toBe("catalog");
  });
  it("ignores unknown models, unknown options, and unsupported choices", () => {
    const [snapshot] = applyHarnessDefaults([provider], {
      harnesses: {
        [id]: { model: "gone", options: { reasoningEffort: "unlimited", unknown: "high" } },
      },
    });
    expect(snapshot?.models.find((model) => model.isDefault)?.slug).toBe("native");
    expect(snapshot?.models[0]?.capabilities?.optionDescriptors?.[0]).toMatchObject({
      currentValue: "high",
      nativeValue: "high",
    });
  });
});

it.effect(
  "republishes cached provider defaults immediately without probing and shares the RPC service instance",
  () =>
    Effect.gen(function* () {
      const refreshes = yield* Ref.make(0);
      const source: ProviderInstance = {
        instanceId: id,
        driverKind: provider.driver,
        enabled: true,
        displayName: undefined,
        continuationIdentity: { driverKind: provider.driver, continuationKey: "test:codex" },
        snapshot: {
          getSnapshot: Effect.succeed(provider),
          refresh: Ref.update(refreshes, (count) => count + 1).pipe(Effect.as(provider)),
          streamChanges: Stream.never,
          applyUsageLimits: () => Effect.void,
          resolveMaintenance: () =>
            Effect.succeed(
              makeManualOnlyProviderMaintenanceCapabilities({
                provider: provider.driver,
                packageName: null,
              }),
            ),
        },
        orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
        textGeneration: {} as ProviderInstance["textGeneration"],
      };
      const instanceRegistry = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: () => Effect.succeed(source),
        listInstances: Effect.succeed([source]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.never,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
      });
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        const defaults = yield* HarnessDefaultsService.HarnessDefaultsService;
        expect(
          (yield* registry.getProviders)[0]?.models.find((model) => model.isDefault)?.slug,
        ).toBe("native");
        const updates = yield* registry.streamChanges.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.forkChild,
        );
        yield* Effect.yieldNow;
        yield* defaults.update({
          defaultHarness: id,
          harnesses: { [id]: { model: "app", options: { reasoningEffort: "xhigh" } } },
        });
        const snapshots = yield* Fiber.join(updates);
        expect(snapshots[0]?.[0]?.models.find((model) => model.isDefault)?.slug).toBe("app");
        expect((yield* registry.getProviders)[0]?.isHarnessDefault).toBe(true);
        expect(yield* Ref.get(refreshes)).toBe(0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(ProviderRegistry.layer, HarnessDefaultsService.layer).pipe(
            Layer.provide(instanceRegistry),
            Layer.provide(ModelManifest.layerTest),
            Layer.provide(
              ServerConfig.layerTest(process.cwd(), { prefix: "harness-snapshot-test-" }),
            ),
            Layer.provide(NodeServices.layer),
          ),
        ),
      );
    }).pipe(Effect.scoped),
);
