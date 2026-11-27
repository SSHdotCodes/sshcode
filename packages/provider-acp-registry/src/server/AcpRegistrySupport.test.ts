import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AcpRegistrySearchInput,
  AcpRegistrySearchResult,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { AcpRegistrySettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";

const registryUrl = "https://registry.test/registry.json";
const archiveUrl = "https://registry.test/example-agent.bin";
const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettings);
const decodeSearchInput = Schema.decodeEffect(AcpRegistrySearchInput);
const decodeSearchResult = Schema.decodeEffect(AcpRegistrySearchResult);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function makeAgent(
  distribution: AcpRegistrySupport.AcpRegistryAgent["distribution"],
): AcpRegistrySupport.AcpRegistryAgent {
  return {
    id: "example-agent",
    name: "Example Agent",
    version: "1.2.3",
    description: "ACP Registry test agent",
    distribution,
  };
}

function makeRegistry(agent: AcpRegistrySupport.AcpRegistryAgent): string {
  return JSON.stringify({ version: "1.0.0", agents: [agent] });
}

function settings(input: Partial<AcpRegistrySettings> = {}): AcpRegistrySettings {
  return decodeAcpRegistrySettings({
    agentId: "example-agent",
    ...input,
  });
}

function layerResolver(
  execute: Parameters<typeof HttpClient.make>[0],
  environment: NodeJS.ProcessEnv = process.env,
) {
  return Layer.mergeAll(
    NodeServices.layer,
    TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
    Layer.succeed(HostProcess.Platform, "linux"),
    Layer.succeed(HostProcess.Architecture, "x64"),
    Layer.succeed(HostProcess.Environment, environment),
    Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute)),
  );
}

const makeFakeNpmToolchain = Effect.fn("AcpRegistrySupport.test.makeFakeNpmToolchain")(function* (
  rootDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const toolchainBin = path.join(rootDirectory, "fake-node", "bin");
  const globalPrefix = path.join(rootDirectory, "tools", "example-agent", "1.2.3", "npm");
  const globalBin = path.join(globalPrefix, "bin");
  const executablePath = path.join(globalBin, "example-agent");
  const npmPath = path.join(toolchainBin, "npm");
  const logPath = path.join(rootDirectory, "npm.log");
  yield* fileSystem.makeDirectory(toolchainBin, { recursive: true });
  yield* fileSystem.makeDirectory(globalPrefix, { recursive: true });
  yield* fileSystem.writeFileString(logPath, "");
  yield* fileSystem.copyFile(
    yield* path.fromFileUrl(
      new URL("./testing/AcpRegistrySupport.npm.fixture.sh", import.meta.url),
    ),
    npmPath,
  );
  yield* fileSystem.chmod(npmPath, 0o755);
  return {
    environment: {
      ...process.env,
      PATH: `${toolchainBin}:${process.env.PATH ?? ""}`,
      FAKE_NPM_LOG: logPath,
      FAKE_NPM_PREFIX: path.join(rootDirectory, "external-npm-global"),
      FAKE_NPM_MANIFEST: encodeUnknownJson({
        name: "@example/acp",
        version: "1.2.3",
        bin: { "example-agent": "dist/cli.js" },
      }),
    } satisfies NodeJS.ProcessEnv,
    executablePath,
    globalBin,
    logPath,
    npmPath,
  };
});

const makeFakeUvToolchain = Effect.fn("AcpRegistrySupport.test.makeFakeUvToolchain")(function* (
  rootDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const toolchainBin = path.join(rootDirectory, "fake-uv", "bin");
  const globalBin = path.join(rootDirectory, "tools", "example-agent", "1.2.3", "python", "bin");
  const executablePath = path.join(globalBin, "fast-agent");
  const uvPath = path.join(toolchainBin, "uv");
  const logPath = path.join(rootDirectory, "uv.log");
  yield* fileSystem.makeDirectory(toolchainBin, { recursive: true });
  yield* fileSystem.writeFileString(logPath, "");
  yield* fileSystem.copyFile(
    yield* path.fromFileUrl(new URL("./testing/AcpRegistrySupport.uv.fixture.sh", import.meta.url)),
    uvPath,
  );
  yield* fileSystem.chmod(uvPath, 0o755);
  return {
    environment: {
      ...process.env,
      PATH: `${toolchainBin}:${process.env.PATH ?? ""}`,
      FAKE_UV_LOG: logPath,
      FAKE_UV_BIN: path.join(rootDirectory, "external-uv-bin"),
      FAKE_UV_EXECUTABLE: executablePath,
    } satisfies NodeJS.ProcessEnv,
    executablePath,
    globalBin,
    logPath,
    uvPath,
  };
});

describe("AcpRegistrySupport", () => {
  it("preserves the registry failure when translating it for clients", () => {
    const cause = new Error("registry unavailable");
    const failure = new AcpRegistrySupport.AcpRegistryError({
      reason: "registry_unavailable",
      detail: "Could not load the ACP Registry.",
      cause,
    });

    expect(AcpRegistrySupport.toAcpRegistryOperationError(failure)).toMatchObject({
      reason: "registry_unavailable",
      message: "Could not load the ACP Registry.",
      cause: failure,
    });
  });

  it("maps supported Node platforms to ACP Registry target keys", () => {
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("darwin", "arm64")).toBe(
      "darwin-aarch64",
    );
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("linux", "x64")).toBe(
      "linux-x86_64",
    );
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("win32", "arm64")).toBe(
      "windows-aarch64",
    );
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("freebsd", "x64")).toBeUndefined();
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("linux", "ia32")).toBeUndefined();
  });

  it("selects the preferred compatible distribution", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "./bin/example-agent",
          args: ["acp"],
        },
      },
      npx: {
        package: "@example/acp@1.2.3",
        args: ["--stdio"],
      },
    });

    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent,
        preference: "auto",
        platformTarget: "linux-x86_64",
      }),
    ).toMatchObject({ kind: "binary", args: ["acp"] });
    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent,
        preference: "npx",
        platformTarget: "linux-x86_64",
      }),
    ).toEqual({
      kind: "npx",
      packageName: "@example/acp@1.2.3",
      args: ["--stdio"],
      env: {},
    });
    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent,
        preference: "binary",
        platformTarget: "darwin-aarch64",
      }),
    ).toBeUndefined();
    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent: makeAgent({
          binary: {
            "windows-x86_64": {
              archive: archiveUrl,
              cmd: "./bin/example-agent-x64.exe",
              args: ["acp"],
            },
          },
        }),
        preference: "auto",
        platformTarget: "windows-aarch64",
      }),
    ).toMatchObject({
      kind: "binary",
      binaryTarget: { cmd: "./bin/example-agent-x64.exe" },
    });
    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent: makeAgent({
          binary: {
            "windows-aarch64": {
              archive: archiveUrl,
              cmd: "./bin/example-agent-arm64.exe",
              args: ["acp"],
            },
            "windows-x86_64": {
              archive: archiveUrl,
              cmd: "./bin/example-agent-x64.exe",
              args: ["acp"],
            },
          },
        }),
        preference: "auto",
        platformTarget: "windows-aarch64",
      }),
    ).toMatchObject({
      kind: "binary",
      binaryTarget: { cmd: "./bin/example-agent-arm64.exe" },
    });
  });

  it.effect("resolves a local command on the selected environment without the registry", () => {
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-local-" });
      const commandPath = `${cacheDir}/dsh`;
      yield* fileSystem.writeFileString(commandPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(commandPath, 0o755);
      const hostEnvironment = { PATH: "/missing-host-bin", INHERITED: "host", OVERRIDE: "host" };
      const environment = { ...hostEnvironment, PATH: cacheDir, OVERRIDE: "provider" };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, hostEnvironment));
      const localSettings = decodeAcpRegistrySettings({
        source: "local",
        commandPath: "dsh",
        commandArgs: ["--profile", "acp", "", " spaced ", "$(touch injected); $VALUE"],
      });

      expect(yield* resolver.inspect(localSettings)).toMatchObject({ status: "missing_runner" });
      expect(yield* resolver.inspect(localSettings, environment)).toEqual({
        status: "ready",
        agentId: "dsh",
        version: null,
        distribution: "local",
      });
      const resolved = yield* resolver.resolve(localSettings, "/workspace", environment);
      expect(resolved).toEqual({
        distribution: "local",
        spawn: {
          command: commandPath,
          args: ["--profile", "acp", "", " spaced ", "$(touch injected); $VALUE"],
          cwd: "/workspace",
          env: environment,
          shell: false,
        },
      });
      expect(requests).toEqual([]);
      expect(yield* fileSystem.exists(`${cacheDir}/tools`)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests.push(request.url);
          return Effect.die("unexpected registry request for a local provider");
        }),
      ),
    );
  });

  it.effect("waits out a self-updating CLI's dangling launcher when a session starts", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-selfupdate-" });
      const versions = `${cacheDir}/versions`;
      yield* fileSystem.makeDirectory(`${versions}/1/bin`, { recursive: true });
      // The updater repointed `current` at a version that is still unpacking.
      yield* fileSystem.symlink(`${versions}/2`, `${versions}/current`);
      const launcher = `${cacheDir}/agent`;
      yield* fileSystem.symlink(`${versions}/current/bin/agent`, launcher);
      const environment = { PATH: "/missing-bin" };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, environment));
      const settings = decodeAcpRegistrySettings({ source: "local", commandPath: launcher });

      // Status checks and probes still answer at once.
      const probe = yield* resolver.resolve(settings, "/workspace", environment).pipe(Effect.flip);
      expect(probe.reason).toBe("runner_unavailable");

      // Real time for the forked fiber's file checks between virtual clock steps.
      const settle = TestClock.withLive(Effect.sleep("20 millis"));
      const starting = yield* resolver
        .resolve(settings, "/workspace", environment, { waitForSelfUpdate: true })
        .pipe(Effect.forkChild({ startImmediately: true }));
      for (let poll = 0; poll < 3; poll++) {
        yield* settle;
        yield* TestClock.adjust("2 seconds");
      }
      yield* settle;
      expect(starting.pollUnsafe()).toBeUndefined();

      yield* fileSystem.makeDirectory(`${versions}/2/bin`, { recursive: true });
      yield* fileSystem.writeFileString(`${versions}/2/bin/agent`, "#!/bin/sh\n");
      yield* fileSystem.chmod(`${versions}/2/bin/agent`, 0o755);
      for (let poll = 0; poll < 5 && starting.pollUnsafe() === undefined; poll++) {
        yield* TestClock.adjust("2 seconds");
        yield* settle;
      }
      expect((yield* Fiber.join(starting)).spawn.command).toBe(launcher);

      // A command that was never there fails at once, also at session start.
      const missing = decodeAcpRegistrySettings({
        source: "local",
        commandPath: `${cacheDir}/never-installed`,
      });
      const failed = yield* resolver
        .resolve(missing, "/workspace", environment, { waitForSelfUpdate: true })
        .pipe(Effect.flip);
      expect(failed.reason).toBe("runner_unavailable");
    }).pipe(
      Effect.scoped,
      Effect.provide(layerResolver(() => Effect.die("unexpected registry request"))),
    ),
  );

  it.effect("resolves a local executable path and inherits the host environment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-local-path-" });
      const commandPath = `${cacheDir}/dsh wrapper`;
      yield* fileSystem.writeFileString(commandPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(commandPath, 0o755);
      const environment = { PATH: "/unused", INHERITED: "host" };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, environment));
      const resolved = yield* resolver.resolve(
        decodeAcpRegistrySettings({ source: "local", commandPath }),
        "/workspace",
      );

      expect(resolved.spawn).toEqual({
        command: commandPath,
        args: [],
        cwd: "/workspace",
        env: environment,
        shell: false,
      });
      expect(resolved.agent).toBeUndefined();

      for (const extension of [".cmd", ".BAT"]) {
        const windowsResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(SpawnExecutableResolution, () => `C:\\bin\\dsh${extension}`),
        );
        const localSettings = decodeAcpRegistrySettings({ source: "local", commandPath: "dsh" });
        for (const failure of [
          yield* windowsResolver.inspect(localSettings).pipe(Effect.flip),
          yield* windowsResolver.resolve(localSettings, "/workspace").pipe(Effect.flip),
        ]) {
          expect(failure).toMatchObject({
            reason: "runner_unavailable",
            detail: expect.stringContaining("node.exe"),
          });
        }
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(layerResolver(() => Effect.die("unexpected registry request"))),
    ),
  );

  it.effect("reports missing or non-executable local commands without registry fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-local-missing-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const environment = { PATH: cacheDir };
      const unconfigured = decodeAcpRegistrySettings({ source: "local" });
      expect(yield* resolver.inspect(unconfigured, environment)).toEqual({
        status: "unconfigured",
      });
      expect(
        yield* resolver.resolve(unconfigured, "/workspace", environment).pipe(Effect.flip),
      ).toMatchObject({ reason: "agent_not_configured" });

      const nonExecutable = `${cacheDir}/non-executable`;
      yield* fileSystem.writeFileString(nonExecutable, "#!/bin/sh\n");
      yield* fileSystem.chmod(nonExecutable, 0o644);
      for (const commandPath of ["dsh", `${cacheDir}/missing`, cacheDir, nonExecutable]) {
        const localSettings = decodeAcpRegistrySettings({ source: "local", commandPath });
        expect(yield* resolver.inspect(localSettings, environment)).toEqual({
          status: "missing_runner",
          version: null,
          distribution: "local",
        });
        expect(
          yield* resolver.resolve(localSettings, "/workspace", environment).pipe(Effect.flip),
        ).toMatchObject({
          reason: "runner_unavailable",
          detail: "Local ACP executable is not available on this environment's PATH.",
        });
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(layerResolver(() => Effect.die("unexpected registry request"))),
    ),
  );

  it.effect("resolves command overrides while preserving registry args and environment", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "./bin/example-agent",
          args: ["acp", "--stdio"],
          env: { REGISTRY_VALUE: "registry", OVERRIDE_ME: "registry" },
        },
      },
    });
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-override-",
      });
      const commandPath = `${cacheDir}/example-agent`;
      yield* fileSystem.writeFileString(commandPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(commandPath, 0o755);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const resolved = yield* resolver.resolve(settings({ commandPath }), "/workspace", {
        HOST_VALUE: "host",
        OVERRIDE_ME: "host",
      });

      expect(resolved.distribution).toBe("binary");
      expect(resolved.spawn).toEqual({
        command: commandPath,
        args: ["acp", "--stdio"],
        cwd: "/workspace",
        env: {
          HOST_VALUE: "host",
          OVERRIDE_ME: "registry",
          REGISTRY_VALUE: "registry",
        },
      });
      expect(requests).toEqual([registryUrl]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
          );
        }),
      ),
    );
  });

  it.effect("installs into SSHCode home a package and launches its exposed command", () => {
    const agent = makeAgent({
      npx: { package: "@example/acp@V1.2.3", args: ["--stdio"] },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-global-package-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, toolchain.environment));

      const first = yield* resolver.resolve(settings(), "/workspace", toolchain.environment);
      const second = yield* resolver.resolve(settings(), "/workspace", toolchain.environment);

      expect(first.spawn).toMatchObject({
        command: toolchain.executablePath,
        args: ["--stdio"],
        env: { PATH: expect.stringMatching(new RegExp(`^${toolchain.globalBin}:`, "u")) },
      });
      expect(second.spawn.command).toBe(toolchain.executablePath);
      const npmCommands = yield* fileSystem.readFileString(toolchain.logPath);
      expect(npmCommands.match(/^install --global /gmu)).toHaveLength(1);
      expect(npmCommands).toContain("install --global @example/acp@V1.2.3");

      // A missing npm bin link must not select an unrelated command from the user's PATH.
      const userBin = `${cacheDir}/user-bin`;
      yield* fileSystem.makeDirectory(userBin);
      yield* fileSystem.writeFileString(`${userBin}/example-agent`, "#!/bin/sh\n");
      yield* fileSystem.chmod(`${userBin}/example-agent`, 0o755);
      yield* fileSystem.remove(toolchain.executablePath);
      const userEnvironment = {
        ...toolchain.environment,
        PATH: `${userBin}:${toolchain.environment.PATH}`,
      };
      const repaired = yield* resolver.resolve(settings(), "/workspace", userEnvironment);
      expect(repaired.spawn.command).toBe(toolchain.executablePath);
      const repairCommands = yield* fileSystem.readFileString(toolchain.logPath);
      expect(repairCommands.match(/^install --global /gmu)).toHaveLength(2);

      yield* fileSystem.remove(toolchain.executablePath);
      const failedRepair = yield* resolver
        .resolve(settings(), "/workspace", { ...userEnvironment, npm_config_bin_links: "false" })
        .pipe(Effect.flip);
      expect(failedRepair.reason).toBe("install_failed");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("uses its managed prefix despite a system-owned npm prefix", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-user-global-package-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const systemPrefix = path.join(cacheDir, "system-global");
      yield* fileSystem.makeDirectory(systemPrefix);
      yield* fileSystem.chmod(systemPrefix, 0o555);
      const userHome = path.join(cacheDir, "home");
      const environment = {
        ...toolchain.environment,
        HOME: userHome,
        FAKE_NPM_PREFIX: systemPrefix,
      };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, environment));

      const resolved = yield* resolver.resolve(settings(), "/workspace", environment);
      const userGlobalBin = toolchain.globalBin;
      expect(resolved.spawn).toMatchObject({
        command: path.join(userGlobalBin, "example-agent"),
        env: { PATH: expect.stringMatching(new RegExp(`^${userGlobalBin}:`, "u")) },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("installs into its managed prefix with an npm that ignores npm_config_prefix", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-npm-shim-prefix-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const environment = { ...toolchain.environment, FAKE_NPM_IGNORE_PREFIX_ENV: "1" };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, environment));

      const resolved = yield* resolver.resolve(settings(), "/workspace", environment);

      expect(resolved.spawn.command).toBe(toolchain.executablePath);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("names the npm shim when npm cannot install into the managed prefix", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-npm-shim-no-prefix-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const environment = { ...toolchain.environment, FAKE_NPM_IGNORE_PREFIX: "1" };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, environment));

      const error = yield* resolver
        .resolve(settings(), "/workspace", environment)
        .pipe(Effect.flip);

      expect(error.message).toContain("shim");
      const npmCommands = yield* fileSystem.readFileString(toolchain.logPath);
      expect(npmCommands).not.toMatch(/^install /mu);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("gives Windows npm commands only the managed prefix spelling", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-windows-npm-prefix-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const environment = { ...toolchain.environment, NPM_CONFIG_PREFIX: "C:\\inherited-npm" };
      const realSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const npmEnvironments: Array<Record<string, unknown>> = [];
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(
        Effect.provideService(HostProcess.Environment, environment),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(SpawnExecutableResolution, (command) =>
          command === "npm" ? toolchain.npmPath : undefined,
        ),
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            if (command._tag === "StandardCommand" && command.command === toolchain.npmPath) {
              npmEnvironments.push({ ...command.options.env });
            }
            return realSpawner.spawn(command);
          }),
        ),
      );

      yield* resolver.resolve(settings(), "C:\\workspace", environment).pipe(Effect.ignore);

      expect(npmEnvironments.length).toBeGreaterThan(0);
      for (const env of npmEnvironments) {
        expect(Object.keys(env).filter((key) => key.toLowerCase() === "npm_config_prefix")).toEqual(
          ["npm_config_prefix"],
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("keeps only the end of a failed install's output in its error", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-failed-install-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const environment = { ...toolchain.environment, FAKE_NPM_INSTALL_FAILURE_LINES: "40000" };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, environment));

      const error = yield* resolver
        .resolve(settings(), "/workspace", environment)
        .pipe(Effect.flip);

      expect(error.reason).toBe("install_failed");
      expect(error.detail).toContain("exited with code 1");
      expect(error.detail).toMatch(/npm error see the complete log for details$/u);
      expect(error.detail.split("exited with code 1: ")[1]?.length).toBeLessThanOrEqual(1_000);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("installs into SSHCode home a uv tool and launches its exposed command", () => {
    const agent = makeAgent({
      uvx: { package: "fast-agent-acp==V0.10.1", args: ["--acp"] },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-global-uv-tool-",
      });
      const toolchain = yield* makeFakeUvToolchain(cacheDir);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });

      const resolved = yield* resolver.resolve(settings(), "/workspace", toolchain.environment);

      expect(resolved.spawn).toMatchObject({
        command: toolchain.executablePath,
        args: ["--acp"],
        env: { PATH: expect.stringMatching(new RegExp(`^${toolchain.globalBin}:`, "u")) },
      });
      expect(yield* fileSystem.readFileString(toolchain.logPath)).toContain(
        "tool install --force fast-agent-acp==V0.10.1",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("honors an exact Windows PATH override when launching a global package", () => {
    const agent = makeAgent({
      uvx: { package: "fast-agent-acp==0.10.1", args: ["--acp"] },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-windows-package-path-",
      });
      const toolchain = yield* makeFakeUvToolchain(cacheDir);
      const linuxResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      yield* linuxResolver.resolve(settings(), "/workspace", toolchain.environment);

      const windowsEnvironment = {
        ...toolchain.environment,
        Path: "C:\\host\\bin",
        PATH: "C:\\provider\\bin",
      };
      const windowsResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(SpawnExecutableResolution, (command) => {
          if (command === "uv") return toolchain.uvPath;
          if (command === "fast-agent") return toolchain.executablePath;
          return undefined;
        }),
      );
      const resolved = yield* windowsResolver.resolve(
        settings(),
        "C:\\workspace",
        windowsEnvironment,
      );

      expect(resolved.spawn).toMatchObject({
        env: { PATH: `${toolchain.globalBin};C:\\provider\\bin` },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("installs and reuses a registry binary in the managed cache", () => {
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "./bin/example-agent",
          args: ["acp"],
          // SHA-256 of binaryBytes.
          sha256: "97b29a636d7ddf7bf3567ae4d48c0f2a9b03943fd808b6efbf74f1dd3db131b7",
        },
      },
    });
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-install-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const first = yield* resolver.resolve(settings(), "/workspace");
      const second = yield* resolver.resolve(settings(), "/workspace");

      expect(first.spawn.command).toBe(second.spawn.command);
      expect(first.spawn.command).toContain(
        "/tools/example-agent/1.2.3/linux-x86_64/bin/example-agent",
      );
      expect(yield* fileSystem.readFileString(first.spawn.command)).toBe(
        "#!/bin/sh\necho example\n",
      );
      expect(requests).toEqual([registryUrl, archiveUrl]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests.push(request.url);
          const response =
            request.url === registryUrl
              ? new Response(makeRegistry(agent))
              : new Response(
                  new ReadableStream<Uint8Array>({
                    start(controller) {
                      controller.enqueue(binaryBytes.slice(0, 8));
                      controller.enqueue(binaryBytes.slice(8));
                      controller.close();
                    },
                  }),
                );
          return Effect.succeed(HttpClientResponse.fromWeb(request, response));
        }),
      ),
    );
  });

  it.effect(
    "prepares the registry version despite an older PATH binary and permits explicit overrides",
    () => {
      const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho managed\n");
      const agent = makeAgent({
        binary: {
          "linux-x86_64": {
            archive: archiveUrl,
            cmd: "./bin/example-agent",
            args: ["acp"],
            // SHA-256 of binaryBytes.
            sha256: "e1eb7c905b91c400af2ec858628aec22866bfda1383b93ceb73ae01d9769fb31",
          },
        },
      });
      const requests: Array<string> = [];
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-system-",
        });
        const systemBinDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-system-bin-",
        });
        const systemBinary = path.join(systemBinDir, "example-agent");
        yield* fileSystem.writeFileString(systemBinary, "#!/bin/sh\necho system\n");
        yield* fileSystem.chmod(systemBinary, 0o755);
        const environment = { PATH: systemBinDir };

        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        }).pipe(Effect.provideService(HostProcess.Environment, environment));
        yield* resolver.search({ query: "example" });
        expect(yield* resolver.inspect(settings(), environment)).toMatchObject({
          status: "unprepared",
        });

        const overridden = settings({ commandPath: systemBinary });
        expect(yield* resolver.inspect(overridden, environment)).toMatchObject({
          status: "ready",
          version: null,
        });
        const custom = yield* resolver.resolve(overridden, "/workspace", environment);
        expect(custom.spawn.command).toBe(systemBinary);
        expect(custom.spawn.args).toEqual(["acp"]);
        expect(requests).toEqual([registryUrl]);

        yield* resolver.prepare({ agentId: "example-agent" });
        const resolved = yield* resolver.resolve(settings(), "/workspace", environment);
        expect(resolved.spawn.command).not.toBe(systemBinary);
        expect(yield* fileSystem.readFileString(resolved.spawn.command)).toBe(
          "#!/bin/sh\necho managed\n",
        );
        expect(yield* fileSystem.readFileString(systemBinary)).toBe("#!/bin/sh\necho system\n");

        const inspection = yield* resolver.inspect(settings(), environment);
        expect(inspection).toMatchObject({
          status: "ready",
          distribution: "binary",
          version: "1.2.3",
        });

        expect(requests).toEqual([registryUrl, registryUrl, archiveUrl]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            requests.push(request.url);
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                request.url === registryUrl
                  ? new Response(makeRegistry(agent))
                  : new Response(binaryBytes.buffer as ArrayBuffer),
              ),
            );
          }),
        ),
      );
    },
  );

  it.effect(
    "installs a tar archive with a root entry and a listing larger than 1 MiB",
    () => {
      const downloadUrl = "https://registry.test/agent.tar.gz";
      const agent = makeAgent({
        binary: { "linux-x86_64": { archive: downloadUrl, cmd: "./agent" } },
      });
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-root-entry-",
        });
        const source = `${cacheDir}/source`;
        yield* fileSystem.makeDirectory(source);
        yield* fileSystem.writeFileString(`${source}/agent`, "#!/bin/sh\necho managed\n");
        // 5,000 long names list past the generic 1 MiB command output cap.
        const entries = `${source}/entries`;
        yield* fileSystem.makeDirectory(entries);
        yield* Effect.forEach(
          Array.from({ length: 5_000 }, (_, index) => index),
          (index) => fileSystem.writeFileString(`${entries}/${index}-${"e".repeat(240)}`, ""),
          { concurrency: 16 },
        );
        const archivePath = `${cacheDir}/agent.tar.gz`;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const tar = yield* spawner.spawn(
          ChildProcess.make("tar", ["-czf", archivePath, "-C", source, "."]),
        );
        expect(yield* tar.exitCode).toBe(0);
        const archive = yield* fileSystem.readFile(archivePath);
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  request.url === registryUrl
                    ? new Response(makeRegistry(agent))
                    : new Response(archive),
                ),
              ),
            ),
          ),
        );
        yield* resolver.prepare({ agentId: agent.id });
        const resolved = yield* resolver.resolve(settings(), "/workspace", {});
        expect(resolved.spawn.command).toBe(
          yield* fileSystem.realPath(`${cacheDir}/tools/example-agent/1.2.3/linux-x86_64/agent`),
        );
        expect(yield* fileSystem.readFileString(resolved.spawn.command)).toBe(
          "#!/bin/sh\necho managed\n",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
      );
    },
    60_000,
  );

  it.effect("prepares an x64 ZIP fallback on Windows ARM when PATH tar cannot read ZIP", () => {
    const downloadUrl = "https://registry.test/agent-windows-x64.zip";
    const agent = makeAgent({
      binary: { "windows-x86_64": { archive: downloadUrl, cmd: "./agent.exe" } },
      npx: { package: "@example/acp@1.2.3" },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-arm-zip-" });
      const commands: Array<string> = [];
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
          commands.push(command.command);
          // Simulate Git's GNU tar rejecting ZIP and System32 bsdtar listing/extracting it.
          const supportsZip = command.command === "C:\\Windows\\System32\\tar.exe";
          if (supportsZip && command.args[0] === "-xf") {
            const outputDirectory = command.args[3];
            if (!outputDirectory) return yield* Effect.die("Missing extraction directory");
            yield* fileSystem.writeFileString(path.join(outputDirectory, "agent.exe"), "fixture");
          }
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(supportsZip ? 0 : 1)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(supportsZip ? "agent.exe\r\n" : "")),
            stderr: Stream.make(
              new TextEncoder().encode(supportsZip ? "" : "GNU tar cannot read ZIP"),
            ),
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }).pipe(Effect.orDie),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: path.join(cacheDir, "tools"),
        registryUrl,
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Architecture, "arm64"),
        Effect.provideService(HostProcess.Environment, {
          SystemRoot: "C:\\Windows",
          PATH: "C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32",
        }),
        Effect.provideService(SpawnExecutableResolution, (command) =>
          command === "tar" ? "C:\\Program Files\\Git\\usr\\bin\\tar.exe" : command,
        ),
      );
      yield* resolver.prepare({ agentId: agent.id });
      const resolved = yield* resolver.resolve(settings(), "/workspace", {});
      expect(resolved.spawn.command).toBe(
        yield* fileSystem.realPath(
          path.join(cacheDir, "tools", agent.id, agent.version, "windows-x86_64", "agent.exe"),
        ),
      );
      expect(yield* fileSystem.readFileString(resolved.spawn.command)).toBe("fixture");
      expect(commands).toEqual([
        "C:\\Windows\\System32\\tar.exe",
        "C:\\Windows\\System32\\tar.exe",
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url === registryUrl
                ? new Response(makeRegistry(agent))
                : new Response("ZIP fixture"),
            ),
          ),
        ),
      ),
    );
  });

  it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "leaves the mode of a file outside the install root when the command links to it",
    () => {
      const downloadUrl = "https://registry.test/agent.tar.gz";
      const agent = makeAgent({
        binary: { "linux-x86_64": { archive: downloadUrl, cmd: "./agent" } },
      });
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-outside-link-",
        });
        const outsideFile = `${cacheDir}/outside`;
        yield* fileSystem.writeFileString(outsideFile, "private\n");
        yield* fileSystem.chmod(outsideFile, 0o600);
        const source = `${cacheDir}/source`;
        yield* fileSystem.makeDirectory(source);
        yield* fileSystem.symlink(outsideFile, `${source}/agent`);
        const archivePath = `${cacheDir}/agent.tar.gz`;
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const tar = yield* spawner.spawn(
          ChildProcess.make("tar", ["-czf", archivePath, "-C", source, "agent"]),
        );
        expect(yield* tar.exitCode).toBe(0);
        const archive = yield* fileSystem.readFile(archivePath);
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        }).pipe(
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  request.url === registryUrl
                    ? new Response(makeRegistry(agent))
                    : new Response(archive),
                ),
              ),
            ),
          ),
        );

        const error = yield* resolver.prepare({ agentId: agent.id }).pipe(Effect.flip);

        expect(error.reason).toBe("archive_invalid");
        expect((yield* fileSystem.stat(outsideFile)).mode & 0o777).toBe(0o600);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            NodeServices.layer,
            TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
      );
    },
  );

  it.effect("searches compatible agents with deterministic ranking and bounded metadata", () => {
    const exact = {
      ...makeAgent({ npx: { package: "@example/acp@1.2.3" } }),
      id: "codex-acp",
      name: "Codex",
      authors: ["OpenAI", "Zed Industries"],
      license: "Apache-2.0",
      website: "https://example.test/codex",
      repository: "https://example.test/codex/source",
      icon: "https://example.test/codex.svg",
    } satisfies AcpRegistrySupport.AcpRegistryAgent;
    const descriptionMatch = {
      ...makeAgent({ npx: { package: "other-agent@1.2.3" } }),
      id: "other-agent",
      name: "Other Agent",
      description: "An adapter for Codex workflows",
    } satisfies AcpRegistrySupport.AcpRegistryAgent;
    const incompatible = {
      ...makeAgent({
        binary: {
          "darwin-aarch64": { archive: archiveUrl, cmd: "agent" },
        },
      }),
      id: "darwin-only",
      name: "Codex Darwin",
    } satisfies AcpRegistrySupport.AcpRegistryAgent;

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-search-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, toolchain.environment));
      const result = yield* resolver.search({ query: "codex" });

      expect(result.agents.map((agent) => agent.id)).toEqual(["codex-acp", "other-agent"]);
      expect(result.agents[0]).toMatchObject({
        authors: ["OpenAI", "Zed Industries"],
        distribution: "npx",
        integrity: "registry",
        license: "Apache-2.0",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  version: "1.0.0",
                  agents: [descriptionMatch, incompatible, exact],
                }),
              ),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("searches reuse an index fetched in the last five minutes", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    let requests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-refresh-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      yield* Effect.all(
        [resolver.search({ query: "example" }), resolver.search({ query: "example" })],
        { concurrency: "unbounded" },
      );
      expect(requests).toBe(1);

      yield* TestClock.adjust("4 minutes");
      yield* resolver.search({ query: "other" });
      expect(requests).toBe(1);

      yield* TestClock.adjust("1 minute");
      yield* resolver.search({ query: "example" });
      expect(requests).toBe(2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.yieldNow.pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
          );
        }),
      ),
    );
  });

  it.effect("searches retry the network after falling back to the cached index", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    let requests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-retry-",
      });
      yield* fileSystem.makeDirectory(`${cacheDir}/acp-registry`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${cacheDir}/acp-registry/registry.json`,
        makeRegistry(agent),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const offline = yield* resolver.search({ query: "example" });
      expect(offline.agents.map((result) => result.id)).toEqual([agent.id]);
      expect(requests).toBe(1);

      yield* resolver.search({ query: "example" });
      expect(requests).toBe(2);
      yield* resolver.search({ query: "example" });
      expect(requests).toBe(2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              requests === 1
                ? new Response("unavailable", { status: 503 })
                : new Response(makeRegistry(agent)),
            ),
          );
        }),
      ),
    );
  });

  it.effect("searches retry the network after a refresh falls back within the reuse window", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    let requests = 0;
    let online = true;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-refresh-fallback-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      yield* resolver.search({ query: "example" });
      expect(requests).toBe(1);

      // Prepare always refreshes; an unknown agent stops it right after the refresh.
      online = false;
      const missing = yield* resolver.prepare({ agentId: "missing-agent" }).pipe(Effect.flip);
      expect(missing.reason).toBe("agent_not_found");
      expect(requests).toBe(2);

      online = true;
      yield* resolver.search({ query: "example" });
      expect(requests).toBe(3);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              online
                ? new Response(makeRegistry(agent))
                : new Response("unavailable", { status: 503 }),
            ),
          );
        }),
      ),
    );
  });

  it.effect("filters runner recipes that the environment cannot prepare", () => {
    const runnerAgent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    const binaryAgent = {
      ...makeAgent({
        binary: {
          "linux-x86_64": { archive: archiveUrl, cmd: "example-agent" },
        },
      }),
      id: "binary-agent",
      name: "Binary Agent",
    } satisfies AcpRegistrySupport.AcpRegistryAgent;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-runner-filter-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const result = yield* resolver.search({ query: "" });

      expect(result.agents.map((agent) => agent.id)).toEqual(["binary-agent"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({ version: "1.0.0", agents: [runnerAgent, binaryAgent] }),
                ),
              ),
            ),
          { PATH: "" },
        ),
      ),
    );
  });

  it.effect("keeps default searches at 20 and honors larger catalog limits", () => {
    const base = makeAgent({
      binary: {
        "linux-x86_64": { archive: archiveUrl, cmd: "example-agent" },
      },
    });
    const agents = Array.from({ length: 26 }, (_, index) => {
      const suffix = String(index).padStart(2, "0");
      return { ...base, id: `example-agent-${suffix}`, name: `Example Agent ${suffix}` };
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-limit-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const input = yield* decodeSearchInput({ query: "", limit: 512 });
      const catalog = yield* resolver.search(input).pipe(Effect.flatMap(decodeSearchResult));
      const limited = yield* resolver.search({ query: "", limit: 25 });
      const defaultCatalog = yield* resolver.search({ query: "" });
      const matches = yield* resolver.search({ query: "example" });

      expect(catalog.agents).toHaveLength(26);
      expect(limited.agents).toHaveLength(25);
      expect(defaultCatalog.agents).toHaveLength(20);
      expect(matches.agents).toHaveLength(20);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ version: "1.0.0", agents })),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("discards registry agents with blank names or unsafe versions", () => {
    const distribution = {
      binary: {
        "linux-x86_64": { archive: archiveUrl, cmd: "example-agent" },
      },
    } satisfies AcpRegistrySupport.AcpRegistryAgent["distribution"];
    const valid = makeAgent(distribution);
    const blankName = { ...valid, id: "blank-name", name: "   " };
    const blankVersion = { ...valid, id: "blank-version", version: "\t" };
    const parentVersion = { ...valid, id: "parent-version", version: ".." };
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-blank-fields-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const result = yield* resolver.search({ query: "" });

      expect(result.agents.map((agent) => agent.id)).toEqual([valid.id]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  version: "1.0.0",
                  agents: [blankName, blankVersion, parentVersion, valid],
                }),
              ),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("ignores unpinned runner recipes from the registry", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@latest" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-unpinned-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const result = yield* resolver.search({ query: "" });

      expect(result.agents).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("rejects package syntax for the wrong runner", () => {
    const invalidAgents = [
      { ...makeAgent({ npx: { package: "example-agent==1.2.3" } }), id: "bad-npx" },
    ];
    const validAgents = [
      { ...makeAgent({ uvx: { package: "minion-code@0.1.44" } }), id: "valid-at" },
      { ...makeAgent({ uvx: { package: "fast-agent-acp==0.9.30" } }), id: "valid-equals" },
    ];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-runner-syntax-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const invalid = yield* resolver.prepare({ agentId: "bad-npx" }).pipe(Effect.flip);
      const validAt = yield* resolver.prepare({ agentId: "valid-at" }).pipe(Effect.flip);
      const validEquals = yield* resolver.prepare({ agentId: "valid-equals" }).pipe(Effect.flip);

      expect(invalid.reason).toBe("agent_not_found");
      expect(validAt.reason).toBe("runner_unavailable");
      expect(validEquals.reason).toBe("runner_unavailable");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({ version: "1.0.0", agents: [...invalidAgents, ...validAgents] }),
                ),
              ),
            ),
          { PATH: "" },
        ),
      ),
    );
  });

  it.effect("verifies declared SHA-256 before installing a binary", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "example-agent",
          sha256: "0".repeat(64),
        },
      },
    });
    const binaryBytes = new TextEncoder().encode("not the declared binary");

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-checksum-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const error = yield* resolver.prepare({ agentId: agent.id }).pipe(Effect.flip);

      expect(error.reason).toBe("checksum_mismatch");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url === registryUrl
                ? new Response(makeRegistry(agent))
                : new Response(binaryBytes.buffer as ArrayBuffer),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("installs into SSHCode home package recipes during preparation", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3", args: ["--stdio"] } });
    const requests: string[] = [];

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-runner-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, toolchain.environment));
      const prepared = yield* resolver.prepare({ agentId: agent.id });
      expect(prepared).toEqual({
        agentId: "example-agent",
        version: "1.2.3",
        distribution: "npx",
        prepared: true,
      });
      expect(yield* fileSystem.exists(toolchain.executablePath)).toBe(true);
      expect(yield* fileSystem.exists(toolchain.environment.FAKE_NPM_PREFIX)).toBe(false);
      expect(yield* fileSystem.readFileString(toolchain.logPath)).toContain(
        "install --global @example/acp@1.2.3",
      );
      expect(requests).toEqual([registryUrl]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
          );
        }, process.env),
      ),
    );
  });

  it.effect("falls back to a valid cached registry index when refresh fails", () => {
    const agent = makeAgent({
      npx: {
        package: "@example/acp@1.2.3",
        args: ["--stdio"],
      },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-cache-",
      });
      const registryDirectory = `${cacheDir}/acp-registry`;
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${registryDirectory}/registry.json`, makeRegistry(agent));
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const resolved = yield* resolver.resolve(settings(), "/workspace", toolchain.environment);

      expect(resolved.spawn).toMatchObject({
        command: toolchain.executablePath,
        args: ["--stdio"],
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
          ),
        ),
      ),
    );
  });

  it.effect("rejects unsafe command paths before downloading an archive", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "../outside",
        },
      },
    });
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-invalid-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const error = yield* resolver.resolve(settings(), "/workspace").pipe(Effect.flip);

      expect(error.reason).toBe("archive_invalid");
      expect(requests).toEqual([registryUrl]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
          );
        }),
      ),
    );
  });

  it.effect("inspects from disk without waiting for a registry refresh", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    let requests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-cold-inspect-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const registryDirectory = `${cacheDir}/acp-registry`;
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${registryDirectory}/registry.json`, makeRegistry(agent));

      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, toolchain.environment));
      const inspection = yield* resolver.inspect(settings());

      expect(inspection).toMatchObject({ status: "ready", agentId: agent.id });
      expect(requests).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
          );
        }),
      ),
    );
  });

  it.effect("fails a cold inspection immediately when no local registry is available", () => {
    let requests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-empty-inspect-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const error = yield* resolver.inspect(settings()).pipe(Effect.flip);

      expect(error.reason).toBe("registry_unavailable");
      expect(requests).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unused")));
        }),
      ),
    );
  });

  it.effect(
    "discovers an executable override on a cold registry cache without installing it",
    () => {
      const agent = makeAgent({ npx: { package: "@example/acp@1.2.3", args: ["acp"] } });
      const requests: string[] = [];
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-cold-override-",
        });
        const commandPath = `${cacheDir}/example-agent`;
        yield* fileSystem.writeFileString(commandPath, "#!/bin/sh\n");
        yield* fileSystem.chmod(commandPath, 0o755);
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });
        const override = settings({ commandPath });

        expect(yield* resolver.inspect(override)).toMatchObject({
          status: "ready",
          agentId: agent.id,
          version: null,
        });
        expect((yield* resolver.resolve(override, "/workspace")).spawn).toMatchObject({
          command: commandPath,
          args: ["acp"],
        });
        expect(requests).toEqual([registryUrl]);
        expect(yield* fileSystem.exists(`${cacheDir}/tools/${agent.id}`)).toBe(false);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            requests.push(request.url);
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
            );
          }),
        ),
      );
    },
  );

  it.effect("inspects an active ACP agent override offline without fetching the registry", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3", args: ["acp"] } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-active-override-",
      });
      const commandPath = `${cacheDir}/example-agent`;
      yield* fileSystem.writeFileString(commandPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(commandPath, 0o755);
      yield* fileSystem.makeDirectory(`${cacheDir}/acp-registry/active-agents`, {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        `${cacheDir}/acp-registry/active-agents/${agent.id}.json`,
        JSON.stringify(agent),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });

      expect(yield* resolver.inspect(settings({ commandPath }))).toMatchObject({
        status: "ready",
        agentId: agent.id,
        version: null,
        distribution: "npx",
      });
    }).pipe(Effect.scoped, Effect.provide(layerResolver(() => Effect.die("unexpected network"))));
  });

  it.effect("uses the effective provider environment for inspection and resolution", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-effective-env-",
      });
      const registryDirectory = `${cacheDir}/acp-registry`;
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${registryDirectory}/registry.json`, makeRegistry(agent));
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);

      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const hostInspection = yield* resolver.inspect(settings());
      const providerEnvironment = toolchain.environment;
      const instanceInspection = yield* resolver.inspect(settings(), providerEnvironment);
      const resolved = yield* resolver.resolve(settings(), "/workspace", providerEnvironment);

      expect(hostInspection).toMatchObject({ status: "missing_runner", runner: "npm" });
      expect(instanceInspection).toMatchObject({ status: "ready", distribution: "npx" });
      expect(resolved.spawn).toMatchObject({
        command: toolchain.executablePath,
        env: { PATH: expect.stringMatching(new RegExp(`^${toolchain.globalBin}:`, "u")) },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
          { PATH: "" },
        ),
      ),
    );
  });

  it.effect("requires a regular executable file in the managed binary cache", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "bin/example-agent",
        },
      },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-non-file-",
      });
      const registryDirectory = `${cacheDir}/acp-registry`;
      const fakeExecutable = `${cacheDir}/tools/example-agent/1.2.3/linux-x86_64/bin/example-agent`;
      yield* fileSystem.makeDirectory(fakeExecutable, { recursive: true });
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${registryDirectory}/registry.json`, makeRegistry(agent));

      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const directoryError = yield* resolver.inspect(settings()).pipe(Effect.flip);

      expect(directoryError.reason).toBe("archive_invalid");

      yield* fileSystem.remove(fakeExecutable, { recursive: true });
      yield* fileSystem.writeFileString(fakeExecutable, "#!/bin/sh\n");
      yield* fileSystem.chmod(fakeExecutable, 0o644);
      const modeError = yield* resolver.inspect(settings()).pipe(Effect.flip);

      expect(modeError.reason).toBe("archive_invalid");

      yield* fileSystem.chmod(fakeExecutable, 0o755);
      expect(yield* resolver.inspect(settings())).toMatchObject({ status: "ready" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect.each([
    { name: "legacy registry", source: undefined, agentId: "example-agent", referenced: true },
    { name: "registry", source: "registry", agentId: "example-agent", referenced: true },
    { name: "padded registry", source: "registry", agentId: " example-agent ", referenced: true },
    { name: "local command", source: "local", agentId: "example-agent", referenced: false },
  ] as const)(
    "checks $name references before uninstalling only managed binaries",
    ({ source, agentId, referenced }) => {
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-uninstall-",
        });
        const agentRoot = `${cacheDir}/tools/example-agent`;
        const runnerCache = `${cacheDir}/external-npx-cache/example-agent/package.json`;
        yield* fileSystem.makeDirectory(`${agentRoot}/1.2.3/linux-x86_64`, { recursive: true });
        yield* fileSystem.writeFileString(`${agentRoot}/1.2.3/linux-x86_64/agent`, "binary");
        yield* fileSystem.makeDirectory(`${cacheDir}/external-npx-cache/example-agent`, {
          recursive: true,
        });
        yield* fileSystem.writeFileString(runnerCache, "{}");

        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });
        const hostSettings = yield* TestProviderHost.TestProviderHostSettings;
        const instanceId = ProviderInstanceId.make("uninstall-reference");
        yield* hostSettings.set({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("acpRegistry"),
              displayName: "Uninstall reference",
              enabled: true,
              config: {
                agentId,
                commandPath: "/local/agent",
                ...(source ? { source } : {}),
              },
            },
          },
        });
        const first = yield* resolver.uninstallManagedBinary({ agentId: "example-agent" });
        expect(first).toEqual({ agentId: "example-agent", removed: !referenced });
        expect(yield* fileSystem.exists(agentRoot)).toBe(referenced);
        yield* hostSettings.set(DEFAULT_SERVER_SETTINGS);
        const second = yield* resolver.uninstallManagedBinary({ agentId: "example-agent" });

        expect(second).toEqual({ agentId: "example-agent", removed: referenced });
        expect(yield* resolver.uninstallManagedBinary({ agentId: "example-agent" })).toEqual({
          agentId: "example-agent",
          removed: false,
        });
        expect(yield* fileSystem.exists(agentRoot)).toBe(false);
        expect(yield* fileSystem.exists(runnerCache)).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unused"))),
          ),
        ),
      );
    },
  );

  it.effect("keeps managed package installs when removing the same agent's binaries", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-uninstall-packages-",
      });
      const versionRoot = `${cacheDir}/tools/example-agent/1.2.3`;
      yield* fileSystem.makeDirectory(`${versionRoot}/linux-x86_64`, { recursive: true });
      yield* fileSystem.writeFileString(`${versionRoot}/linux-x86_64/agent`, "binary");
      yield* fileSystem.makeDirectory(`${versionRoot}/npm/bin`, { recursive: true });
      yield* fileSystem.writeFileString(`${versionRoot}/npm/bin/agent`, "package command");
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      expect(yield* resolver.uninstallManagedBinary({ agentId: "example-agent" })).toEqual({
        agentId: "example-agent",
        removed: true,
      });
      expect(yield* fileSystem.exists(`${versionRoot}/linux-x86_64`)).toBe(false);
      expect(yield* fileSystem.readFileString(`${versionRoot}/npm/bin/agent`)).toBe(
        "package command",
      );
      expect(yield* resolver.uninstallManagedBinary({ agentId: "example-agent" })).toEqual({
        agentId: "example-agent",
        removed: false,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(layerResolver(() => Effect.die("unexpected HTTP request"))),
    ),
  );

  it.effect("keeps a binary prepared by another client while an uninstall is waiting", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "./bin/example-agent",
        },
      },
    });
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    return Effect.gen(function* () {
      const downloadStarted = yield* Deferred.make<void>();
      const releaseDownload = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-uninstall-race-",
        });
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });

        const prepareFiber = yield* resolver
          .prepare({ agentId: agent.id })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(downloadStarted);
        const uninstallFiber = yield* resolver
          .uninstallManagedBinary({ agentId: agent.id })
          .pipe(Effect.forkChild({ startImmediately: true }));

        expect(uninstallFiber.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(releaseDownload, undefined);

        expect(yield* Fiber.join(prepareFiber)).toMatchObject({ prepared: true });
        expect(yield* Fiber.join(uninstallFiber)).toEqual({
          agentId: agent.id,
          removed: false,
        });
        const agentRoot = `${cacheDir}/tools/${agent.id}`;
        expect(yield* fileSystem.exists(agentRoot)).toBe(true);

        const hostSettings = yield* TestProviderHost.TestProviderHostSettings;
        const instanceId = ProviderInstanceId.make("registry-reference");
        yield* hostSettings.set({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("acpRegistry"),
              displayName: "Registry reference",
              enabled: true,
              config: { agentId: agent.id },
            },
          },
        });
        expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
          agentId: agent.id,
          removed: false,
        });
        yield* hostSettings.set(DEFAULT_SERVER_SETTINGS);
        expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
          agentId: agent.id,
          removed: true,
        });
        expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
          agentId: agent.id,
          removed: false,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            if (request.url === registryUrl) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
              );
            }
            return Deferred.succeed(downloadStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDownload)),
              Effect.as(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(binaryBytes.buffer as ArrayBuffer),
                ),
              ),
            );
          }),
        ),
      );
    });
  });

  it.effect("resolves an installed agent while another agent's download is still running", () => {
    const slowArchiveUrl = "https://registry.test/slow-agent.bin";
    const agent = makeAgent({
      binary: { "linux-x86_64": { archive: archiveUrl, cmd: "./bin/example-agent" } },
    });
    const slowAgent = {
      ...agent,
      distribution: {
        binary: { "linux-x86_64": { archive: slowArchiveUrl, cmd: "./bin/slow-agent" } },
      },
      id: "slow-agent",
      name: "Slow Agent",
    };
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    return Effect.gen(function* () {
      const downloadStarted = yield* Deferred.make<void>();
      const releaseDownload = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-parallel-install-",
        });
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });

        yield* resolver.resolve(settings(), "/workspace");

        const prepareFiber = yield* resolver
          .prepare({ agentId: slowAgent.id })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(downloadStarted);

        const resolved = yield* resolver.resolve(settings(), "/workspace");
        expect(resolved.spawn.command).toContain(
          "/tools/example-agent/1.2.3/linux-x86_64/bin/example-agent",
        );
        expect(prepareFiber.pollUnsafe()).toBeUndefined();

        yield* Deferred.succeed(releaseDownload, undefined);
        expect(yield* Fiber.join(prepareFiber)).toMatchObject({ prepared: true });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) => {
            if (request.url === registryUrl) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify({ version: "1.0.0", agents: [slowAgent, agent] })),
                ),
              );
            }
            const response = HttpClientResponse.fromWeb(
              request,
              new Response(binaryBytes.buffer as ArrayBuffer),
            );
            if (request.url !== slowArchiveUrl) return Effect.succeed(response);
            return Deferred.succeed(downloadStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseDownload)),
              Effect.as(response),
            );
          }),
        ),
      );
    });
  });

  it.effect("reserves a prepared binary until a configured instance inspects it", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "./bin/example-agent",
        },
      },
    });
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-uninstall-reservation-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });

      yield* resolver.prepare({ agentId: agent.id });
      expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
        agentId: agent.id,
        removed: false,
      });
      expect(yield* resolver.inspect(settings())).toMatchObject({ status: "ready" });
      expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
        agentId: agent.id,
        removed: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url === registryUrl
                ? new Response(makeRegistry(agent))
                : new Response(binaryBytes.buffer as ArrayBuffer),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("expires an abandoned prepared-binary reservation", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "./bin/example-agent",
        },
      },
    });
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-uninstall-expiry-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });

      yield* resolver.prepare({ agentId: agent.id });
      yield* TestClock.adjust("31 seconds");
      expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
        agentId: agent.id,
        removed: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url === registryUrl
                ? new Response(makeRegistry(agent))
                : new Response(binaryBytes.buffer as ArrayBuffer),
            ),
          ),
        ),
      ),
    );
  });
});

describe("acpRegistryManagedBinaryDirectories", () => {
  it.effect("lists managed package and binary command directories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-bins-",
      });
      const install = (agent: string, version: string, target: string, commandDirectory = "") =>
        fileSystem.makeDirectory(
          path.join(cacheDir, "tools", agent, version, target, commandDirectory),
          { recursive: true },
        );
      yield* install("kimi", "1.49.0", "linux-x86_64", "bin");
      yield* install("kimi", "1.50.0", "linux-x86_64", "cmd");
      yield* install("kimi", "1.50.0", "darwin-aarch64");
      yield* install("other-agent", "0.2.0", "darwin-aarch64");
      const globalBin = path.join(cacheDir, "tools", "gemini", "0.56.0", "npm", "bin");
      const geminiCommand = path.join(globalBin, "gemini");
      const receiptsDirectory = path.join(cacheDir, "acp-registry", "package-installs");
      yield* fileSystem.makeDirectory(globalBin, { recursive: true });
      yield* fileSystem.makeDirectory(receiptsDirectory, { recursive: true });
      yield* fileSystem.writeFileString(geminiCommand, "#!/bin/sh\n");
      yield* fileSystem.chmod(geminiCommand, 0o755);
      yield* fileSystem.writeFileString(
        path.join(receiptsDirectory, "gemini.json"),
        encodeUnknownJson({
          agentId: "gemini",
          agentVersion: "0.56.0",
          distribution: "npx",
          packageSpec: "@google/gemini-cli@0.56.0",
          managerPath: "/usr/bin/npm",
          binDirectory: globalBin,
          executablePath: geminiCommand,
          packageRoot: path.join(
            cacheDir,
            "tools",
            "gemini",
            "0.56.0",
            "npm",
            "lib",
            "node_modules",
            "@google",
            "gemini-cli",
          ),
          packageVersion: "0.56.0",
        }),
      );
      yield* fileSystem.writeFileString(
        path.join(cacheDir, "acp-registry", "registry.json"),
        encodeUnknownJson({
          version: "1.0.0",
          agents: [
            {
              ...makeAgent({
                binary: {
                  "linux-x86_64": { archive: archiveUrl, cmd: "bin/kimi" },
                },
              }),
              id: "kimi",
              name: "Kimi",
              version: "1.49.0",
            },
            {
              ...makeAgent({
                binary: {
                  "linux-x86_64": { archive: archiveUrl, cmd: "cmd/kimi" },
                },
              }),
              id: "kimi",
              name: "Kimi",
              version: "1.50.0",
            },
          ],
        }),
      );

      const directories = yield* AcpRegistrySupport.acpRegistryManagedBinaryDirectories({
        cacheDir,
        toolsDir: path.join(cacheDir, "tools"),
        platform: "linux",
        architecture: "x64",
      });
      expect(directories).toEqual([
        globalBin,
        path.join(cacheDir, "tools", "kimi", "1.50.0", "linux-x86_64", "cmd"),
        path.join(cacheDir, "tools", "kimi", "1.49.0", "linux-x86_64", "bin"),
      ]);

      const missing = yield* AcpRegistrySupport.acpRegistryManagedBinaryDirectories({
        cacheDir: path.join(cacheDir, "does-not-exist"),
        toolsDir: path.join(cacheDir, "does-not-exist", "tools"),
        platform: "linux",
        architecture: "x64",
      });
      expect(missing).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

it.effect(
  "checks registry releases without selecting them, updates on click, and retains old binaries across restart",
  () => {
    let availableVersion = "1.2.3";
    let corrupt = false;
    let rejectStartup = false;
    const validations: string[] = [];
    let downloads = 0;
    const archive = new TextEncoder().encode("#!/bin/sh\nexit 0\n");
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "acp-updates-" });
      const crypto = yield* Crypto.Crypto;
      const checksum = Hex.encode(yield* crypto.digest("SHA-256", archive));
      const http = HttpClient.make((request) =>
        Effect.sync(() => {
          if (request.url === registryUrl)
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                makeRegistry({
                  ...makeAgent({
                    binary: {
                      "linux-x86_64": {
                        archive: archiveUrl,
                        cmd: "./agent",
                        sha256: corrupt ? "0".repeat(64) : checksum,
                      },
                    },
                  }),
                  version: availableVersion,
                }),
              ),
            );
          downloads++;
          return HttpClientResponse.fromWeb(request, new Response(archive));
        }),
      );
      const make = AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: root,
        toolsDir: `${root}/tools`,
        registryUrl,
        validateUpdate: (spawn) =>
          Effect.gen(function* () {
            const selected = yield* fs
              .readFileString(`${root}/acp-registry/active-agents/example-agent.json`)
              .pipe(Effect.orDie);
            expect(selected).not.toContain(`"version":"${availableVersion}"`);
            expect(yield* fs.exists(spawn.command).pipe(Effect.orDie)).toBe(true);
            validations.push(spawn.command);
            if (rejectStartup)
              return yield* new AcpRegistrySupport.AcpRegistryError({
                reason: "install_failed",
                detail: "The fake agent could not initialize",
              });
          }),
      }).pipe(Effect.provideService(HttpClient.HttpClient, http));
      const catalog = yield* make;
      const config = settings({ enabled: true });
      yield* catalog.prepare({ agentId: "example-agent" });
      const old = yield* catalog.resolve(config, root);
      expect(downloads).toBe(1);
      availableVersion = "1.2.4";
      // Simulate an installation made before active descriptors existed.
      yield* fs.remove(`${root}/acp-registry/active-agents/example-agent.json`);
      yield* catalog.search({ query: "example" });
      const capabilities = yield* catalog.maintenance(config, { HOME: `${root}/instance` });
      expect(capabilities.latestVersion).toBe("1.2.4");
      expect(capabilities.update?.env?.HOME).toBe(`${root}/instance`);
      expect(((yield* catalog.inspect(config)) as { version: string }).version).toBe("1.2.3");
      expect((yield* catalog.resolve(config, root)).spawn.command).toBe(old.spawn.command);
      expect(downloads).toBe(1);
      yield* capabilities.update!.run!;
      const updated = yield* catalog.resolve(config, root);
      expect(updated.agent?.version).toBe("1.2.4");
      expect(validations).toHaveLength(1);
      expect(updated.spawn.command).not.toBe(old.spawn.command);
      expect(yield* fs.exists(old.spawn.command)).toBe(true);
      const restarted = yield* make;
      expect((yield* restarted.resolve(config, root)).agent?.version).toBe("1.2.4");
      availableVersion = "1.2.5";
      corrupt = true;
      const broken = yield* catalog.maintenance(config);
      expect((yield* Effect.exit(broken.update!.run!))._tag).toBe("Failure");
      expect((yield* catalog.resolve(config, root)).agent?.version).toBe("1.2.4");
      corrupt = false;
      rejectStartup = true;
      const cannotStart = yield* catalog.maintenance(config);
      expect((yield* Effect.exit(cannotStart.update!.run!))._tag).toBe("Failure");
      expect((yield* catalog.resolve(config, root)).agent?.version).toBe("1.2.4");
      expect(validations).toHaveLength(2);
    }).pipe(Effect.scoped, Effect.provide(layerResolver(() => Effect.die("unexpected network"))));
  },
);

it.effect(
  "excludes patched Kimi command overrides and local commands without contacting the registry",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "acp-override-maintenance-" });
      const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: root,
        toolsDir: `${root}/tools`,
        registryUrl,
      });
      for (const config of [
        settings({
          enabled: true,
          agentId: "kimi",
          commandPath: "/tools/kimi-code-steer/bin/kimi-steer",
        }),
        settings({ enabled: true, source: "local", commandPath: "/bin/agent" }),
      ]) {
        const maintenance = yield* catalog.maintenance(config);
        expect(maintenance.update).toBeNull();
        expect(maintenance.latestVersion).toBeNull();
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(() => Effect.die("Override must never check registry releases")),
      ),
    ),
);

it.effect.each(["npx", "uvx"] as const)(
  "updates a managed %s distribution into a new version directory",
  (distribution) => {
    let availableVersion = "1.2.3";
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "acp-package-update-" });
      const toolchain =
        distribution === "npx"
          ? yield* makeFakeNpmToolchain(root)
          : yield* makeFakeUvToolchain(root);
      const agent = makeAgent(
        distribution === "npx"
          ? { npx: { package: "@example/acp@1.2.3" } }
          : { uvx: { package: "fast-agent-acp==0.10.1" } },
      );
      const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: root,
        toolsDir: `${root}/tools`,
        registryUrl,
        validateUpdate: () => Effect.void,
      }).pipe(
        Effect.provideService(HostProcess.Environment, toolchain.environment),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(makeRegistry({ ...agent, version: availableVersion })),
              ),
            ),
          ),
        ),
      );
      const config = settings({ enabled: true, distribution });
      yield* catalog.prepare({ agentId: agent.id });
      const launchScope = yield* Scope.make();
      yield* Effect.addFinalizer((exit) => Scope.close(launchScope, exit));
      const old = yield* catalog
        .resolve(config, root, toolchain.environment)
        .pipe(Effect.provideService(Scope.Scope, launchScope));
      const legacy = `${root}/tools/${agent.id}/1.2.2`;
      const legacyBin = `${legacy}/${distribution === "npx" ? "npm" : "python"}/bin`;
      yield* fs.makeDirectory(legacyBin, { recursive: true });
      yield* fs.writeFileString(`${legacyBin}/legacy-agent`, "old");
      availableVersion = "1.2.4";
      const maintenance = yield* catalog.maintenance(config, toolchain.environment);
      expect(maintenance.latestVersion).toBe("1.2.4");
      expect(
        ((yield* catalog.inspect(config, toolchain.environment)) as { version: string }).version,
      ).toBe("1.2.3");
      yield* maintenance.update!.run!;
      const updated = yield* catalog.resolve(config, root, toolchain.environment);
      expect(updated.spawn.command).toContain("1.2.4");
      expect(updated.spawn.command).not.toBe(old.spawn.command);
      expect(yield* fs.exists(old.spawn.command)).toBe(true);
      expect(yield* fs.exists(legacy)).toBe(false);

      // An older release carried forward from an earlier server is also pruned
      // on startup, while the recorded rollback is kept.
      yield* fs.makeDirectory(legacyBin, { recursive: true });
      yield* fs.writeFileString(`${legacyBin}/legacy-agent`, "old");
      yield* catalog.pruneManagedVersions();
      expect(yield* fs.exists(legacy)).toBe(false);
      expect(yield* fs.exists(old.spawn.command)).toBe(true);

      // A second update moves the rollback forward, but the old launch still
      // needs its release until its runtime scope closes.
      availableVersion = "1.2.5";
      const secondUpdate = yield* catalog.maintenance(config, toolchain.environment);
      yield* secondUpdate.update!.run!;
      expect(yield* fs.exists(old.spawn.command)).toBe(true);
      yield* Scope.close(launchScope, Exit.void);
      yield* catalog.pruneManagedVersions();
      expect(yield* fs.exists(old.spawn.command)).toBe(false);
      expect(yield* fs.exists(updated.spawn.command)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layerResolver(() => Effect.die("Unexpected network"))));
  },
);

it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "initializes the downloaded executable before selecting it, and leaves the old selection on startup failure",
  () => {
    let version = "1.0.0";
    const script = new TextEncoder().encode(`#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(process.env.START_LOG, process.argv[1] + "\\n");
if (process.env.FAIL_INITIALIZE) process.exit(1);
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } }) + "\\n");
});
`);
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "acp-update-startup-" });
      const crypto = yield* Crypto.Crypto;
      const checksum = Hex.encode(yield* crypto.digest("SHA-256", script));
      const env = { HOME: root, PATH: process.env.PATH, START_LOG: `${root}/starts` };
      const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: root,
        toolsDir: `${root}/tools`,
        registryUrl,
      }).pipe(
        Effect.provideService(HostProcess.Environment, env),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                request.url === registryUrl
                  ? new Response(
                      makeRegistry({
                        ...makeAgent({
                          binary: {
                            "linux-x86_64": {
                              archive: archiveUrl,
                              cmd: "./agent",
                              sha256: checksum,
                            },
                          },
                        }),
                        version,
                      }),
                    )
                  : new Response(script),
              ),
            ),
          ),
        ),
      );
      const config = settings({ enabled: true });
      yield* catalog.prepare({ agentId: "example-agent" });
      expect(yield* fs.exists(env.START_LOG)).toBe(false);
      version = "2.0.0";
      yield* (yield* catalog.maintenance(config, env)).update!.run!;
      expect((yield* catalog.resolve(config, root, env)).agent?.version).toBe("2.0.0");
      expect(yield* fs.readFileString(env.START_LOG)).toContain("2.0.0");
      version = "3.0.0";
      const failure = yield* catalog.maintenance(config, { ...env, FAIL_INITIALIZE: "1" });
      expect((yield* Effect.exit(failure.update!.run!))._tag).toBe("Failure");
      expect((yield* catalog.resolve(config, root, env)).agent?.version).toBe("2.0.0");
    }).pipe(Effect.scoped, Effect.provide(layerResolver(() => Effect.die("Unexpected network"))));
  },
);

it.effect(
  "still reports the newer release when the selected distribution can only be updated manually",
  () => {
    let latest = false;
    const agent = makeAgent({
      binary: { "linux-x86_64": { archive: archiveUrl, cmd: "./agent", sha256: "a".repeat(64) } },
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "acp-update-manual-" });
      const catalog = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: root,
        toolsDir: `${root}/tools`,
        registryUrl,
      });
      yield* catalog.search({ query: "example" });
      latest = true;
      const maintenance = yield* catalog.maintenance(
        settings({ enabled: true, distribution: "binary" }),
      );
      expect(maintenance.latestVersion).toBe("2.0.0");
      expect(maintenance.update).toBeNull();
      expect(maintenance.manualUpdateCommand).toBe("https://official.test/agent");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                makeRegistry(
                  latest
                    ? {
                        ...agent,
                        version: "2.0.0",
                        website: "https://official.test/agent",
                        distribution: { npx: { package: "@example/acp@2.0.0" } },
                      }
                    : agent,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  },
);
