import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/process";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as TeamBoardGit from "./TeamBoardGit.ts";
import { overlapEdits } from "./model.ts";

const layer = TeamBoardGit.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(VcsProcess.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "team-board-git-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.live(
  "tracks dirty and committed hunks in separate worktrees and confirms textual collisions",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const board = yield* TeamBoardGit.TeamBoardGit;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "board-worktrees-" });
      const lead = path.join(workspace, "lead");
      const sol = path.join(workspace, "sol");
      const neon = path.join(workspace, "neon");
      yield* fs.makeDirectory(lead);
      const cmd = (cwd: string, ...args: string[]) =>
        git.execute({ operation: "test.teamBoard.git", cwd, args });
      yield* cmd(lead, "init", "-q");
      yield* cmd(lead, "config", "user.name", "Fixture");
      yield* cmd(lead, "config", "user.email", "fixture@example.test");
      const write = (cwd: string, changes: Readonly<Record<number, string>> = {}) =>
        fs.writeFileString(
          path.join(cwd, "settings file.ts"),
          Array.from(
            { length: 64 },
            (_, index) => changes[index + 1] ?? `initial ${index + 1}`,
          ).join("\n") + "\n",
        );
      yield* write(lead);
      yield* cmd(lead, "add", "--all");
      yield* cmd(lead, "commit", "-m", "Baseline");
      const base = (yield* board.head(lead))!;
      yield* cmd(lead, "worktree", "add", "-b", "sol", sol);
      yield* cmd(lead, "worktree", "add", "-b", "neon", neon);
      expect(yield* board.repository(sol)).toEqual(yield* board.repository(neon));
      expect((yield* board.repository(sol))?.name).toBe("lead");
      yield* write(sol, { 24: "sol change" });
      yield* write(neon, { 38: "neon change" });
      const first = (yield* board.inspect(sol, base))!;
      const second = (yield* board.inspect(neon, base))!;
      expect(first.files).toEqual([{ path: "settings file.ts", ranges: [{ start: 24, end: 24 }] }]);
      expect(second.files[0]?.ranges[0]?.start).toBe(38);
      expect(overlapEdits(first.files[0]!, second.files[0]!)).toBe(false);
      expect(yield* board.inspect(sol, base, first)).toBe(first);
      yield* cmd(sol, "commit", "-am", "Sol change");
      yield* cmd(neon, "commit", "-am", "Neon change");
      const a = (yield* board.inspect(sol, base, first))!;
      const b = (yield* board.inspect(neon, base, second))!;
      expect(a.committed.has("settings file.ts")).toBe(true);
      expect(yield* board.conflicts(sol, a.head, b.head)).toEqual(new Set());
      yield* write(neon, { 24: "different change at line 24", 38: "neon change" });
      yield* cmd(neon, "commit", "-am", "Real overlap");
      const c = (yield* board.inspect(neon, base, b))!;
      expect(yield* board.conflicts(sol, a.head, c.head)).toEqual(new Set(["settings file.ts"]));
      expect(yield* board.head(sol)).toBe(a.head);
      expect(yield* board.head(neon)).toBe(c.head);
      expect(yield* board.worktreeBase(sol)).toBe(base);
      expect(yield* board.worktreeBase(neon)).toBe(base);
    }).pipe(Effect.provide(layer)),
);

const lines = (count: number, changes: Readonly<Record<number, string>> = {}, tag = "line") =>
  Array.from({ length: count }, (_, index) => changes[index + 1] ?? `${tag} ${index + 1}`).join(
    "\n",
  ) + "\n";

const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const board = yield* TeamBoardGit.TeamBoardGit;
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "board-review-" });
  const lead = path.join(workspace, "lead");
  yield* fs.makeDirectory(lead);
  const cmd = (cwd: string, ...args: string[]) =>
    git.execute({ operation: "test.teamBoard.review", cwd, args });
  yield* cmd(lead, "init", "-q");
  yield* cmd(lead, "config", "user.name", "Fixture");
  yield* cmd(lead, "config", "user.email", "fixture@example.test");
  yield* fs.writeFileString(path.join(lead, "small.ts"), lines(64));
  yield* fs.writeFileString(path.join(lead, "big.txt"), lines(20_000));
  yield* cmd(lead, "add", "--all");
  yield* cmd(lead, "commit", "-qm", "Baseline");
  const base = (yield* board.head(lead))!;
  const worktree = (name: string) =>
    Effect.gen(function* () {
      const dir = path.join(workspace, name);
      yield* cmd(lead, "worktree", "add", "-q", "-b", name, dir);
      return dir;
    });
  return { fs, path, cmd, board, lead, base, worktree, workspace };
});

it.live("retains small hunks when a neighboring file exceeds the patch budget", () =>
  Effect.gen(function* () {
    const { fs, path, board, base, worktree } = yield* setup;
    const sol = yield* worktree("sol");
    yield* fs.writeFileString(path.join(sol, "small.ts"), lines(64, { 10: "sol edit" }));
    const before = (yield* board.inspect(sol, base))!;
    expect(before.files).toEqual([{ path: "small.ts", ranges: [{ start: 10, end: 10 }] }]);
    // A formatter or lockfile rewrite: > 512 KiB of diff output.
    yield* fs.writeFileString(path.join(sol, "big.txt"), lines(20_000, {}, "rewritten line"));
    const after = (yield* board.inspect(sol, base, before))!;
    const small = after.files.find((file) => file.path === "small.ts");
    expect(small?.ranges).toEqual([{ start: 10, end: 10 }]);
    expect(after.files.find(({ path }) => path === "big.txt")?.ranges).toEqual([]);
    expect(overlapEdits(small!, { path: "small.ts", ranges: [{ start: 60, end: 60 }] })).toBe(
      false,
    );
  }).pipe(Effect.provide(layer)),
);

it.live("parses hunks with user diff.noprefix enabled", () =>
  Effect.gen(function* () {
    const { fs, path, cmd, board, lead, base, worktree } = yield* setup;
    const sol = yield* worktree("sol");
    yield* cmd(lead, "config", "diff.noprefix", "true");
    yield* fs.writeFileString(path.join(sol, "small.ts"), lines(64, { 10: "sol edit" }));
    const state = (yield* board.inspect(sol, base))!;
    expect(state.files).toEqual([{ path: "small.ts", ranges: [{ start: 10, end: 10 }] }]);
  }).pipe(Effect.provide(layer)),
);

it.live("does not write merge-tree objects into the shared store", () =>
  Effect.gen(function* () {
    const { fs, path, cmd, board, lead, base, worktree } = yield* setup;
    const sol = yield* worktree("sol");
    const neon = yield* worktree("neon");
    yield* fs.writeFileString(path.join(sol, "small.ts"), lines(64, { 10: "sol" }));
    yield* fs.writeFileString(path.join(neon, "small.ts"), lines(64, { 10: "neon" }));
    yield* cmd(sol, "commit", "-qam", "Sol");
    yield* cmd(neon, "commit", "-qam", "Neon");
    const a = (yield* board.inspect(sol, base))!;
    const b = (yield* board.inspect(neon, base))!;
    const count = Effect.map(cmd(lead, "count-objects", "-v"), ({ stdout }) =>
      Number(/^count: (\d+)$/mu.exec(stdout)?.[1] ?? "-1"),
    );
    const objectsBefore = yield* count;
    expect(yield* board.conflicts(sol, a.head, b.head)).toEqual(new Set(["small.ts"]));
    expect(yield* count).toBe(objectsBefore);
  }).pipe(Effect.provide(layer)),
);

it.live("recognizes that the same edit after a fast-forward handoff merges cleanly", () =>
  Effect.gen(function* () {
    const { fs, path, cmd, board, base, worktree } = yield* setup;
    const sol = yield* worktree("sol");
    const neon = yield* worktree("neon");
    yield* fs.writeFileString(path.join(sol, "small.ts"), lines(64, { 10: "sol fix" }));
    yield* cmd(sol, "commit", "-qam", "Sol fix");
    // "Opus fixed X in abc1234; merge it instead of redoing it." Neon does exactly that.
    yield* cmd(neon, "merge", "-q", "--ff-only", "sol");
    const a = (yield* board.inspect(sol, base))!;
    const b = (yield* board.inspect(neon, base))!;
    expect(a.committed.has("small.ts")).toBe(true);
    expect(b.files).toEqual([]);
    expect(yield* board.conflicts(sol, a.head, b.head)).toEqual(new Set());
  }).pipe(Effect.provide(layer)),
);

it.live("excludes dirty paths present at the start of main-checkout observation", () =>
  Effect.gen(function* () {
    const { fs, path, board, lead } = yield* setup;
    // The user left an edit in the main checkout before any chat started.
    yield* fs.writeFileString(path.join(lead, "small.ts"), lines(64, { 30: "user's old edit" }));
    const head = (yield* board.head(lead))!;
    const baseline = (yield* board.dirty(lead))!;
    expect(baseline).toEqual(new Set(["small.ts"]));
    yield* fs.writeFileString(path.join(lead, "big.txt"), lines(20_000, { 45: "new edit" }));
    const state = (yield* board.inspect(lead, head, undefined, baseline))!;
    expect(state.files).toEqual([{ path: "big.txt", ranges: [{ start: 45, end: 45 }] }]);
  }).pipe(Effect.provide(layer)),
);

it.live("returns unknown when a worktree has been deleted", () =>
  Effect.gen(function* () {
    const { fs, path, cmd, board, lead, base, worktree } = yield* setup;
    const sol = yield* worktree("sol");
    yield* fs.writeFileString(path.join(sol, "small.ts"), lines(64, { 10: "sol" }));
    const first = (yield* board.inspect(sol, base))!;
    yield* cmd(lead, "worktree", "remove", "--force", sol);
    expect(yield* fs.exists(sol)).toBe(false);
    expect(yield* board.inspect(sol, base, first)).toBeUndefined();
    expect(yield* board.conflicts(sol, first.head, first.head)).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

it.effect("retains a marked-stale snapshot when a background refresh times out", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "team-board-refresh-" });
    const entered = yield* Deferred.make<void>();
    const head = "a".repeat(40);
    let blocked = false;
    const board = yield* Layer.build(
      TeamBoardGit.layer.pipe(
        Layer.provide(
          Layer.mock(GitVcsDriver.GitVcsDriver)({
            execute: (request) => {
              expect(request.priority).toBe("background");
              expect(request.timeoutMs).toBe(15_000);
              return blocked
                ? Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never))
                : Effect.succeed({
                    exitCode: ChildProcessSpawner.ExitCode(0),
                    stdout: `# branch.oid ${head}\0`,
                    stderr: "",
                    stdoutTruncated: false,
                    stderrTruncated: false,
                  });
            },
          }),
        ),
      ),
    );
    const service = yield* TeamBoardGit.TeamBoardGit.pipe(Effect.provide(board));
    const good = (yield* service.inspect(cwd, head))!;
    blocked = true;
    const refresh = yield* service.inspect(cwd, head, good).pipe(Effect.forkScoped);
    yield* Deferred.await(entered);
    yield* TestClock.adjust("15 seconds");
    const stale = yield* Fiber.join(refresh);
    expect(stale).toEqual({ ...good, stale: true });
    blocked = false;
    expect((yield* service.inspect(cwd, head, stale))?.stale).toBe(false);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("skips completed read, search and MCP tools but refreshes on completed writes", () => {
  for (const toolName of [
    "Read",
    "Grep",
    "Glob",
    "file-read",
    "mcp__server__Edit",
    "server.write",
  ]) {
    expect(
      TeamBoardGit.shouldRefreshAfterTool({ type: "dynamic_tool", status: "completed", toolName }),
    ).toBe(false);
  }
  expect(TeamBoardGit.shouldRefreshAfterTool({ type: "file_search", status: "completed" })).toBe(
    false,
  );
  expect(
    TeamBoardGit.shouldRefreshAfterTool({ type: "command_execution", status: "completed" }),
  ).toBe(true);
  expect(TeamBoardGit.shouldRefreshAfterTool({ type: "file_change", status: "running" })).toBe(
    false,
  );
  expect(TeamBoardGit.shouldRefreshAfterTool({ type: "file_change", status: "completed" })).toBe(
    true,
  );
});

it.live("treats new and untracked copies of the same file as a whole-file overlap", () =>
  Effect.gen(function* () {
    const { fs, path, cmd, board, base, worktree } = yield* setup;
    const a = yield* worktree("new-a");
    const b = yield* worktree("new-b");
    yield* fs.writeFileString(path.join(a, "new.ts"), "export const a = 1;\n");
    yield* fs.writeFileString(path.join(b, "new.ts"), "export const b = 2;\n");
    const aState = (yield* board.inspect(a, base))!;
    const bState = (yield* board.inspect(b, base))!;
    expect(aState.files[0]).toMatchObject({ path: "new.ts", newFile: true, ranges: [] });
    expect(overlapEdits(aState.files[0]!, bState.files[0]!)).toBe(true);
    yield* cmd(b, "add", "new.ts");
    const staged = (yield* board.inspect(b, base, bState))!;
    expect(overlapEdits(aState.files[0]!, staged.files[0]!)).toBe(true);
    yield* cmd(b, "commit", "-qm", "Add the other new file");
    const committed = (yield* board.inspect(b, base, staged))!;
    expect(overlapEdits(aState.files[0]!, committed.files[0]!)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.live("credits a sibling's imported handoff paths only to the sibling", () =>
  Effect.gen(function* () {
    const { fs, path, cmd, board, base, worktree } = yield* setup;
    const sibling = yield* worktree("handoff");
    const merge = yield* worktree("merge");
    const fastForward = yield* worktree("fast-forward");
    yield* fs.writeFileString(path.join(sibling, "sibling.ts"), "export const sibling = 1;\n");
    yield* cmd(sibling, "add", "sibling.ts");
    yield* cmd(sibling, "commit", "-qm", "Sibling handoff");
    yield* fs.writeFileString(path.join(merge, "own.ts"), "export const own = 2;\n");
    yield* cmd(merge, "add", "own.ts");
    yield* cmd(merge, "commit", "-qm", "Local edit");
    yield* cmd(merge, "merge", "--no-ff", "--no-edit", "handoff");
    yield* cmd(fastForward, "merge", "--ff-only", "handoff");
    const merged = (yield* board.inspect(merge, base))!;
    const forwarded = (yield* board.inspect(fastForward, base))!;
    expect([...merged.committed]).toEqual(["own.ts"]);
    expect(merged.files.map(({ path }) => path)).toEqual(["own.ts"]);
    expect(forwarded.files).toEqual([]);
    expect((yield* board.inspect(sibling, base))?.files.map(({ path }) => path)).toEqual([
      "sibling.ts",
    ]);
  }).pipe(Effect.provide(layer)),
);
