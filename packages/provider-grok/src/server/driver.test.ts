import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import { GrokDriver } from "./driver.ts";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Grok must not make an HTTP request")),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Grok must not spawn a process"),
);

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.layer(layerTest)("GrokDriver", (it) => {
  // `grok update` installs into `$GROK_HOME/bin`, so an instance GROK_HOME that does not own
  // binaryPath would update a different copy and leave the verified binary outdated.
  // `target` is where `bin/grok` links; null is a copied binary, as the Windows installer leaves.
  const scriptInstallCases = [
    { target: "grok-1.0.77", downloads: false, owner: ".grok" },
    { target: "../downloads/grok-darwin-arm64", downloads: true, owner: ".grok" },
    { target: "../downloads/grok-1.0.88-darwin-arm64", downloads: true, owner: ".grok" },
    { target: null, downloads: true, owner: ".grok" },
    { target: null, downloads: false, owner: ".grok-hub" },
  ] as const;
  for (const { target, downloads, owner } of scriptInstallCases) {
    it.effect.skipIf(windowsHost)(
      `runs grok update with GROK_HOME=${owner} for bin/grok -> ${target ?? "copy"}${downloads ? " beside downloads" : ""}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const home = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-home-" }),
          );
          const scriptHome = path.join(home, ".grok");
          const binaryPath = path.join(scriptHome, "bin", "grok");
          const targetPath = path.resolve(path.dirname(binaryPath), target ?? "grok");
          yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
          if (downloads) {
            yield* fs.makeDirectory(path.join(scriptHome, "downloads"), { recursive: true });
          }
          yield* fs.writeFileString(targetPath, "#!/bin/sh\n");
          yield* fs.chmod(targetPath, 0o755);
          if (target) yield* fs.symlink(target, binaryPath);

          const instance = yield* GrokDriver.create({
            instanceId: ProviderInstanceId.make("grok-separate-home"),
            displayName: "Grok test",
            enabled: false,
            environment: [
              { name: "GROK_HOME", value: path.join(home, ".grok-hub"), sensitive: false },
            ],
            config: {
              ...GrokDriver.defaultConfig(),
              binaryPath,
              homePath: path.join(home, ".grok-hub"),
            },
          });
          const { update } = yield* instance.snapshot.resolveMaintenance();

          expect(update).toEqual(
            expect.objectContaining({
              executable: binaryPath,
              args: ["update"],
              env: expect.objectContaining({ GROK_HOME: path.join(home, owner) }),
            }),
          );
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner)),
    );
  }

  it.effect.skipIf(windowsHost)(
    "resolves native updates independently for two configured accounts",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const accounts = yield* Effect.forEach(["first", "second"], (id) =>
          Effect.gen(function* () {
            const homePath = path.join(root, id);
            const binaryPath = path.join(homePath, "bin", "grok");
            const realBinary = path.join(homePath, "downloads", "grok-darwin-arm64");
            yield* fs.makeDirectory(path.dirname(realBinary), { recursive: true });
            yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
            yield* fs.writeFileString(realBinary, "#!/bin/sh\n");
            yield* fs.chmod(realBinary, 0o755);
            yield* fs.symlink(realBinary, binaryPath);
            const instance = yield* GrokDriver.create({
              instanceId: ProviderInstanceId.make(id),
              displayName: id,
              enabled: false,
              environment: [{ name: "npm_config_user_agent", value: "npm/11", sensitive: false }],
              config: { ...GrokDriver.defaultConfig(), binaryPath, homePath },
            });
            return { instance, binaryPath, homePath };
          }),
        );
        for (const { instance, binaryPath, homePath } of accounts) {
          const { update } = yield* instance.snapshot.resolveMaintenance();
          expect(update?.executable).toBe(binaryPath);
          expect(update?.env?.GROK_HOME).toBe(homePath);
          expect(update?.env).toHaveProperty("npm_config_user_agent", undefined);
        }
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner)),
  );

  it.effect.skipIf(windowsHost)("keeps a script install off the npm updater under npx", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-" }));
      const downloaded = path.join(home, ".grok", "downloads", "grok-darwin-arm64");
      const binaryPath = path.join(home, ".grok", "bin", "grok");
      yield* fs.makeDirectory(path.dirname(downloaded), { recursive: true });
      yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(downloaded, "#!/bin/sh\n");
      yield* fs.chmod(downloaded, 0o755);
      yield* fs.symlink(downloaded, binaryPath);

      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-script"),
        displayName: "Grok test",
        enabled: false,
        environment: [
          {
            name: "npm_config_user_agent",
            value: "npm/11.6.2 node/v24.11.0 linux x64 workspaces/false",
            sensitive: false,
          },
        ],
        config: { ...GrokDriver.defaultConfig(), binaryPath, homePath: path.join(home, ".grok") },
      });
      const updateEnv = (yield* instance.snapshot.resolveMaintenance()).update?.env ?? {};
      expect(updateEnv.GROK_HOME).toBe(path.join(home, ".grok"));
      // The maintenance runner spawns with extendEnv, layering this over the server's process.env.
      const env: NodeJS.ProcessEnv = {
        npm_config_user_agent: "npm/11.6.2 node/v24.11.0",
        ...updateEnv,
      };
      expect(env.GROK_INSTALLER === "internal" || env.npm_config_user_agent === undefined).toBe(
        true,
      );
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner)),
  );

  it.effect.skipIf(windowsHost)("updates through the configured executable's own updater", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-driver-" });
      const grokHome = path.join(tempDir, "Grok Home");
      const binaryPath = path.join(grokHome, "bin", "grok");
      yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
      yield* fs.chmod(binaryPath, 0o755);

      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-update"),
        displayName: "Grok test",
        enabled: false,
        environment: [
          { name: "GROK_HOME", value: path.join(tempDir, "ignored"), sensitive: false },
        ],
        config: { ...GrokDriver.defaultConfig(), binaryPath, homePath: grokHome },
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.packageName).toBe("@xai-official/grok");
      expect(capabilities.update).toMatchObject({
        command: `'${binaryPath}' update`,
        executable: binaryPath,
        args: ["update"],
      });
      // `grok update` installs under GROK_HOME, so it must target this instance's home.
      expect(capabilities.update?.env?.GROK_HOME).toBe(grokHome);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  it.effect.skipIf(windowsHost)(
    "keeps an npm-global Grok update in the owning prefix and instance environment",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-npm-update-" });
        const prefix = yield* fs.realPath(root);
        const binary = path.join(prefix, "lib", "node_modules", "@xai-official", "grok", "cli.js");
        yield* fs.makeDirectory(path.dirname(binary), { recursive: true });
        yield* fs.writeFileString(binary, "#!/bin/sh\nexit 99\n");
        yield* fs.chmod(binary, 0o755);
        const instance = yield* GrokDriver.create({
          instanceId: ProviderInstanceId.make("grok-npm"),
          displayName: "Grok npm",
          enabled: false,
          environment: [{ name: "GROK_HOME", value: `${prefix}/profile`, sensitive: false }],
          config: { ...GrokDriver.defaultConfig(), binaryPath: binary },
        });
        const maintenance = yield* instance.snapshot.resolveMaintenance();
        expect(maintenance.update?.args).toEqual([
          "install",
          "-g",
          "--prefix",
          prefix,
          "--allow-scripts=@xai-official/grok",
          "@xai-official/grok@latest",
        ]);
        expect(maintenance.update?.env?.GROK_HOME).toBe(`${prefix}/profile`);
      }).pipe(
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      ),
  );

  it.effect("links before choosing continuation identity and applies homePath to maintenance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-driver-linked-" });
      const main = path.join(root, "main");
      const second = path.join(root, "second");
      yield* fs.makeDirectory(path.join(main, "sessions"), { recursive: true });
      const own = ProviderInstanceId.make("grok_grok_build");
      const added = ProviderInstanceId.make("grok_second");
      const environment = [{ name: "GROK_HOME", value: main, sensitive: false }];
      yield* (yield* TestProviderHost.TestProviderHostSettings).set({
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [own]: { driver: GrokDriver.driverKind, environment },
          [added]: {
            driver: GrokDriver.driverKind,
            environment,
            config: { homePath: second, shareMainFolder: true },
          },
        },
      });
      const create = (instanceId: typeof own, homePath: string, shareMainFolder = false) =>
        GrokDriver.create({
          instanceId,
          displayName: undefined,
          enabled: false,
          environment,
          config: { ...GrokDriver.defaultConfig(), homePath, shareMainFolder },
        });
      const mainInstance = yield* create(own, "");
      const secondInstance = yield* create(added, second, true);
      expect(secondInstance.continuationIdentity).toEqual(mainInstance.continuationIdentity);
      expect(mainInstance.continuationIdentity.continuationKey).toBe(
        "grok:instance:grok_grok_build",
      );
      expect((yield* secondInstance.snapshot.getSnapshot).continuation?.groupKey).toBe(
        mainInstance.continuationIdentity.continuationKey,
      );
      expect(yield* fs.realPath(path.join(second, "sessions"))).toBe(
        yield* fs.realPath(path.join(main, "sessions")),
      );
      // Two ordinary folders configured to the same home also choose one owner,
      // in provider order, regardless of which instance is being constructed.
      yield* (yield* TestProviderHost.TestProviderHostSettings).set({
        ...DEFAULT_SERVER_SETTINGS,
        providerInstances: {
          [own]: { driver: GrokDriver.driverKind, environment },
          [added]: { driver: GrokDriver.driverKind, environment },
        },
      });
      expect((yield* create(own, "")).continuationIdentity).toEqual(
        (yield* create(added, "")).continuationIdentity,
      );
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  it.effect.skipIf(windowsHost)("uses homePath for probes, chats, text, X search and skills", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "grok-process-home-" });
      const homePath = path.join(root, "configured");
      const log = path.join(root, "environment.log");
      const binaryPath = path.join(root, "grok");
      // A real child process records the home it received; it cannot log in or call Grok.
      yield* fs.writeFileString(
        binaryPath,
        '#!/bin/sh\nprintf "%s|%s\\n" "$1" "$GROK_HOME" >> "$T3_GROK_ENV_LOG"\nexit 1\n',
      );
      yield* fs.chmod(binaryPath, 0o755);
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-process-test"),
        displayName: undefined,
        enabled: true,
        environment: [
          { name: "GROK_HOME", value: path.join(root, "ignored"), sensitive: false },
          { name: "T3_GROK_ENV_LOG", value: log, sensitive: false },
        ],
        config: { ...GrokDriver.defaultConfig(), binaryPath, homePath },
      });
      const assertProcessHome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        Effect.gen(function* () {
          yield* fs.writeFileString(log, "");
          yield* effect.pipe(Effect.exit);
          const lines = (yield* fs.readFileString(log)).trim().split("\n");
          expect(lines.length).toBeGreaterThan(0);
          expect(lines.every((line) => line.endsWith(`|${homePath}`))).toBe(true);
        });
      yield* assertProcessHome(instance.snapshot.refresh);
      yield* assertProcessHome(instance.snapshotForCwd!(root));
      const modelSelection = { instanceId: instance.instanceId, model: "grok-4.6" };
      yield* assertProcessHome(
        instance.textGeneration.generateThreadTitle({ cwd: root, message: "test", modelSelection }),
      );
      yield* assertProcessHome(instance.xSearch!("test"));
      const threadId = ThreadId.make("grok-home-thread");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: root,
      });
      yield* assertProcessHome(
        Effect.gen(function* () {
          const runtime = yield* instance.orchestrationAdapter.openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("grok-home-session"),
            modelSelection,
            runtimePolicy,
          });
          yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
        }),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-missing-" });
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-missing"),
        displayName: "Grok test",
        enabled: false,
        environment: [],
        config: { ...GrokDriver.defaultConfig(), binaryPath: path.join(tempDir, "grok") },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );
});
