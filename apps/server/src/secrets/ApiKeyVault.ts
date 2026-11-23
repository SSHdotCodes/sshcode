import { AsyncEntry } from "@napi-rs/keyring";
import { ApiKeyError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Namespaces Keychain accounts by isolated server state directory.
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../config.ts";

/** Credential values only cross this boundary in redacted wrappers. No file fallback. */
export class ApiKeyVault extends Context.Service<
  ApiKeyVault,
  {
    readonly get: (id: string) => Effect.Effect<Redacted.Redacted<string> | undefined, ApiKeyError>;
    readonly set: (
      id: string,
      value: Redacted.Redacted<string>,
    ) => Effect.Effect<void, ApiKeyError>;
    readonly remove: (id: string) => Effect.Effect<void, ApiKeyError>;
  }
>()("t3/secrets/ApiKeyVault") {}

export const layer = Layer.effect(
  ApiKeyVault,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const service = `codes.ssh.api-keys.${NodeCrypto.createHash("sha256").update(config.stateDir).digest("hex")}`;
    // Native failures can contain library inputs. Keep causes out of logs and traces.
    const access = <A>(operation: () => Promise<A>) =>
      Effect.tryPromise({
        try: operation,
        catch: () => new ApiKeyError({ reason: "storage" }),
      });
    return ApiKeyVault.of({
      get: (id) =>
        access(async () => {
          const value = await new AsyncEntry(service, id).getPassword();
          return value === undefined || value === null ? undefined : Redacted.make(value);
        }),
      set: (id, value) =>
        access(() => new AsyncEntry(service, id).setPassword(Redacted.value(value))),
      remove: (id) =>
        access(async () => {
          await new AsyncEntry(service, id).deleteCredential();
        }),
    });
  }),
);

/** External vault boundary for tests; no OS credential store is touched. */
export const layerMemory = Layer.sync(ApiKeyVault, () => {
  const values = new Map<string, Redacted.Redacted<string>>();
  return ApiKeyVault.of({
    get: (id) => Effect.sync(() => values.get(id)),
    set: (id, value) =>
      Effect.sync(() => {
        values.set(id, value);
      }),
    remove: (id) =>
      Effect.sync(() => {
        values.delete(id);
      }),
  });
});
