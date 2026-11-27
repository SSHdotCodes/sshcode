// @effect-diagnostics nodeBuiltinImport:off -- Real child processes prove shared-home lease safety.
import * as NodeChildProcess from "node:child_process";
import * as NodeModule from "node:module";
import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { managedReleaseRetention } from "./ManagedReleaseRetention.ts";

const makeHarness = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-release-retention-" });
  let active: string | null = "4";
  const retention = managedReleaseRetention({
    directory,
    versionsDirectory: directory,
    validName: (name) => /^\d+$/u.test(name),
    active: Effect.sync(() => active),
    completed: (name) =>
      fs
        .exists(`${directory}/${name}/.install-complete.json`)
        .pipe(Effect.orElseSucceed(() => false)),
  });
  for (const name of ["1", "2", "3", "4"]) {
    yield* fs.makeDirectory(`${directory}/${name}`);
    yield* fs.writeFileString(`${directory}/${name}/.install-complete.json`, "{}");
    yield* fs.utimes(`${directory}/${name}`, Number(name), Number(name));
  }
  return {
    fs,
    directory,
    retention,
    setActive: (name: string | null) => {
      active = name;
    },
  };
});

it.live(
  "retains the active release and its actual rollback, removing older completed releases",
  () =>
    Effect.gen(function* () {
      const { fs, directory, retention } = yield* makeHarness;
      yield* retention.withLock(
        Effect.gen(function* () {
          yield* retention.rememberRollback("2", "4");
          yield* retention.prune();
        }),
      );
      expect(yield* fs.exists(`${directory}/4`)).toBe(true);
      expect(yield* fs.exists(`${directory}/2`)).toBe(true);
      expect(yield* fs.exists(`${directory}/1`)).toBe(false);
      expect(yield* fs.exists(`${directory}/3`)).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("leases protect older versions across independent instances until released", () =>
  Effect.gen(function* () {
    const { fs, directory, retention } = yield* makeHarness;
    const release = yield* retention.withLock(retention.lease(`${directory}/1`));
    const other = managedReleaseRetention({
      directory,
      versionsDirectory: directory,
      validName: (name) => /^\d+$/u.test(name),
      active: Effect.succeed("4"),
      completed: () => Effect.succeed(true),
    });
    expect(yield* other.withLock(other.hasLeases)).toBe(true);
    yield* other.withLock(other.prune());
    expect(yield* fs.exists(`${directory}/1`)).toBe(true);
    expect(yield* fs.exists(`${directory}/2`)).toBe(false);
    yield* release();
    expect(yield* other.withLock(other.hasLeases)).toBe(false);
    yield* other.withLock(other.prune());
    expect(yield* fs.exists(`${directory}/1`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live(
  "never prunes incomplete folders, directory symlinks, or releases with unknown lease owners",
  () =>
    Effect.gen(function* () {
      const { fs, directory, retention } = yield* makeHarness;
      yield* fs.makeDirectory(`${directory}/0`);
      yield* fs.symlink(`${directory}/4`, `${directory}/5`);
      yield* fs.makeDirectory(`${directory}/.leases/1`, { recursive: true });
      yield* fs.writeFileString(`${directory}/.leases/1/unknown-owner`, "");
      yield* retention.withLock(retention.prune());
      expect(yield* fs.exists(`${directory}/0`)).toBe(true);
      expect(yield* fs.readLink(`${directory}/5`)).toBe(`${directory}/4`);
      expect(yield* fs.exists(`${directory}/1`)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("keeps a lease owned by another process, then reclaims it after that process exits", () =>
  Effect.gen(function* () {
    const { fs, directory, retention } = yield* makeHarness;
    const child = yield* Effect.acquireRelease(
      Effect.promise(
        () =>
          new Promise<NodeChildProcess.ChildProcess>((resolve, reject) => {
            const child = NodeChildProcess.spawn(
              process.execPath,
              [
                "-e",
                `const fs = require("node:fs");
           const dir = process.argv[1];
           fs.mkdirSync(dir, { recursive: true });
           fs.writeFileSync(dir + "/" + process.pid + "-abcdef", "");
           process.send("ready");
           process.on("message", () => process.exit(0));`,
                `${directory}/.leases/1`,
              ],
              { stdio: ["ignore", "ignore", "inherit", "ipc"] },
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
    yield* retention.withLock(retention.prune());
    expect(yield* fs.exists(`${directory}/1`)).toBe(true);
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          child.once("exit", () => resolve());
          child.send("exit");
        }),
    );
    yield* retention.withLock(retention.prune());
    expect(yield* fs.exists(`${directory}/1`)).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.live("excludes mutation by another process while a resolve and lease are being admitted", () =>
  Effect.gen(function* () {
    const { directory, retention } = yield* makeHarness;
    const module = NodeModule.createRequire(import.meta.url).resolve("proper-lockfile");
    const probe = Effect.promise(async () => {
      const result = await NodeUtil.promisify(NodeChildProcess.execFile)(process.execPath, [
        "-e",
        `require(process.argv[1]).lock(process.argv[2], { realpath: false }).then(
          async release => { await release(); process.stdout.write("acquired"); },
          error => { if (error.code === "ELOCKED") process.stdout.write("blocked"); else throw error; }
        );`,
        module,
        `${directory}.releases`,
      ]);
      return result.stdout;
    });
    expect(yield* retention.withLock(probe)).toBe("blocked");
    expect(yield* probe).toBe("acquired");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
