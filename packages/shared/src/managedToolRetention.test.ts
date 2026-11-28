// @effect-diagnostics nodeBuiltinImport:off -- Exercises real process and symlink fixtures.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HostProcess from "./HostProcess.ts";
import { pruneManagedToolVersions } from "./managedToolRetention.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The canonical path: the prune reports real paths, and macOS's default temp folder is a link.
  const base = yield* fs.realPath(
    yield* fs.makeTempDirectoryScoped({ prefix: "t3-tool-retention-" }),
  );
  const toolsDirectory = path.join(base, "tools");
  const versionsDirectory = path.join(toolsDirectory, "provider");
  const version = (n: number) => `1.0.${n}`;
  const directory = (n: number) => path.join(versionsDirectory, version(n));
  for (const n of [1, 2, 3, 4]) {
    yield* fs.makeDirectory(directory(n), { recursive: true });
    yield* fs.utimes(directory(n), n, n);
  }
  return {
    base,
    fs,
    path,
    version,
    directory,
    input: {
      toolsDirectory,
      versionsDirectory,
      current: version(4),
      completed: () => Effect.succeed(true),
    },
  };
});

it.live("keeps the selected release and the actual rollback, and previews without deleting", () =>
  Effect.gen(function* () {
    const { fs, input, version, directory } = yield* fixture;
    const options = {
      ...input,
      rollback: version(2),
      processes: Effect.succeed({ uses: () => false }),
    };
    const plan = yield* pruneManagedToolVersions({ ...options, dryRun: true });
    expect(plan.candidates).toEqual([directory(3), directory(1)]);
    expect(yield* fs.exists(directory(1))).toBe(true);
    expect(yield* pruneManagedToolVersions(options)).toEqual(plan);
    expect((yield* fs.readDirectory(input.versionsDirectory)).sort()).toEqual([
      version(2),
      version(4),
    ]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(!["darwin", "linux"].includes(HostProcess.Platform.defaultValue()))(
  "keeps an old release used as a live process cwd, then reclaims it after exit",
  () =>
    Effect.gen(function* () {
      const { fs, input, directory } = yield* fixture;
      const child = yield* Effect.acquireRelease(
        Effect.promise(
          () =>
            new Promise<ReturnType<typeof NodeChildProcess.spawn>>((resolve, reject) => {
              const child = NodeChildProcess.spawn(
                process.execPath,
                ["-e", "process.on('message', () => process.exit(0)); process.send('ready')"],
                {
                  cwd: directory(1),
                  stdio: ["ignore", "ignore", "ignore", "ipc"],
                },
              );
              child.once("error", reject);
              child.once("message", () => resolve(child));
            }),
        ),
        (child) =>
          Effect.sync(() => {
            child.kill();
          }),
      );
      const result = yield* pruneManagedToolVersions(input);
      expect(result.skippedInUse).toEqual([directory(1)]);
      expect(yield* fs.exists(directory(2))).toBe(false);
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            child.once("exit", () => resolve());
            child.send("exit");
          }),
      );
      expect((yield* pruneManagedToolVersions(input)).candidates).toEqual([directory(1)]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "rejects symlinked version and tool folders and leaves nested link targets untouched",
  () =>
    Effect.gen(function* () {
      const { base, fs, path, input, directory } = yield* fixture;
      const outside = path.join(base, "outside");
      yield* fs.makeDirectory(outside);
      const marker = path.join(outside, "marker");
      yield* fs.writeFileString(marker, "keep");
      yield* fs.symlink(outside, directory(0));
      yield* fs.symlink(outside, path.join(directory(1), "nested"));
      const options = {
        ...input,
        rollback: "1.0.3",
        processes: Effect.succeed({ uses: () => false }),
      };
      yield* pruneManagedToolVersions(options);
      expect(yield* fs.readLink(directory(0))).toBe(outside);
      expect(yield* fs.exists(directory(1))).toBe(false);
      expect(yield* fs.readFileString(marker)).toBe("keep");

      const alias = path.join(input.toolsDirectory, "alias");
      yield* fs.symlink(input.versionsDirectory, alias);
      for (const versionsDirectory of [alias, outside]) {
        const result = yield* pruneManagedToolVersions({ ...options, versionsDirectory });
        expect(result.candidates).toEqual([]);
      }
      expect(yield* fs.readFileString(marker)).toBe("keep");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("skips all deletion when it cannot inspect processes", () =>
  Effect.gen(function* () {
    const { fs, input } = yield* fixture;
    const result = yield* pruneManagedToolVersions({ ...input, processes: Effect.succeed(null) });
    expect(result).toMatchObject({ processScanFailed: true, candidates: [] });
    expect(yield* fs.readDirectory(input.versionsDirectory)).toHaveLength(4);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
