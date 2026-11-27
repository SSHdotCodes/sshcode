// @effect-diagnostics nodeBuiltinImport:off -- Filesystem leases coordinate independent server processes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { lock } from "proper-lockfile";
import { pruneManagedToolVersions } from "@t3tools/shared/managedToolRetention";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ManagedReleaseRetentionError extends Schema.TaggedError<ManagedReleaseRetentionError>()(
  "ManagedReleaseRetentionError",
  { cause: Schema.Defect() },
) {}

const missing = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "ENOENT";

/** Call lease, rememberRollback, prune and hasLeases while holding withLock. */
export function managedReleaseRetention(input: {
  readonly directory: string;
  readonly toolsDirectory?: string;
  readonly versionsDirectory: string;
  readonly validName: (name: string) => boolean;
  readonly active: Effect.Effect<string | null>;
  readonly completed: (name: string) => Effect.Effect<boolean>;
}) {
  const io = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new ManagedReleaseRetentionError({ cause }),
    });
  const leaseRoot = NodePath.join(input.directory, ".leases");
  const rollbackPath = NodePath.join(input.directory, "rollback.json");
  const withLock = <A, E, R>(task: Effect.Effect<A, E, R>) =>
    Effect.scoped(
      Effect.gen(function* () {
        // The lock is a sibling so explicit removal never removes its own lock.
        yield* io(() => NodeFSP.mkdir(NodePath.dirname(input.directory), { recursive: true }));
        const compromised = yield* Deferred.make<never, ManagedReleaseRetentionError>();
        const services = yield* Effect.context<never>();
        yield* Effect.acquireRelease(
          io(() =>
            lock(`${input.directory}.releases`, {
              realpath: false,
              stale: 120_000,
              update: 10_000,
              retries: { retries: 80, factor: 1, minTimeout: 500, maxTimeout: 500 },
              onCompromised: (cause) =>
                Effect.runSyncWith(services)(
                  Deferred.fail(compromised, new ManagedReleaseRetentionError({ cause })),
                ),
            }),
          ),
          (release) => Effect.promise(() => release()).pipe(Effect.ignore),
        );
        return yield* Effect.raceFirst(task, Deferred.await(compromised));
      }),
    );

  const lease = (directory: string | null) =>
    io(async () => {
      if (directory === null) return () => Effect.void;
      const version = NodePath.basename(directory);
      if (!input.validName(version)) throw new Error("Invalid managed release lease");
      const info = await NodeFSP.lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new Error("Invalid managed release directory");
      const leases = NodePath.join(leaseRoot, version);
      await NodeFSP.mkdir(leases, { recursive: true, mode: 0o700 });
      const file = NodePath.join(leases, `${process.pid}-${NodeCrypto.randomUUID()}`);
      await NodeFSP.writeFile(file, "", { flag: "wx", mode: 0o600 });
      return () => io(() => NodeFSP.rm(file, { force: true })).pipe(Effect.ignore);
    });

  const leased = (version: string, dryRun = false) =>
    io(async () => {
      const lstat = (directory: string) =>
        NodeFSP.lstat(directory).catch((error: unknown) => {
          if (missing(error)) return null;
          throw error;
        });
      const rootInfo = await lstat(leaseRoot);
      if (rootInfo === null) return false;
      if (!rootInfo.isDirectory()) return true;
      const directory = NodePath.join(leaseRoot, version);
      const info = await lstat(directory);
      if (info === null) return false;
      if (!info.isDirectory() || info.isSymbolicLink()) return true;
      for (const name of await NodeFSP.readdir(directory)) {
        const match = /^(\d+)-[a-f0-9-]+$/u.exec(name);
        if (match === null || Number(match[1]) <= 1) return true;
        try {
          process.kill(Number(match[1]), 0);
          return true;
        } catch (error) {
          // Unknown owners and permission failures protect the release.
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) return true;
        }
        if (!dryRun) await NodeFSP.rm(NodePath.join(directory, name), { force: true });
      }
      return false;
    });
  const hasLeases = Effect.gen(function* () {
    const versions = yield* io(() =>
      NodeFSP.readdir(leaseRoot).catch((error: unknown) => {
        if (missing(error)) return [];
        throw error;
      }),
    );
    for (const version of versions) {
      if (!input.validName(version) || (yield* leased(version))) return true;
    }
    return false;
  });

  const rememberRollback = (previous: string | null, next: string) =>
    previous === null || previous === next || !input.validName(previous)
      ? Effect.void
      : io(() => NodeFSP.writeFile(rollbackPath, JSON.stringify(previous), { mode: 0o600 }));

  const prune = (dryRun = false) =>
    Effect.gen(function* () {
      const active = yield* input.active;
      if (active === null || !input.validName(active)) return;
      const rollback = yield* io(async () => {
        try {
          const raw = await NodeFSP.readFile(rollbackPath, "utf8");
          const parsed: unknown = JSON.parse(raw);
          return typeof parsed === "string" && input.validName(parsed) ? parsed : null;
        } catch (error) {
          if (missing(error) || error instanceof SyntaxError) return null;
          throw error;
        }
      });
      const result = yield* pruneManagedToolVersions({
        toolsDirectory: input.toolsDirectory ?? NodePath.dirname(input.directory),
        versionsDirectory: input.versionsDirectory,
        current: active,
        rollback: rollback ?? undefined,
        isVersion: input.validName,
        completed: input.completed,
        leased: (name) => leased(name, dryRun),
        dryRun,
      }).pipe(Effect.mapError((cause) => new ManagedReleaseRetentionError({ cause })));
      if (!dryRun) {
        for (const directory of result.candidates) {
          // Remove only empty lease directories. Their parents are separate from release files.
          yield* io(() =>
            NodeFSP.rmdir(NodePath.join(leaseRoot, NodePath.basename(directory))),
          ).pipe(Effect.ignore);
        }
      }
      return result;
    });

  return { withLock, lease, hasLeases, rememberRollback, prune };
}
