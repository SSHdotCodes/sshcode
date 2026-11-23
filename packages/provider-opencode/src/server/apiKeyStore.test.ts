import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { openCodeApiKeyStoreId } from "./apiKeyStore.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-key-store-" });
  const data = path.join(root, "data");
  yield* fs.makeDirectory(path.join(data, "opencode"), { recursive: true });
  const first = path.join(root, "opencode");
  const second = path.join(root, "studio-opencode");
  // Executable headers only; these fixtures are never executed.
  for (const binary of [first, second]) {
    yield* fs.writeFile(binary, new Uint8Array([0x7f, 0x45, 0x4c, 0x46]));
    yield* fs.chmod(binary, 0o755);
  }
  const input = {
    instanceId: "opencode",
    runtime: { generation: "v2" as const, version: "2.2.5" },
    binaryPath: first,
    serverUrl: "",
    directory: root,
    environment: { HOME: path.join(root, "home"), XDG_DATA_HOME: data, PATH: "" },
  };
  return { fs, path, root, first, second, input };
});

it.layer(NodeServices.layer)("OpenCode API key stores", (it) => {
  it.effect(
    "groups native binaries by the effective store, including implicit Studio instances",
    () =>
      Effect.gen(function* () {
        const { input, second } = yield* fixture;
        const first = yield* openCodeApiKeyStoreId(input);
        const studio = yield* openCodeApiKeyStoreId({
          ...input,
          instanceId: "studio-opencode",
          binaryPath: second,
          runtime: { generation: "v2", version: "2.0.28" },
          environment: { ...input.environment, OPENCODE_CONFIG: "/synthetic/studio.json" },
        });
        assert.equal(first, studio);
        const otherHome = yield* openCodeApiKeyStoreId({
          ...input,
          environment: { ...input.environment, HOME: "/another/home" },
        });
        assert.equal(first, otherHome, "explicit data home determines the credential store");
        const otherData = yield* openCodeApiKeyStoreId({
          ...input,
          environment: { ...input.environment, XDG_DATA_HOME: "/another/data" },
        });
        assert.notEqual(first, otherData);
      }).pipe(Effect.scoped),
  );

  it.effect("separates v1, custom channel databases and explicit database overrides", () =>
    Effect.gen(function* () {
      const { input, path } = yield* fixture;
      const standard = yield* openCodeApiKeyStoreId(input);
      const v1 = yield* openCodeApiKeyStoreId({
        ...input,
        runtime: { generation: "v1", version: "1.18.32" },
      });
      const custom = { generation: "v2" as const, version: "2.0.28-localai.1", channel: "localai" };
      const channel = yield* openCodeApiKeyStoreId({ ...input, runtime: custom });
      assert.notEqual(standard, v1);
      assert.notEqual(standard, channel);
      assert.equal(
        standard,
        yield* openCodeApiKeyStoreId({
          ...input,
          runtime: custom,
          environment: { ...input.environment, OPENCODE_DISABLE_CHANNEL_DB: "1" },
        }),
      );
      assert.equal(
        standard,
        yield* openCodeApiKeyStoreId({
          ...input,
          runtime: custom,
          environment: {
            ...input.environment,
            OPENCODE_DB: path.join(input.environment.XDG_DATA_HOME, "opencode", "opencode.db"),
          },
        }),
      );
      assert.notEqual(
        standard,
        yield* openCodeApiKeyStoreId({
          ...input,
          environment: { ...input.environment, OPENCODE_DB: "private.db" },
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("canonicalizes data directory aliases without reading credentials", () =>
    Effect.gen(function* () {
      const { input, fs, path, root } = yield* fixture;
      const alias = path.join(root, "data-alias");
      yield* fs.symlink(input.environment.XDG_DATA_HOME, alias);
      assert.equal(
        yield* openCodeApiKeyStoreId(input),
        yield* openCodeApiKeyStoreId({
          ...input,
          environment: { ...input.environment, XDG_DATA_HOME: alias },
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps wrappers separate because their effective environment is unknown", () =>
    Effect.gen(function* () {
      const { input, fs, path, root } = yield* fixture;
      const binaryPath = path.join(root, "wrapper");
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\nHOME=/other exec opencode\n");
      yield* fs.chmod(binaryPath, 0o755);
      const one = yield* openCodeApiKeyStoreId({ ...input, binaryPath });
      const two = yield* openCodeApiKeyStoreId({ ...input, binaryPath, instanceId: "second" });
      assert.notEqual(one, two);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "identifies remote endpoints independently of local homes without exposing URL secrets",
    () =>
      Effect.gen(function* () {
        const { input } = yield* fixture;
        const one = yield* openCodeApiKeyStoreId({
          ...input,
          serverUrl: "https://user:synthetic-password@opencode.test/base/?token=synthetic-token",
        });
        const same = yield* openCodeApiKeyStoreId({
          ...input,
          instanceId: "studio-opencode",
          binaryPath: "/another/bin",
          environment: { HOME: "/another/home" },
          serverUrl: "https://opencode.test/base?token=synthetic-token#ignored",
        });
        assert.equal(one, same);
        assert.notInclude(one, "synthetic-password");
        assert.notInclude(one, "synthetic-token");
        assert.notEqual(
          one,
          yield* openCodeApiKeyStoreId({
            ...input,
            serverUrl: "https://opencode.test/another",
          }),
        );
        assert.notEqual(
          one,
          yield* openCodeApiKeyStoreId({
            ...input,
            serverUrl: "https://opencode.test/base?token=another-route",
          }),
        );
      }).pipe(Effect.scoped),
  );

  it.effect("rejects process-local databases and v1 inline auth overrides", () =>
    Effect.gen(function* () {
      const { input } = yield* fixture;
      const memory = yield* openCodeApiKeyStoreId({
        ...input,
        environment: { ...input.environment, OPENCODE_DB: ":memory:" },
      }).pipe(Effect.flip);
      const inline = yield* openCodeApiKeyStoreId({
        ...input,
        runtime: { generation: "v1", version: "1.18.32" },
        environment: { ...input.environment, OPENCODE_AUTH_CONTENT: "synthetic-inline-auth" },
      }).pipe(Effect.flip);
      assert.equal(memory.operation, "apiKeyStoreId");
      assert.equal(inline.operation, "apiKeyStoreId");
    }).pipe(Effect.scoped),
  );
});
