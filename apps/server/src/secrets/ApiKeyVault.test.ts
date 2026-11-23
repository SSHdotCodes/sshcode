import { assert, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Redacted from "effect/Redacted";
import * as ServerConfig from "../config.ts";

const fake = vi.hoisted(() => ({
  value: "obviously-fake-native-key",
  services: [] as string[],
  missing: false,
}));
vi.mock("@napi-rs/keyring", () => ({
  AsyncEntry: class {
    constructor(service: string) {
      fake.services.push(service);
    }
    async getPassword() {
      if (fake.missing) return null;
      throw new Error(fake.value);
    }
    async setPassword() {
      throw new Error(fake.value);
    }
    async deleteCredential() {
      throw new Error(fake.value);
    }
  },
}));
import * as ApiKeyVault from "./ApiKeyVault.ts";

const layerVault = ApiKeyVault.layer.pipe(
  Layer.provide(ServerConfig.layerTest("/tmp", { prefix: "sshcode-vault-unit-" })),
  Layer.provide(NodeServices.layer),
);

it.effect("native vault failures cannot echo credentials in errors, causes, or traces", () =>
  Effect.gen(function* () {
    const vault = yield* ApiKeyVault.ApiKeyVault;
    const failures = yield* Effect.all([
      vault.get("fake-id").pipe(Effect.flip),
      vault.set("fake-id", Redacted.make(fake.value)).pipe(Effect.flip),
      vault.remove("fake-id").pipe(Effect.flip),
    ]);
    for (const failure of failures) {
      assert.equal(failure.reason, "storage");
      assert.isFalse(String(failure).includes(fake.value));
      assert.isFalse(JSON.stringify(failure).includes(fake.value));
      assert.isFalse("cause" in failure);
    }
    assert.isTrue(
      fake.services.every((service) => /^codes\.ssh\.api-keys\.[0-9a-f]{64}$/.test(service)),
    );
  }).pipe(Effect.provide(layerVault), Effect.scoped),
);

it.effect("normalizes the native macOS null for a missing credential", () =>
  Effect.gen(function* () {
    fake.missing = true;
    try {
      assert.isUndefined(yield* (yield* ApiKeyVault.ApiKeyVault).get("missing-fake-id"));
    } finally {
      fake.missing = false;
    }
  }).pipe(Effect.provide(layerVault), Effect.scoped),
);
