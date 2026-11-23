import { expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

it.effect("a credential config patch preserves machine-provided instances", () =>
  Effect.gen(function* () {
    const driver = ProviderDriverKind.make("unavailable-test-driver");
    const id = ProviderInstanceId.make("configured");
    const machine = ProviderInstanceId.make("machine-provided");
    const { registry, mutator } = yield* makeProviderInstanceRegistry<never>({
      drivers: [],
      configMap: {
        [id]: { driver, displayName: "Before" },
        [machine]: { driver, displayName: "Machine provider" },
      },
    });
    yield* mutator.patch({ [id]: { driver, displayName: "After" } });
    const providers = yield* registry.listUnavailable;
    expect(providers.map((provider) => provider.instanceId)).toEqual([id, machine]);
    expect(providers.map((provider) => provider.displayName)).toEqual([
      "After",
      "Machine provider",
    ]);
  }).pipe(Effect.scoped),
);
