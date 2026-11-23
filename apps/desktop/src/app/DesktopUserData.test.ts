import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";

import { clearStaleGpuCaches, resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["darwin", "win32", "linux"] as const)(
  "keeps the shareable app's own profile on %s and copies nothing from SSHCode or T3 Code",
  (platform) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "sshcode-shared-profile-" });
      // Profiles of the personal SSHCode and T3 Code, with the credential keys an older
      // build would have copied on Windows.
      for (const name of ["t3code-fork", "T3Code Fork", "t3code"]) {
        yield* fs.makeDirectory(path.join(directory, name), { recursive: true });
        yield* fs.writeFileString(path.join(directory, name, "Local State"), "{}");
      }
      const userData = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
        platform,
      });
      assert.equal(userData, path.join(directory, "sshcode-shared"));
      assert.isFalse(yield* fs.exists(userData));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const gpuCacheDirectories = [
  "GPUCache",
  "GrShaderCache",
  "ShaderCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GPUPersistentCache",
];

it.effect.each([undefined, "44.9.2"])(
  "clears old GPU caches with marker %s but preserves profile data",
  (marker) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const userDataPath = yield* fs.makeTempDirectoryScoped({ prefix: "sshcode-gpu-cache-" });
      for (const name of [
        ...gpuCacheDirectories,
        "Local Storage",
        "Session Storage",
        "IndexedDB",
      ]) {
        yield* fs.makeDirectory(path.join(userDataPath, name));
        yield* fs.writeFileString(path.join(userDataPath, name, "data"), "keep profile data");
      }
      yield* fs.writeFileString(path.join(userDataPath, "Local State"), "credentials");
      const markerPath = path.join(userDataPath, "gpu-cache-electron-version");
      if (marker) yield* fs.writeFileString(markerPath, marker);
      yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.9.3" });
      for (const name of gpuCacheDirectories)
        assert.isFalse(yield* fs.exists(path.join(userDataPath, name)));
      for (const name of ["Local Storage", "Session Storage", "IndexedDB"]) {
        assert.equal(
          yield* fs.readFileString(path.join(userDataPath, name, "data")),
          "keep profile data",
        );
      }
      assert.equal(yield* fs.readFileString(path.join(userDataPath, "Local State")), "credentials");
      assert.equal(yield* fs.readFileString(markerPath), "44.9.3");
      yield* fs.makeDirectory(path.join(userDataPath, "GPUCache"));
      yield* fs.writeFileString(path.join(userDataPath, "GPUCache", "data"), "new shaders");
      yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.9.3" });
      assert.equal(
        yield* fs.readFileString(path.join(userDataPath, "GPUCache", "data")),
        "new shaders",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("records the GPU version on a fresh install before caches are created", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "sshcode-fresh-gpu-" });
    const userDataPath = path.join(root, "profile");
    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.9.3" });
    yield* fs.makeDirectory(path.join(userDataPath, "GPUCache"));
    yield* fs.writeFileString(path.join(userDataPath, "GPUCache", "data"), "fresh shaders");
    yield* clearStaleGpuCaches({ userDataPath, electronVersion: "44.9.3" });
    assert.equal(
      yield* fs.readFileString(path.join(userDataPath, "GPUCache", "data")),
      "fresh shaders",
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("retries failed GPU cleanup without marking it complete or failing startup", () => {
  let attempts = 0;
  const writes: string[] = [];
  const fs = FileSystem.makeNoop({
    readFileString: () => Effect.succeed("44.9.2"),
    remove: (path) => {
      attempts++;
      return Effect.fail(
        PlatformError.systemError({
          _tag: "PermissionDenied",
          module: "FileSystem",
          method: "remove",
          pathOrDescriptor: path,
        }),
      );
    },
    writeFileString: (path) =>
      Effect.sync(() => {
        writes.push(path);
      }),
  });
  return Effect.gen(function* () {
    yield* clearStaleGpuCaches({ userDataPath: "/profile", electronVersion: "44.9.3" });
    yield* clearStaleGpuCaches({ userDataPath: "/profile", electronVersion: "44.9.3" });
    assert.equal(attempts, 2);
    assert.deepEqual(writes, []);
  }).pipe(Effect.provideService(FileSystem.FileSystem, fs), Effect.provide(NodeServices.layer));
});
