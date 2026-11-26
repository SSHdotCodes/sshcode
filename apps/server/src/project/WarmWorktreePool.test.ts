import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import { WARM_WORKTREES_DIRECTORY, warmWorktreeRecordName } from "../worktreesDirectory.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";
import * as WarmWorktreePool from "./WarmWorktreePool.ts";

const testOnly = it.effect.skipIf(HostProcess.Platform.defaultValue() === "win32");
const projectId = ProjectId.make("warm-project");
const nodeCommand = `"${process.execPath}" setup.mjs`;
const setupScript = `
  import * as fs from "node:fs";
  import * as path from "node:path";
  const phase = process.env.T3CODE_WORKTREE_SETUP_CACHE;
  const root = process.env.T3CODE_PROJECT_ROOT;
  if (phase !== "reuse") {
    fs.mkdirSync("node_modules/pkg", { recursive: true });
    fs.writeFileSync("node_modules/pkg/version", fs.readFileSync("pnpm-lock.yaml"));
    fs.symlinkSync(path.resolve("node_modules/pkg/version"), "node_modules/absolute-launcher");
    fs.appendFileSync(path.join(root, "installs"), (phase || "cold") + "\\n");
  }
  if (phase !== "prepare") {
    if (phase === "reuse" && fs.existsSync(path.join(root, "reject-reuse"))) process.exit(1);
    fs.symlinkSync(path.join(root, "project-local"), "configured");
  }
`;

const gitTestLayer = Layer.effect(
  GitVcsDriver.GitVcsDriver,
  Effect.gen(function* () {
    const git = yield* GitVcsDriver.GitVcsDriver;
    return GitVcsDriver.GitVcsDriver.of({
      ...git,
      execute: (input) =>
        git.execute({
          ...input,
          env: { ...input.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
        }),
    });
  }),
).pipe(Layer.provide(GitVcsDriver.layer));

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repo = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-warm-repo-" }));
  const config = yield* ServerConfig.ServerConfig;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const poolRoot = path.join(yield* fs.realPath(config.worktreesDir), WARM_WORKTREES_DIRECTORY);
  const runGit = (cwd: string, args: string[]) =>
    git
      .execute({ operation: "WarmWorktreePool.test.git", cwd, args })
      .pipe(Effect.map(({ stdout }) => stdout.trimEnd()));
  const write = (cwd: string, file: string, content: string) =>
    fs.writeFileString(path.join(cwd, file), content);
  const read = (cwd: string, file: string) => fs.readFileString(path.join(cwd, file));
  const commit = (cwd: string) => runGit(cwd, ["rev-parse", "HEAD"]);
  const branch = (cwd: string) => runGit(cwd, ["branch", "--show-current"]);
  const recordFile = (slot: string) => warmWorktreeRecordName(path.basename(slot));
  const slots = () =>
    fs
      .readDirectory(poolRoot)
      .pipe(
        Effect.map((entries) =>
          entries
            .filter((p) => p.endsWith(".pool.json"))
            .map((p) =>
              p.startsWith("recycled-")
                ? path.join(path.dirname(poolRoot), decodeURIComponent(p.slice(9, -10)))
                : path.join(poolRoot, p.slice(0, -".pool.json".length)),
            ),
        ),
      );
  const registered = (cwd: string) => runGit(cwd, ["worktree", "list", "--porcelain"]);
  const projects = new Map([[projectId, repo]]);
  const init = Effect.fnUntraced(function* (cwd: string) {
    yield* runGit(cwd, ["init", "--initial-branch=main", "-q"]);
    yield* runGit(cwd, ["config", "user.email", "fixture@example.test"]);
    yield* runGit(cwd, ["config", "user.name", "Fixture"]);
    yield* Effect.all(
      [
        write(
          cwd,
          "t3.json",
          JSON.stringify({
            worktreeSetupCache: { inputs: ["**/pnpm-lock.yaml", "setup.mjs"] },
            scripts: [{ name: "Setup", command: nodeCommand, runOnWorktreeCreate: true }],
          }),
        ),
        write(cwd, "setup.mjs", setupScript),
        write(cwd, "pnpm-lock.yaml", "v1"),
        write(cwd, ".gitignore", "node_modules/\nconfigured\n"),
        write(cwd, "project-local", "local fixture"),
        write(cwd, "README.md", "original"),
        write(cwd, "UNCHANGED.txt", "keep its mtime"),
      ],
      { concurrency: "unbounded" },
    );
    yield* runGit(cwd, ["add", "."]);
    yield* runGit(cwd, ["commit", "-qm", "initial"]);
  });
  yield* init(repo);

  let setupBusy = false;
  let hostBusy = false;
  let freeBytes: number | null = 20 * 1024 ** 3;
  const published = new Map<ThreadId, string>();
  const env = yield* HostProcess.Environment;
  const makePool = (perRepo = "1") =>
    WarmWorktreePool.make({
      hostIdle: Effect.sync(() => !hostBusy),
      availableBytes: () => Effect.sync(() => freeBytes),
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            listShells: () => Effect.succeed([]),
            getById: (id) =>
              Effect.succeed(Option.fromNullishOr(projects.get(id))).pipe(
                Effect.map(
                  Option.map((cwd) => ({
                    id,
                    workspaceRoot: cwd,
                    title: "Fixture",
                    scripts: [],
                    repositoryIdentity: null,
                    faviconPath: null,
                    defaultModelSelection: null,
                    createdAt: "2000-01-01T00:00:00.000Z",
                    updatedAt: "2000-01-01T00:00:00.000Z",
                    deletedAt: null,
                  })),
                ),
              ),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadWorktreePaths: () =>
              Effect.sync(() =>
                [...published].map(([threadId, worktreePath]) => ({ threadId, worktreePath })),
              ),
            getThreadShell: (id) =>
              Effect.sync(() => {
                const worktreePath = published.get(id);
                return worktreePath ? ({ worktreePath } as OrchestrationV2ThreadShell) : null;
              }),
          }),
          Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
            whenIdle: (task) =>
              Effect.suspend(() => (setupBusy ? Effect.void : task.pipe(Effect.asVoid))),
          }),
          ServerSettings.layerTest(),
          NodeCrypto.layer,
        ),
      ),
      Effect.provideService(HostProcess.Environment, {
        ...env,
        SHELL: "/bin/sh",
        T3CODE_WARM_WORKTREES_PER_REPO: perRepo,
      }),
    );
  const userRequest = (
    name: string,
    overrides?: { cwd?: string; projectId?: ProjectId; ref?: string },
  ) => ({
    cwd: repo,
    ref: "HEAD",
    baseRef: "main",
    branch: name,
    threadId: ThreadId.make(name),
    projectId,
    onClaimed: () => {},
    ...overrides,
  });
  const cold = Effect.fnUntraced(function* (name: string) {
    const { worktree } = yield* git.createWorktree({
      cwd: repo,
      refName: "HEAD",
      newRefName: name,
      path: null,
      baseRefName: "main",
    });
    const status = yield* spawner.exitCode(
      ChildProcess.make(process.execPath, ["setup.mjs"], {
        cwd: worktree.path,
        extendEnv: true,
        env: { T3CODE_PROJECT_ROOT: repo, T3CODE_WORKTREE_SETUP_CACHE: "" },
      }),
    );
    assert.equal(status, 0);
    return yield* fs.realPath(worktree.path);
  });
  const workflow = (pool: WarmWorktreePool.WarmWorktreePool["Service"]) =>
    GitWorkflowService.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(GitManager.GitManager)({}),
          Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
            resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
          }),
          Layer.succeed(WarmWorktreePool.WarmWorktreePool, pool),
        ),
      ),
    );
  return {
    fs,
    path,
    repo,
    poolRoot,
    git,
    runGit,
    write,
    read,
    commit,
    branch,
    slots,
    recordFile,
    registered,
    published,
    projects,
    makePool,
    userRequest,
    cold,
    workflow,
    init,
    setBusy: (host: boolean, setup: boolean) => {
      hostBusy = host;
      setupBusy = setup;
    },
    setFree: (bytes: number | null) => {
      freeBytes = bytes;
    },
  };
});

const layer = gitTestLayer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-warm-state-" })),
  Layer.provideMerge(NodeServices.layer),
);

testOnly(
  "claims a clean checkout at the requested commit exactly once and preserves absolute dependency paths",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      // SSHCode has a relative Vite dispatcher and enables worktree config in the common repo.
      yield* f.runGit(f.repo, ["config", "core.hooksPath", ".vite-hooks/_"]);
      yield* f.runGit(f.repo, ["config", "extensions.worktreeConfig", "true"]);
      const pool = yield* f.makePool();
      assert.isNull(yield* pool.claim(f.userRequest("first")));
      const cold = yield* f.cold("first");
      yield* pool.maintain;
      const [ready] = yield* f.slots();
      assert.isDefined(ready);
      assert.equal(yield* f.branch(ready!), "");
      assert.notInclude(yield* f.git.listWorktreePaths(f.repo), ready);
      assert.isNull(yield* pool.claim(f.userRequest("first")));
      assert.deepEqual(yield* f.slots(), [ready]);

      yield* f.write(ready!, "README.md", "dirty");
      yield* f.runGit(ready!, ["add", "README.md"]);
      yield* f.write(ready!, "configured", "ignored stale setup artifact");
      yield* f.write(ready!, "stray", "untracked");
      yield* f.write(f.repo, "README.md", "updated");
      yield* f.runGit(f.repo, ["commit", "-qam", "code change only"]);
      const commit = yield* f.commit(f.repo);

      const leases = yield* Effect.all(
        [
          pool.claim(f.userRequest("second", { ref: "main" })),
          pool.claim(f.userRequest("third", { ref: commit })),
        ],
        { concurrency: 2 },
      );
      const lease = leases.find((lease) => lease !== null);
      assert.isNotNull(lease);
      assert.lengthOf(leases.filter(Boolean), 1);
      assert.equal(lease!.path, ready);
      assert.notInclude(yield* f.git.listWorktreePaths(f.repo), ready);
      assert.equal(yield* f.commit(lease!.path), commit);
      assert.equal(yield* f.branch(lease!.path), leases[0] ? "second" : "third");
      assert.equal(yield* f.runGit(lease!.path, ["status", "--porcelain=v1"]), "");
      assert.equal(yield* f.read(lease!.path, "README.md"), "updated");
      assert.equal(yield* f.read(lease!.path, "node_modules/absolute-launcher"), "v1");
      assert.equal(yield* f.read(lease!.path, "configured"), "local fixture");
      assert.equal(yield* f.read(f.repo, "installs"), "cold\nprepare\n");
      assert.sameMembers(yield* f.fs.readDirectory(lease!.path), yield* f.fs.readDirectory(cold));
      assert.equal(
        yield* f.runGit(f.repo, [
          "config",
          "--get",
          `branch.${yield* f.branch(lease!.path)}.gh-merge-base`,
        ]),
        "main",
      );

      yield* lease!.publish;
      assert.include(yield* f.git.listWorktreePaths(f.repo), ready);
      assert.lengthOf(yield* f.slots(), 0);
      yield* pool.maintain;
      assert.notInclude(yield* f.slots(), ready);
      assert.equal(yield* f.read(lease!.path, "node_modules/absolute-launcher"), "v1");
    }).pipe(Effect.provide(layer)),
);

testOnly("refills the spare after its installed dependencies go missing", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const pool = yield* f.makePool();
    assert.isNull(yield* pool.claim(f.userRequest("first")));
    yield* pool.maintain;
    const [slot] = yield* f.slots();
    assert.isDefined(slot);
    yield* f.fs.remove(f.path.join(slot!, "node_modules"), { recursive: true });
    assert.isNull(yield* pool.claim(f.userRequest("missing-deps")));
    yield* pool.maintain;
    assert.isFalse(yield* f.fs.exists(slot!));
    const claim = yield* pool.claim(f.userRequest("rebuilt"));
    assert.isNotNull(claim);
    assert.equal(yield* f.read(claim!.path, "node_modules/absolute-launcher"), "v1");
    yield* claim!.publish;
  }).pipe(Effect.provide(layer)),
);

testOnly(
  "refreshes only changed tracked files, while changed dependency inputs cause a cold fallback and a rebuild",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const pool = yield* f.makePool();
      assert.isNull(yield* pool.claim(f.userRequest("first")));
      yield* pool.maintain;
      const [slot] = yield* f.slots();
      assert.isDefined(slot);
      const unchanged = f.path.join(slot!, "UNCHANGED.txt");
      yield* f.fs.utimes(unchanged, 100, 100);
      yield* f.write(f.repo, "README.md", "new version");
      yield* f.runGit(f.repo, ["commit", "-qam", "source only"]);
      // A revision expression remembers the newer base without consuming the slot.
      assert.isNull(yield* pool.claim(f.userRequest("next", { ref: "HEAD~0" })));
      yield* pool.maintain;
      assert.equal(yield* f.read(slot!, "README.md"), "new version");
      assert.equal(Option.getOrThrow((yield* f.fs.stat(unchanged)).mtime).getTime(), 100_000);
      assert.equal(yield* f.read(f.repo, "installs"), "prepare\n");

      yield* f.write(f.repo, "pnpm-lock.yaml", "v2");
      yield* f.runGit(f.repo, ["commit", "-qam", "lockfile changed"]);
      assert.isNull(yield* pool.claim(f.userRequest("new-deps")));
      const cold = yield* f.cold("new-deps");
      assert.equal(yield* f.read(cold, "node_modules/absolute-launcher"), "v2");
      yield* pool.maintain;
      assert.deepEqual(yield* f.slots(), [slot]);
      assert.equal(yield* f.read(slot!, "node_modules/absolute-launcher"), "v2");
      assert.equal(yield* f.read(f.repo, "installs"), "prepare\ncold\nprepare\n");
    }).pipe(Effect.provide(layer)),
);

testOnly(
  "caps ready checkouts across repositories and evicts on pressure and expiry through Git",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const pool = yield* f.makePool("2");
      assert.isNull(yield* pool.claim(f.userRequest("first")));
      f.setBusy(true, false);
      yield* pool.maintain;
      f.setBusy(false, true);
      yield* pool.maintain;
      assert.lengthOf(yield* f.slots(), 0);
      f.setBusy(false, false);
      yield* pool.maintain;
      yield* pool.maintain;
      yield* pool.maintain;
      const initialSlots = yield* f.slots();
      assert.lengthOf(initialSlots, 2);

      const other = yield* f.fs.realPath(
        yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-warm-other-" }),
      );
      const otherId = ProjectId.make("warm-other");
      f.projects.set(otherId, other);
      yield* f.init(other);
      yield* TestClock.adjust("1 second");
      assert.isNull(yield* pool.claim(f.userRequest("other", { cwd: other, projectId: otherId })));
      yield* pool.maintain;
      const kept = yield* f.slots();
      assert.lengthOf(kept, 2);
      const evicted = initialSlots.find((slot) => !kept.includes(slot))!;
      assert.isFalse(yield* f.fs.exists(evicted));
      assert.notInclude(yield* f.registered(f.repo), evicted);

      f.setFree(5 * 1024 ** 3);
      yield* pool.maintain;
      assert.lengthOf(yield* f.slots(), 0);
      for (const slot of kept) assert.isFalse(yield* f.fs.exists(slot));
      f.setFree(20 * 1024 ** 3);
      yield* pool.maintain;
      const [stale] = yield* f.slots();
      assert.isDefined(stale);
      yield* TestClock.adjust("8 days");
      // A busy server may not have swept yet. An expired slot still cannot be claimed.
      assert.isNull(
        yield* pool.claim(f.userRequest("expired", { cwd: other, projectId: otherId })),
      );
      yield* pool.maintain;
      assert.notInclude(yield* f.slots(), stale);
      assert.notInclude(yield* f.registered(other), stale);
    }).pipe(Effect.provide(layer)),
);

testOnly(
  "falls back cleanly when the reuse phase fails, without leaving a branch or checkout",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const pool = yield* f.makePool();
      assert.isNull(yield* pool.claim(f.userRequest("first")));
      yield* pool.maintain;
      const [slot] = yield* f.slots();
      assert.isDefined(slot);
      yield* f.write(f.repo, "reject-reuse", "");
      assert.isNull(yield* pool.claim(f.userRequest("retry-cold")));
      assert.notInclude(yield* f.git.listLocalBranchNames(f.repo), "retry-cold");
      assert.notInclude(yield* f.registered(f.repo), slot);
      const cold = yield* f.cold("retry-cold");
      assert.equal(yield* f.branch(cold), "retry-cold");
      assert.equal(yield* f.read(cold, "configured"), "local fixture");
    }).pipe(Effect.provide(layer)),
);

testOnly("recovers interrupted fills and claims while honoring a durable thread workspace", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const gitDir = yield* f.fs.realPath(f.path.join(f.repo, ".git"));
    const { abandoned, committed } = yield* Effect.gen(function* () {
      const pool = yield* f.makePool("2");
      assert.isNull(yield* pool.claim(f.userRequest("first")));
      yield* pool.maintain;
      yield* pool.maintain;
      const abandoned = yield* pool.claim(f.userRequest("abandoned"));
      const committed = yield* pool.claim(f.userRequest("committed"));
      assert.isNotNull(abandoned);
      assert.isNotNull(committed);
      f.published.set(ThreadId.make("committed"), committed!.path);
      // Both claims are on disk. Simulate abrupt loss of their in-memory leases.
      return { abandoned: abandoned!.path, committed: committed!.path };
    }).pipe(Effect.scoped);
    const filling = f.path.join(f.poolRoot, "11111111-1111-4111-8111-111111111111");
    yield* f.write(f.poolRoot, f.recordFile(filling), JSON.stringify({ gitDir }));
    yield* f.runGit(f.repo, ["worktree", "add", "--detach", filling, "HEAD"]);
    yield* f.write(filling, "incomplete", "");
    const restarted = yield* f.makePool();
    yield* restarted.maintain;

    assert.isFalse(yield* f.fs.exists(filling));
    assert.isFalse(yield* f.fs.exists(abandoned));
    assert.notInclude(yield* f.registered(f.repo), abandoned);
    assert.notInclude(yield* f.git.listLocalBranchNames(f.repo), "abandoned");
    assert.include(yield* f.git.listWorktreePaths(f.repo), committed);
    assert.equal(yield* f.branch(committed), "committed");
    assert.equal(yield* f.read(committed, "configured"), "local fixture");
  }).pipe(Effect.provide(layer)),
);

testOnly(
  "recycles a released cold or warm checkout in place and keeps its installed dependencies",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const pool = yield* f.makePool();
      const workflow = yield* f.workflow(pool);
      assert.isNull(yield* pool.claim(f.userRequest("cold")));
      const checkout = yield* f.cold("cold");
      const base = yield* f.commit(f.repo);
      yield* pool.recordSetup({
        cwd: f.repo,
        projectId,
        worktreePath: checkout,
        command: nodeCommand,
      });
      const dep = f.path.join(checkout, "node_modules/pkg/version");
      yield* f.fs.utimes(dep, 100, 100);
      yield* f.write(checkout, "README.md", "finished work");
      yield* f.runGit(checkout, ["commit", "-qam", "keep that commit"]);
      const finished = yield* f.commit(checkout);
      yield* f.write(checkout, "README.md", "uncommitted");
      yield* f.runGit(checkout, ["add", "README.md"]);
      yield* f.write(checkout, "stray.txt", "discard");

      const ownerId = ThreadId.make("saved-owner");
      f.published.set(ownerId, checkout);
      const release = workflow.removeWorktree({ cwd: f.repo, path: checkout, force: true });
      assert.include((yield* release.pipe(Effect.flip)).detail, "still uses this worktree");
      assert.equal(yield* f.branch(checkout), "cold");
      f.published.delete(ownerId);
      yield* release;
      yield* release; // A retried removal must leave the spare intact.
      assert.notInclude(yield* f.git.listWorktreePaths(f.repo), checkout);
      assert.deepEqual(yield* f.slots(), [checkout]);
      assert.equal(yield* f.branch(checkout), "");
      assert.equal(yield* f.commit(checkout), base);
      assert.equal(yield* f.runGit(f.repo, ["rev-parse", "refs/heads/cold"]), finished);
      assert.equal(yield* f.runGit(checkout, ["reflog", "show", "HEAD"]), "");
      assert.equal(yield* f.runGit(checkout, ["status", "--porcelain=v1"]), "");
      assert.isFalse(yield* f.fs.exists(f.path.join(checkout, "configured")));
      assert.isFalse(yield* f.fs.exists(f.path.join(checkout, "stray.txt")));

      // The worker sees the recycle before considering a fresh install.
      yield* pool.maintain;
      const warm = yield* pool.claim(f.userRequest("warm", { ref: base }));
      assert.equal(warm?.path, checkout);
      yield* warm!.publish;
      assert.include(yield* f.git.listWorktreePaths(f.repo), checkout);
      assert.equal(yield* f.branch(checkout), "warm");
      assert.equal(yield* f.read(checkout, "configured"), "local fixture");
      assert.equal(yield* f.read(checkout, "node_modules/absolute-launcher"), "v1");
      assert.equal(Option.getOrThrow((yield* f.fs.stat(dep)).mtime).getTime(), 100_000);
      yield* release;
      const again = yield* pool.claim(f.userRequest("again"));
      assert.equal(again?.path, checkout);
      yield* again!.publish;
      assert.equal(yield* f.read(f.repo, "installs"), "cold\n");
      yield* release;
      // An older client can still attach a saved path after the release.
      f.published.set(ownerId, checkout);
      assert.isNull(yield* pool.claim(f.userRequest("owned-again")));
      assert.include(yield* f.git.listWorktreePaths(f.repo), checkout);
      assert.equal(yield* f.read(checkout, "node_modules/absolute-launcher"), "v1");
    }).pipe(Effect.provide(layer)),
);

testOnly("reuses a no-setup checkout without keeping arbitrary dependency folders", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.runGit(f.repo, ["rm", "t3.json"]);
    yield* f.runGit(f.repo, ["commit", "-qm", "no setup action"]);
    const pool = yield* f.makePool();
    const workflow = yield* f.workflow(pool);
    assert.isNull(yield* pool.claim(f.userRequest("empty")));
    const { worktree } = yield* f.git.createWorktree({
      cwd: f.repo,
      refName: "HEAD",
      newRefName: "empty",
      path: null,
    });
    const checkout = yield* f.fs.realPath(worktree.path);
    const modules = f.path.join(checkout, "node_modules");
    yield* f.fs.makeDirectory(modules);
    yield* f.write(modules, "leftover", "");
    yield* workflow.removeWorktree({ cwd: f.repo, path: checkout, force: true });
    assert.deepEqual(yield* f.slots(), [checkout]);
    assert.isFalse(yield* f.fs.exists(modules));
    yield* pool.maintain;
    const warm = yield* pool.claim(f.userRequest("empty-again"));
    assert.equal(warm?.path, checkout);
    yield* warm!.publish;
    assert.isFalse(yield* f.fs.exists(modules));
    assert.isFalse(yield* f.fs.exists(f.path.join(f.repo, "installs")));
  }).pipe(Effect.provide(layer)),
);

for (const cap of ["1", "2"] as const) {
  testOnly(`honors a recycle cap of ${cap} and removes external checkouts`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const pool = yield* f.makePool(cap);
      const workflow = yield* f.workflow(pool);
      assert.isNull(yield* pool.claim(f.userRequest("initial")));
      const active = yield* Effect.forEach(
        Array.from({ length: Number(cap) + 1 }, (_, i) => i),
        (index) =>
          Effect.gen(function* () {
            const checkout = yield* f.cold(`finished-${index}`);
            yield* pool.recordSetup({
              cwd: f.repo,
              projectId,
              worktreePath: checkout,
              command: nodeCommand,
            });
            return checkout;
          }),
      );
      // Release concurrently to exercise the shared slot reservation.
      yield* Effect.forEach(
        active,
        (checkout) => workflow.removeWorktree({ cwd: f.repo, path: checkout, force: true }),
        { concurrency: "unbounded" },
      );
      const spared = yield* f.slots();
      assert.lengthOf(spared, Number(cap));
      for (const checkout of active)
        assert.equal(yield* f.fs.exists(checkout), spared.includes(checkout));

      // Even with room, an external checkout must never get a pool marker.
      const lease = yield* pool.claim(f.userRequest("using-a-spare"));
      assert.isNotNull(lease);
      yield* lease!.publish;
      const outside = yield* f.fs.realPath(
        yield* f.fs.makeTempDirectoryScoped({ prefix: "t3-warm-outside-" }),
      );
      const external = f.path.join(outside, "checkout");
      yield* f.git.createWorktree({
        cwd: f.repo,
        path: external,
        refName: "HEAD",
        newRefName: "external",
      });
      yield* workflow.removeWorktree({ cwd: f.repo, path: external, force: true });
      assert.isFalse(yield* f.fs.exists(external));
      assert.notInclude(yield* f.registered(f.repo), external);
      assert.lengthOf(yield* f.slots(), Number(cap) - 1);
    }).pipe(Effect.provide(layer)),
  );
}

testOnly("a recycle before the first refill tick can be claimed after restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const checkout = yield* Effect.gen(function* () {
      const pool = yield* f.makePool();
      assert.isNull(yield* pool.claim(f.userRequest("before-restart")));
      const checkout = yield* f.cold("before-restart");
      yield* pool.recordSetup({
        cwd: f.repo,
        projectId,
        worktreePath: checkout,
        command: nodeCommand,
      });
      assert.equal(yield* pool.recycle({ cwd: f.repo, path: checkout, force: true }), "recycled");
      return checkout;
    }).pipe(Effect.scoped);
    const restarted = yield* f.makePool();
    const warm = yield* restarted.claim(f.userRequest("after-restart"));
    assert.equal(warm?.path, checkout);
    yield* warm!.publish;
    assert.equal(yield* f.read(f.repo, "installs"), "cold\n");
  }).pipe(Effect.provide(layer)),
);

testOnly("a checkout with a nonstandard index falls back to Git removal", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const pool = yield* f.makePool();
    const workflow = yield* f.workflow(pool);
    assert.isNull(yield* pool.claim(f.userRequest("unusual-index")));
    const checkout = yield* f.cold("unusual-index");
    yield* pool.recordSetup({
      cwd: f.repo,
      projectId,
      worktreePath: checkout,
      command: nodeCommand,
    });
    yield* f.runGit(checkout, ["update-index", "--skip-worktree", "README.md"]);
    yield* workflow.removeWorktree({ cwd: f.repo, path: checkout, force: true });
    assert.isFalse(yield* f.fs.exists(checkout));
    assert.deepEqual(yield* f.slots(), []);
  }).pipe(Effect.provide(layer)),
);

testOnly("a linked project file is not mistaken for a checkout without setup", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* f.runGit(f.repo, ["mv", "t3.json", "project.json"]);
    yield* f.fs.symlink("project.json", f.path.join(f.repo, "t3.json"));
    yield* f.runGit(f.repo, ["add", "t3.json"]);
    yield* f.runGit(f.repo, ["commit", "-qm", "link project setup file"]);
    const pool = yield* f.makePool();
    assert.isNull(yield* pool.claim(f.userRequest("linked-config")));
    yield* pool.maintain;
    assert.deepEqual(yield* f.slots(), []);
  }).pipe(Effect.provide(layer)),
);

testOnly("a subagent that changed install inputs cannot recycle its old setup receipt", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const pool = yield* f.makePool();
    const workflow = yield* f.workflow(pool);
    assert.isNull(yield* pool.claim(f.userRequest("changed-deps")));
    const checkout = yield* f.cold("changed-deps");
    yield* pool.recordSetup({
      cwd: f.repo,
      projectId,
      worktreePath: checkout,
      command: nodeCommand,
    });
    yield* f.write(checkout, "pnpm-lock.yaml", "v2");
    yield* f.runGit(checkout, ["commit", "-qam", "changed install inputs"]);
    yield* workflow.removeWorktree({ cwd: f.repo, path: checkout, force: true });
    assert.isFalse(yield* f.fs.exists(checkout));
    assert.deepEqual(yield* f.slots(), []);
    assert.include(yield* f.git.listLocalBranchNames(f.repo), "changed-deps");
  }).pipe(Effect.provide(layer)),
);
