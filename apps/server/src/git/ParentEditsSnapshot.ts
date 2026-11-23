import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const MAX_BYTES = 25 * 1024 * 1024;
const Manifest = Schema.Struct({
  baseCommit: Schema.String,
  fingerprint: Schema.String,
  skippedPaths: Schema.Array(Schema.String),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const encodeManifest = Schema.encodeEffect(Schema.fromJsonString(Manifest));
export type ParentEditsSnapshot = typeof Manifest.Type & { readonly directory: string };

export class ParentEditsSnapshotError extends Schema.TaggedError<ParentEditsSnapshotError>()(
  "ParentEditsSnapshotError",
  {
    reason: Schema.Literals(["size", "git", "changed", "integrity", "io"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    switch (this.reason) {
      case "size":
        return "Parent edits snapshot exceeds the 25 MB limit. Reduce the changes before delegating.";
      case "changed":
        return "Parent HEAD changed during snapshot capture. Retry delegation.";
      case "integrity":
        return "Parent edits snapshot is damaged or does not match the subagent's base commit.";
      default:
        return "Could not capture or apply the parent edits snapshot.";
    }
  }
}

export const isParentEditsSnapshotError = Schema.is(ParentEditsSnapshotError);

// Disable hooks and signing: a snapshot must not run project code or require signing credentials.
export const snapshotCommitArgs = (hooksPath: string) => [
  "-c",
  `core.hooksPath=${hooksPath}`,
  "-c",
  "commit.gpgSign=false",
  "-c",
  "user.name=SSHCode",
  "-c",
  "user.email=snapshot@sshcode.local",
  "commit",
  "--allow-empty",
  "-m",
  "Parent's uncommitted changes (snapshot)",
];

const secretPath = (file: string) =>
  file
    .split("/")
    .some((part) =>
      /^(?:\.env(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519).*|.*\.(?:pem|key|p12|pfx)|(?:.*[._-])?credentials(?:[._-].*)?)$/is.test(
        part,
      ),
    );

/** Implementation behind GitVcsDriver, with no parent mutations. */
export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const protect = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isParentEditsSnapshotError(cause)
          ? cause
          : new ParentEditsSnapshotError({ reason: "io", cause }),
      ),
    );
  const run = (
    cwd: string,
    args: ReadonlyArray<string>,
    maximum = MAX_BYTES,
    stdin?: string,
    allowOne = false,
  ) =>
    protect(
      Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            ChildProcess.make("git", args, {
              cwd,
              env: { GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "0" },
              extendEnv: true,
              stdin: stdin === undefined ? "ignore" : Stream.make(new TextEncoder().encode(stdin)),
              stdout: "pipe",
              stderr: "ignore",
            }),
          );
          const chunks: Array<Uint8Array> = [];
          let size = 0;
          yield* child.stdout.pipe(
            Stream.runForEach((chunk) => {
              size += chunk.byteLength;
              return size > maximum
                ? Effect.fail(new ParentEditsSnapshotError({ reason: "size", cause: undefined }))
                : Effect.sync(() => {
                    chunks.push(chunk);
                  });
            }),
          );
          const code = yield* child.exitCode;
          if (code !== 0 && !(allowOne && code === 1))
            return yield* new ParentEditsSnapshotError({ reason: "git", cause: undefined });
          const result = new Uint8Array(size);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.byteLength;
          }
          return result;
        }),
      ).pipe(Effect.timeout("2 minutes")),
    );
  const text = (cwd: string, args: ReadonlyArray<string>) =>
    run(cwd, args).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes).trim()));
  const fingerprint = (base: string, patch: Uint8Array) =>
    Effect.gen(function* () {
      const prefix = new TextEncoder().encode(`${base}\0`);
      const bytes = new Uint8Array(prefix.byteLength + patch.byteLength);
      bytes.set(prefix);
      bytes.set(patch, prefix.byteLength);
      return Hex.encode(yield* crypto.digest("SHA-256", bytes));
    });
  const read = (directory: string) =>
    protect(
      Effect.gen(function* () {
        const manifest = yield* fs
          .readFileString(path.join(directory, "manifest.json"))
          .pipe(Effect.flatMap(decodeManifest));
        if (Number((yield* fs.stat(path.join(directory, "snapshot.patch"))).size) > MAX_BYTES)
          return yield* new ParentEditsSnapshotError({ reason: "size", cause: undefined });
        const patch = yield* fs.readFile(path.join(directory, "snapshot.patch"));
        if ((yield* fingerprint(manifest.baseCommit, patch)) !== manifest.fingerprint)
          return yield* new ParentEditsSnapshotError({ reason: "integrity", cause: undefined });
        return { ...manifest, directory };
      }),
    );
  return {
    read,
    capture: (cwd: string) =>
      protect(
        Effect.gen(function* () {
          const root = yield* text(cwd, ["rev-parse", "--show-toplevel"]);
          const baseCommit = yield* text(root, ["rev-parse", "HEAD"]);
          const split = (bytes: Uint8Array) =>
            new TextDecoder().decode(bytes).split("\0").filter(Boolean);
          const tracked = split(
            yield* run(root, ["diff", "--name-only", "--no-renames", "-z", baseCommit, "--"]),
          );
          const untracked = split(
            yield* run(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
          );
          const candidates = [...new Set([...tracked, ...untracked])].sort();
          const ignored = new Set(
            candidates.length === 0
              ? []
              : split(
                  yield* run(
                    root,
                    ["check-ignore", "--no-index", "-z", "--stdin"],
                    MAX_BYTES,
                    `${candidates.join("\0")}\0`,
                    true,
                  ),
                ),
          );
          const skippedPaths = candidates.filter((file) => ignored.has(file) || secretPath(file));
          const skipped = new Set(skippedPaths);
          const safeTracked = tracked.filter((file) => !skipped.has(file));
          let contentBytes = 0;
          for (const file of candidates.filter((file) => !skipped.has(file))) {
            if (yield* fs.exists(path.join(root, file))) {
              contentBytes += Number((yield* fs.stat(path.join(root, file))).size);
              if (contentBytes > MAX_BYTES)
                return yield* new ParentEditsSnapshotError({ reason: "size", cause: undefined });
            }
          }
          const parts: Array<Uint8Array> = [];
          let size = 0;
          const append = (part: Uint8Array) => {
            parts.push(part);
            size += part.byteLength;
          };
          const diffArgs = [
            "--binary",
            "--full-index",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
          ];
          // Per-path diffs avoid command-line length limits and keep skipped file contents out of memory.
          for (const file of safeTracked)
            append(
              yield* run(
                root,
                ["diff", ...diffArgs, baseCommit, "--", `:(literal)${file}`],
                MAX_BYTES - size,
              ),
            );
          for (const file of untracked.filter((file) => !skipped.has(file))) {
            append(
              yield* run(
                root,
                ["diff", ...diffArgs, "--no-index", "--", "/dev/null", file],
                MAX_BYTES - size,
                undefined,
                true,
              ),
            );
          }
          if ((yield* text(root, ["rev-parse", "HEAD"])) !== baseCommit)
            return yield* new ParentEditsSnapshotError({ reason: "changed", cause: undefined });
          const patch = new Uint8Array(size);
          let offset = 0;
          for (const part of parts) {
            patch.set(part, offset);
            offset += part.byteLength;
          }
          const manifest = {
            baseCommit,
            fingerprint: yield* fingerprint(baseCommit, patch),
            skippedPaths,
          };
          // Only this small path is persisted in orchestration, never the potentially large patch.
          return yield* Effect.acquireUseRelease(
            fs.makeTempDirectory({ prefix: "t3-parent-edits-" }),
            (directory) =>
              Effect.gen(function* () {
                yield* fs.chmod(directory, 0o700);
                yield* fs.writeFile(path.join(directory, "snapshot.patch"), patch, { mode: 0o600 });
                yield* fs.writeFileString(
                  path.join(directory, "manifest.json"),
                  yield* encodeManifest(manifest),
                  { mode: 0o600 },
                );
                return { ...manifest, directory };
              }),
            (directory, exit) =>
              Exit.isFailure(exit) ? removeSnapshotDirectory(fs, directory) : Effect.void,
          );
        }),
      ),
    apply: (directory: string, cwd: string) =>
      protect(
        Effect.gen(function* () {
          const snapshot = yield* read(directory);
          if ((yield* text(cwd, ["rev-parse", "HEAD"])) !== snapshot.baseCommit)
            return yield* new ParentEditsSnapshotError({ reason: "integrity", cause: undefined });
          if (Number((yield* fs.stat(path.join(directory, "snapshot.patch"))).size) > 0)
            yield* run(cwd, [
              "apply",
              "--index",
              "--binary",
              path.join(directory, "snapshot.patch"),
            ]);
          yield* run(cwd, snapshotCommitArgs(directory));
          const head = yield* text(cwd, ["rev-parse", "HEAD"]);
          // Applied and committed: the worktree now holds the edits.
          yield* removeSnapshotDirectory(fs, directory);
          return head;
        }),
      ),
  };
});

/** Drops a used snapshot. Only removes folders this module created, never a caller-supplied path. */
export const removeSnapshotDirectory = (fs: FileSystem.FileSystem, directory: string) =>
  /(?:^|\/)t3-parent-edits-[^/]+\/?$/.test(directory)
    ? fs.remove(directory, { recursive: true }).pipe(Effect.ignore)
    : Effect.void;

export const snapshotNotice = (snapshot: ParentEditsSnapshot) =>
  `The subagent started from the parent's edits (snapshot ${snapshot.fingerprint}).${snapshot.skippedPaths.length ? ` Skipped secret or ignored paths: ${snapshot.skippedPaths.join(", ")}.` : ""}`;
