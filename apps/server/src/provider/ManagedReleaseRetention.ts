// @effect-diagnostics nodeBuiltinImport:off -- Filesystem leases coordinate independent server processes.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { lock } from "proper-lockfile";
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

  const leased = (version: string) =>
    io(async () => {
      const directory = NodePath.join(leaseRoot, version);
      const info = await NodeFSP.lstat(directory).catch((error: unknown) => {
        if (missing(error)) return null;
        throw error;
      });
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
        await NodeFSP.rm(NodePath.join(directory, name), { force: true });
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

  const prune = Effect.gen(function* () {
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
    const candidates: Array<{ readonly name: string; readonly modified: number }> = [];
    const names = yield* io(() => NodeFSP.readdir(input.versionsDirectory));
    for (const name of names) {
      if (!input.validName(name)) continue;
      const info = yield* io(() => NodeFSP.lstat(NodePath.join(input.versionsDirectory, name)));
      if (!info.isDirectory() || info.isSymbolicLink() || !(yield* input.completed(name))) continue;
      candidates.push({ name, modified: info.mtimeMs });
    }
    const previous =
      candidates.find(({ name }) => name === rollback && name !== active) ??
      candidates
        .filter(({ name }) => name !== active)
        .sort((a, b) => b.modified - a.modified || a.name.localeCompare(b.name))[0];
    for (const { name } of candidates) {
      if (name === active || name === previous?.name || (yield* leased(name))) continue;
      // Acquisition and activation take the same lock, so neither can race deletion.
      yield* io(() =>
        NodeFSP.rm(NodePath.join(input.versionsDirectory, name), { recursive: true, force: true }),
      );
      yield* io(() => NodeFSP.rm(NodePath.join(leaseRoot, name), { recursive: true, force: true }));
    }
  });
  return { withLock, lease, hasLeases, rememberRollback, prune };
}
