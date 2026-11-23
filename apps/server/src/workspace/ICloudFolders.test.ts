// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProcessRunner from "../processRunner.ts";
import * as ICloudFolders from "./ICloudFolders.ts";

const fixture = (
  options: { synced?: ReadonlyArray<string>; platform?: NodeJS.Platform; fail?: boolean } = {},
) =>
  Effect.gen(function* () {
    const home = yield* Effect.acquireRelease(
      Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(process.cwd(), ".icloud-test-"))),
      (directory) => Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })),
    );
    for (const directory of ["Documents", "Desktop", "Library/Mobile Documents", "local"])
      yield* Effect.promise(() =>
        NodeFSP.mkdir(NodePath.join(home, directory), { recursive: true }),
      );
    const calls: string[] = [];
    const runner = ProcessRunner.ProcessRunner.of({
      run: (input) =>
        Effect.gen(function* () {
          expect(input.command).toBe("/usr/bin/xattr");
          expect(input.args.slice(0, 2)).toEqual(["-p", "com.apple.file-provider-domain-id"]);
          const folder = NodePath.basename(input.args[2]!);
          calls.push(folder);
          if (options.fail)
            return yield* new ProcessRunner.ProcessSpawnError({
              command: input.command,
              argumentCount: input.args.length,
              cause: new Error("unavailable"),
            });
          const found = options.synced?.includes(folder) ?? false;
          return {
            stdout: found ? "domain-id" : "",
            stderr: "",
            code: ChildProcessSpawner.ExitCode(found ? 0 : 1),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    });
    const context = yield* Layer.build(
      ICloudFolders.layer.pipe(
        Layer.provide(Layer.succeed(ProcessRunner.ProcessRunner, runner)),
        Layer.provide(Layer.succeed(HostProcess.HomeDirectory, home)),
        Layer.provide(Layer.succeed(HostProcess.Platform, options.platform ?? "darwin")),
        Layer.provide(NodeServices.layer),
      ),
    );
    const service = yield* ICloudFolders.ICloudFolders.pipe(Effect.provide(context));
    return { service, home, calls };
  });

describe("iCloud folders", () => {
  it.effect("recognizes Mobile Documents without requiring Desktop and Documents sync", () =>
    Effect.gen(function* () {
      const { service, home, calls } = yield* fixture();
      expect(
        yield* service.contains(
          NodePath.join(home, "Library/Mobile Documents/com~apple~CloudDocs/project"),
        ),
      ).toBe(true);
      expect(yield* service.contains(NodePath.join(home, "Documents/project"))).toBe(false);
      expect(yield* service.contains(NodePath.join(home, "Desktop/project"))).toBe(false);
      expect(calls).toEqual(["Documents", "Desktop"]);
    }),
  );

  it.effect("uses each folder's attribute, caches the signal, and respects path boundaries", () =>
    Effect.gen(function* () {
      const { service, home, calls } = yield* fixture({ synced: ["Documents"] });
      expect(yield* service.contains(NodePath.join(home, "Documents"))).toBe(true);
      expect(yield* service.contains(NodePath.join(home, "Documents/project"))).toBe(true);
      expect(yield* service.contains(NodePath.join(home, "Desktop/project"))).toBe(false);
      expect(yield* service.contains(NodePath.join(home, "Documents-old/project"))).toBe(false);
      expect(yield* service.contains(NodePath.join(home, "Library/Mobile Documents-old"))).toBe(
        false,
      );
      expect(yield* service.contains(NodePath.join(home, "local"))).toBe(false);
      expect(calls).toEqual(["Documents", "Desktop"]);
    }),
  );

  it.effect("recognizes Desktop sync and symlinks into synced folders", () =>
    Effect.gen(function* () {
      const { service, home } = yield* fixture({ synced: ["Desktop"] });
      const alias = NodePath.join(home, "alias");
      yield* Effect.promise(() => NodeFSP.symlink(NodePath.join(home, "Desktop"), alias));
      expect(yield* service.contains(alias)).toBe(true);
      expect(yield* service.contains(NodePath.join(home, "Desktop/project"))).toBe(true);
    }),
  );

  it.effect("fails quietly when attributes cannot be read", () =>
    Effect.gen(function* () {
      const { service, home } = yield* fixture({ fail: true });
      expect(yield* service.contains(NodePath.join(home, "Documents"))).toBe(false);
    }),
  );

  it.effect("does not run xattr on other platforms", () =>
    Effect.gen(function* () {
      const { service, home, calls } = yield* fixture({ platform: "linux", synced: ["Documents"] });
      expect(yield* service.contains(NodePath.join(home, "Documents"))).toBe(false);
      expect(yield* service.contains(NodePath.join(home, "Library/Mobile Documents"))).toBe(false);
      expect(calls).toEqual([]);
    }),
  );
});
