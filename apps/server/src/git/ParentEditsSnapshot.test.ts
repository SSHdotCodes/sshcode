import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { make, removeSnapshotDirectory } from "./ParentEditsSnapshot.ts";

const dependencies = Layer.mergeAll(
  ServerConfig.layerTest(process.cwd(), { prefix: "parent-edits-test-" }),
  ProcessRunner.layer,
  NodeCrypto.layer,
).pipe(Layer.provideMerge(NodeServices.layer));
const layer = GitVcsDriver.layer.pipe(Layer.provideMerge(dependencies));
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const runner = yield* ProcessRunner.ProcessRunner;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "parent-edits-repo-" });
  const git = (args: ReadonlyArray<string>, cwd = root) =>
    runner
      .run({
        command: "git",
        args,
        cwd,
        env: { GIT_OPTIONAL_LOCKS: "0" },
      })
      .pipe(
        Effect.map((r) => {
          assert.equal(r.code, 0);
          return r.stdout.trim();
        }),
      );
  yield* git(["init"]);
  yield* git(["config", "user.name", "Test"]);
  yield* git(["config", "user.email", "test@example.com"]);
  yield* fs.writeFileString(`${root}/tracked.txt`, "base\n");
  yield* fs.writeFileString(`${root}/deleted.txt`, "delete me\n");
  yield* fs.writeFileString(`${root}/.env`, "fixture base\n");
  yield* fs.writeFileString(`${root}/.gitignore`, "ignored/\nignored-tracked.txt\n");
  yield* fs.writeFileString(`${root}/ignored-tracked.txt`, "fixture base\n");
  yield* fs.writeFile(`${root}/binary.bin`, new Uint8Array([0, 255, 1, 128]));
  yield* git(["add", "-f", "."]);
  yield* git(["-c", "commit.gpgSign=false", "commit", "-m", "Base"]);
  return { fs, driver, root, git };
});

it.effect(
  "captures tracked, staged, deleted, binary and untracked edits without touching the parent",
  () =>
    Effect.gen(function* () {
      const { fs, driver, root, git } = yield* fixture;
      yield* fs.writeFileString(`${root}/tracked.txt`, "staged\n");
      yield* git(["add", "tracked.txt"]);
      yield* fs.writeFileString(`${root}/tracked.txt`, "staged\nand unstaged\n");
      yield* fs.remove(`${root}/deleted.txt`);
      const binary = new Uint8Array([0, 254, 127, 255, 128, 13]);
      yield* fs.writeFile(`${root}/binary.bin`, binary);
      yield* fs.writeFile(`${root}/new.bin`, binary);
      yield* fs.writeFileString(`${root}/odd ' name\n.txt`, "untracked\n");
      yield* fs.writeFileString(`${root}/empty.txt`, "");
      yield* fs.symlink("tracked.txt", `${root}/linked.txt`);
      yield* fs.writeFileString(`${root}/run.sh`, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      yield* fs.writeFile(`${root}/invalid-utf8.txt`, new Uint8Array([255, 254, 10]));
      const skipped = [
        ".env",
        ".env.local",
        "private.pem",
        "private.key",
        "id_rsa.pub",
        "credentials.json",
        "aws-credentials.json",
        "ignored-tracked.txt",
      ];
      for (const file of skipped)
        yield* fs.writeFileString(`${root}/${file}`, "fixture confidential\n");
      yield* fs.makeDirectory(`${root}/ignored`);
      yield* fs.writeFileString(`${root}/ignored/file.txt`, "ignored\n");
      const head = yield* git(["rev-parse", "HEAD"]);
      const index = yield* fs.readFile(`${root}/.git/index`);
      const status = yield* git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
      const snapshot = yield* driver.captureParentEdits(root);
      yield* Effect.addFinalizer(() =>
        fs.remove(snapshot.directory, { recursive: true }).pipe(Effect.ignore),
      );
      assert.equal(snapshot.baseCommit, head);
      assert.match(snapshot.fingerprint, /^[0-9a-f]{64}$/);
      assert.sameMembers([...snapshot.skippedPaths], skipped);
      const again = yield* driver.captureParentEdits(root);
      yield* Effect.addFinalizer(() =>
        fs.remove(again.directory, { recursive: true }).pipe(Effect.orDie),
      );
      assert.equal(again.fingerprint, snapshot.fingerprint);
      assert.deepEqual(yield* fs.readFile(`${root}/.git/index`), index);
      assert.equal(yield* git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]), status);
      assert.equal(yield* git(["rev-parse", "HEAD"]), head);

      const child = `${root}-child`;
      yield* git(["worktree", "add", "--detach", child, snapshot.baseCommit]);
      yield* Effect.addFinalizer(() =>
        git(["worktree", "remove", "--force", child]).pipe(Effect.ignore),
      );
      const snapshotCommit = yield* driver.applyParentEdits(snapshot.directory, child);
      assert.isFalse(yield* fs.exists(snapshot.directory));
      assert.equal(yield* git(["rev-parse", "HEAD^"], child), head);
      assert.equal(
        yield* git(["log", "-1", "--format=%s"], child),
        "Parent's uncommitted changes (snapshot)",
      );
      assert.equal(yield* fs.readFileString(`${child}/tracked.txt`), "staged\nand unstaged\n");
      assert.isFalse(yield* fs.exists(`${child}/deleted.txt`));
      assert.deepEqual(yield* fs.readFile(`${child}/binary.bin`), binary);
      assert.deepEqual(yield* fs.readFile(`${child}/new.bin`), binary);
      assert.deepEqual(
        yield* fs.readFile(`${child}/invalid-utf8.txt`),
        new Uint8Array([255, 254, 10]),
      );
      assert.equal(yield* fs.readFileString(`${child}/odd ' name\n.txt`), "untracked\n");
      assert.include(yield* git(["ls-files", "--stage", "run.sh"], child), "100755");
      assert.equal(yield* fs.readFileString(`${child}/empty.txt`), "");
      assert.equal(yield* fs.readLink(`${child}/linked.txt`), "tracked.txt");
      assert.equal(yield* fs.readFileString(`${child}/.env`), "fixture base\n");
      assert.equal(yield* fs.readFileString(`${child}/ignored-tracked.txt`), "fixture base\n");
      for (const file of skipped.filter((file) => ![".env", "ignored-tracked.txt"].includes(file)))
        assert.isFalse(yield* fs.exists(`${child}/${file}`));
      assert.isFalse(yield* fs.exists(`${child}/ignored/file.txt`));
      assert.equal(yield* git(["status", "--porcelain"], child), "");
      yield* fs.writeFileString(`${child}/child.txt`, "child work\n");
      yield* git(["add", "child.txt"], child);
      yield* git(["-c", "commit.gpgSign=false", "commit", "-m", "Child work"], child);
      assert.equal(
        yield* git(["log", "--format=%s", `${snapshotCommit}..HEAD`], child),
        "Child work",
      );
      assert.equal(yield* git(["rev-parse", "HEAD"]), head);
      assert.deepEqual(yield* fs.readFile(`${root}/.git/index`), index);
    }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("removes an incomplete snapshot when the manifest cannot be written", () =>
  Effect.gen(function* () {
    const { root, fs } = yield* fixture;
    const directory = yield* fs.makeTempDirectoryScoped();
    const snapshots = yield* make.pipe(
      Effect.provideService(FileSystem.FileSystem, {
        ...fs,
        makeTempDirectory: (options) => fs.makeTempDirectory({ ...options, directory }),
        writeFileString: (_path, content) =>
          fs.writeFileString(`${directory}/missing/manifest.json`, content),
      }),
    );
    const error = yield* snapshots.capture(root).pipe(Effect.flip);
    assert.equal(error.reason, "io");
    assert.deepEqual(yield* fs.readDirectory(directory), []);
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses oversized contents and patches, and detects a damaged snapshot", () =>
  Effect.gen(function* () {
    const { fs, driver, root, git } = yield* fixture;
    const large = `${root}/large.bin`;
    yield* fs.writeFile(large, new Uint8Array(25 * 1024 * 1024 + 1));
    const error = yield* driver.captureParentEdits(root).pipe(Effect.flip);
    assert.equal(error.reason, "size");
    assert.include(error.message, "25 MB");
    yield* fs.remove(large);
    // Contents fit exactly; patch framing pushes the transmitted snapshot over the cap.
    yield* fs.writeFile(large, new Uint8Array(25 * 1024 * 1024).fill(65));
    assert.equal((yield* driver.captureParentEdits(root).pipe(Effect.flip)).reason, "size");
    yield* fs.remove(large);
    const snapshot = yield* driver.captureParentEdits(root);
    yield* Effect.addFinalizer(() =>
      fs.remove(snapshot.directory, { recursive: true }).pipe(Effect.ignore),
    );
    yield* fs.writeFileString(`${snapshot.directory}/snapshot.patch`, "damaged");
    const failure = yield* driver.applyParentEdits(snapshot.directory, root).pipe(Effect.flip);
    assert.equal(failure.reason, "integrity");
    assert.equal(yield* git(["status", "--porcelain"]), "");
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.effect("separates a staged removal and re-created untracked file into one snapshot commit", () =>
  Effect.gen(function* () {
    const { fs, driver, root, git } = yield* fixture;
    yield* git(["rm", "--cached", "tracked.txt"]);
    yield* fs.writeFileString(`${root}/tracked.txt`, "replacement\n");
    const index = yield* fs.readFile(`${root}/.git/index`);
    const snapshot = yield* driver.captureParentEdits(root);
    yield* Effect.addFinalizer(() =>
      fs.remove(snapshot.directory, { recursive: true }).pipe(Effect.ignore),
    );
    const child = `${root}-child`;
    yield* git(["worktree", "add", "--detach", child, snapshot.baseCommit]);
    yield* Effect.addFinalizer(() =>
      git(["worktree", "remove", "--force", child]).pipe(Effect.ignore),
    );
    yield* driver.applyParentEdits(snapshot.directory, child);
    assert.equal(yield* fs.readFileString(`${child}/tracked.txt`), "replacement\n");
    assert.equal(yield* git(["status", "--porcelain"], child), "");
    assert.deepEqual(yield* fs.readFile(`${root}/.git/index`), index);
  }).pipe(Effect.provide(layer), Effect.scoped),
);

it.layer(NodeServices.layer)("removeSnapshotDirectory", (it) => {
  it.effect("removes only folders the snapshot capture created", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const snapshot = yield* fs.makeTempDirectory({ prefix: "t3-parent-edits-" });
      const other = yield* fs.makeTempDirectory({ prefix: "not-a-snapshot-" });
      yield* removeSnapshotDirectory(fs, snapshot);
      yield* removeSnapshotDirectory(fs, other);
      assert.isFalse(yield* fs.exists(snapshot));
      assert.isTrue(yield* fs.exists(other));
      yield* fs.remove(other, { recursive: true });
    }),
  );
});
