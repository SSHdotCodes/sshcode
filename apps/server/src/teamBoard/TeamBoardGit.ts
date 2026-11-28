import * as Crypto from "effect/Crypto";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { classifyClaudeNativeTool } from "@t3tools/shared/claudeNativeTools";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { PATCH_RENDER_PREFIX_ARGS } from "../vcs/GitVcsDriverCore.ts";
import type { EditedFile, EditState } from "./model.ts";

const MAX_FILES = 128;
const MAX_DIFF_BYTES = 512 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const quoteGitPath = Schema.encodeSync(Schema.fromJsonString(Schema.String));
const SHA = /^[a-f0-9]{40,64}$/u;
const STATUS_ARGS = [
  "status",
  "--porcelain=v2",
  "--branch",
  "-z",
  "--no-renames",
  "--untracked-files=all",
];
export const shouldRefreshAfterTool = (
  item: Pick<OrchestrationV2TurnItem, "type" | "status"> & { readonly toolName?: string | null },
): boolean => {
  if (item.status === "pending" || item.status === "running" || item.status === "waiting")
    return false;
  if (item.type === "command_execution" || item.type === "file_change") return true;
  // MCP calls are also projected as dynamic tools. Inspect only recognized native writes.
  return (
    item.type === "dynamic_tool" &&
    typeof item.toolName === "string" &&
    classifyClaudeNativeTool(item.toolName).itemType === "file_change"
  );
};
const hunkRange = (line: string) => {
  const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/u.exec(line);
  if (hunk === null) return [];
  const start = Math.max(1, Number(hunk[1]));
  return [{ start, end: start + Math.max(1, Number(hunk[2] ?? 1)) - 1 }];
};

/** Git's old-side coordinates are comparable across sibling worktrees. */
function gitHunks(diff: string): ReadonlyArray<EditedFile> {
  const changed = new Map<string, EditedFile>();
  for (const section of diff.split(/^diff --git /mu).slice(1)) {
    const headers = section.split(/^@@ /mu, 1)[0] ?? "";
    const file =
      /^--- a\/(.+?)[\t]?$/mu.exec(headers)?.[1] ?? /^\+\+\+ b\/(.+?)[\t]?$/mu.exec(headers)?.[1];
    if (file !== undefined && changed.size < MAX_FILES) {
      changed.set(file, {
        path: file,
        ranges: section.split("\n").flatMap(hunkRange),
        ...(/^new file mode /mu.test(headers) ? { newFile: true as const } : {}),
      });
    }
  }
  return [...changed.values()];
}

const dirtyPaths = (status: string) =>
  status.split("\0").flatMap((entry) => {
    if (entry.startsWith("? ")) return [entry.slice(2)];
    if (entry.startsWith("1 ")) return [entry.split(" ").slice(8).join(" ")];
    if (entry.startsWith("u ")) return [entry.split(" ").slice(10).join(" ")];
    return [];
  });

export class TeamBoardGit extends Context.Service<
  TeamBoardGit,
  {
    readonly repository: (
      cwd: string,
    ) => Effect.Effect<{ readonly id: string; readonly name: string } | undefined>;
    readonly head: (cwd: string) => Effect.Effect<string | undefined>;
    readonly dirty: (cwd: string) => Effect.Effect<ReadonlySet<string> | undefined>;
    readonly worktreeBase: (cwd: string) => Effect.Effect<string | undefined>;
    readonly inspect: (
      cwd: string,
      base: string,
      previous?: EditState,
      ignored?: ReadonlySet<string>,
    ) => Effect.Effect<EditState | undefined>;
    readonly conflicts: (
      cwd: string,
      left: string,
      right: string,
    ) => Effect.Effect<ReadonlySet<string> | undefined>;
  }
>()("t3/teamBoard/TeamBoardGit") {}

/**
 * Reflog actions (Git 2.54 wording) that made a commit here. `pull` and `rebase` carry the
 * user's arguments, as in `pull --rebase (pick)`.
 */
const OWN_COMMIT =
  /^(?:(?:commit(?: \((?:amend|initial|merge)\))?|cherry-pick|revert|am|(?:rebase|pull\b[^:(]*)(?: -i)? \((?:pick|continue|squash|fixup|reword|edit)\)): |(?:merge|pull)\b[^:]*: Merge made by )/u;
/** Reflog actions that moved HEAD onto commits made elsewhere. */
const INHERITED_MOVE =
  /^(?:checkout: moving from |reset: moving to |(?:rebase|pull\b[^:(]*)(?: -i)? \(start\): checkout |(?:merge|pull)\b[^:]*: [Ff]ast-forward$)/u;

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const hash = (text: string) =>
    crypto.digest("SHA-256", Buffer.from(text)).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("hex")),
      Effect.orElseSucceed(() => undefined),
    );
  const git = yield* GitVcsDriver.GitVcsDriver;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots = new Map<string, string>();
  const execute = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    git
      .execute({
        operation: "teamBoard.git",
        cwd,
        args: ["--no-optional-locks", "--literal-pathspecs", ...args],
        ...(env === undefined ? {} : { env }),
        priority: "background",
        allowNonZeroExit: true,
        timeoutMs: GIT_TIMEOUT_MS,
        maxOutputBytes: MAX_DIFF_BYTES,
        appendTruncationMarker: true,
      })
      .pipe(Effect.orElseSucceed(() => undefined));
  const output = (cwd: string, args: ReadonlyArray<string>) =>
    execute(cwd, args).pipe(
      Effect.map((result) =>
        result?.exitCode === 0 && !result.stdoutTruncated ? result.stdout : undefined,
      ),
    );
  const repository = Effect.fnUntraced(function* (cwd: string) {
    const dir = (yield* output(cwd, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]))?.trim();
    if (dir === undefined) return undefined;
    const canonical = yield* fs.realPath(dir).pipe(Effect.orElseSucceed(() => path.normalize(dir)));
    const id = (yield* hash(canonical))?.slice(0, 20);
    const name =
      path.basename(canonical) === ".git"
        ? path.basename(path.dirname(canonical))
        : path.basename(canonical).replace(/\.git$/u, "");
    return id === undefined ? undefined : { id, name: name || id };
  });
  const head = (cwd: string) =>
    output(cwd, ["rev-parse", "HEAD"]).pipe(
      Effect.map((text) => {
        const id = text?.trim();
        return id !== undefined && SHA.test(id) ? id : undefined;
      }),
    );
  // A delegated worktree's first checkout records its exact base, even when
  // workspace preparation originally used HEAD or another moving ref.
  const worktreeBase = (cwd: string) =>
    output(cwd, ["reflog", "show", "--format=%H", "HEAD"]).pipe(
      Effect.map((text) => {
        const id = text?.trim().split("\n").at(-1);
        return id !== undefined && SHA.test(id) ? id : undefined;
      }),
    );
  const dirty = (cwd: string) =>
    output(cwd, STATUS_ARGS).pipe(
      Effect.map((status) => (status === undefined ? undefined : new Set(dirtyPaths(status)))),
    );
  const ownCommittedPaths = Effect.fnUntraced(function* (cwd: string, base: string, head: string) {
    const range = `${base}..${head}`;
    const reflog = yield* output(cwd, ["reflog", "show", "--format=%H%x09%gs", "HEAD"]);
    const history = (reflog?.trim().split("\n") ?? []).map((line) => {
      const tab = line.indexOf("\t");
      return { hash: line.slice(0, tab), action: line.slice(tab + 1) };
    });
    // Commits this worktree made itself stay its own, whatever moved HEAD later.
    const own = new Set(
      history.flatMap(({ hash, action }) => (OWN_COMMIT.test(action) ? [hash] : [])),
    );
    // HEAD moved onto commits it did not make: each segment runs from the line's result back to
    // where HEAD was before (or to the base when that is not on this branch).
    const moves = history.flatMap(({ hash, action }, i) => {
      if (!INHERITED_MOVE.test(action)) return [];
      const before = history[i + 1]?.hash;
      return before === undefined ? [] : [{ before, after: hash }];
    });
    const logArgs = ["log", "--diff-merges=off", "--format=", "--name-only", "--no-renames", "-z"];
    if (moves.length === 0) return yield* output(cwd, [...logArgs, "--first-parent", range, "--"]);
    // A fast-forward, checkout, reset or rebase start has no merge commit, so the inherited
    // commits are first-parent too; the reflog is what tells them apart.
    const commits = (yield* output(cwd, ["rev-list", "--first-parent", range]))?.trim().split("\n");
    if (commits === undefined || commits.some((commit) => !SHA.test(commit))) return undefined;
    const positions = new Map(commits.map((commit, index) => [commit, index]));
    const inherited = new Set<string>();
    for (const { before, after } of moves) {
      const first = positions.get(after);
      const end = positions.get(before) ?? commits.length;
      if (first === undefined || end <= first) continue;
      for (const commit of commits.slice(first, end)) inherited.add(commit);
    }
    const local = commits.filter((commit) => own.has(commit) || !inherited.has(commit));
    return local.length === 0
      ? ""
      : yield* output(cwd, [...logArgs, "--no-walk=unsorted", ...local, "--"]);
  });
  const readEdits = Effect.fnUntraced(function* (
    cwd: string,
    base: string,
    previous?: EditState,
    ignored?: ReadonlySet<string>,
  ) {
    if (!SHA.test(base)) return undefined;
    const status = yield* output(cwd, STATUS_ARGS);
    const head = /^# branch\.oid ([a-f0-9]+)\0/u.exec(status ?? "")?.[1];
    if (status === undefined || head === undefined) return undefined;
    const untracked = new Set(
      status.split("\0").flatMap((line) => (line.startsWith("? ") ? [line.slice(2)] : [])),
    );
    const dirty = dirtyPaths(status)
      .filter((name) => !ignored?.has(name))
      .slice(0, MAX_FILES);
    const root =
      dirty.length === 0
        ? undefined
        : (roots.get(cwd) ?? (yield* output(cwd, ["rev-parse", "--show-toplevel"]))?.trim());
    if (root !== undefined && !roots.has(cwd)) {
      if (roots.size >= 128) roots.clear();
      roots.set(cwd, root);
    }
    const stamps =
      root === undefined
        ? []
        : yield* Effect.forEach(
            dirty,
            (name) =>
              fs.stat(path.join(root, name)).pipe(
                Effect.map(
                  (stat) =>
                    `${stat.size}:${stat.mtime._tag === "Some" ? stat.mtime.value.getTime() : 0}`,
                ),
                Effect.orElseSucceed(() => ""),
              ),
            { concurrency: 8 },
          );
    const signature = yield* hash(`${base}\0${status}\0${stamps.join("\0")}`);
    if (signature === undefined) return undefined;
    if (signature === previous?.signature)
      return previous.stale ? { ...previous, stale: false } : previous;
    let committed = previous?.head === head ? previous.committed : undefined;
    if (committed === undefined) {
      const names =
        base === head
          ? ""
          : yield* output(cwd, ["diff", "--name-only", "--no-renames", "-z", base, head, "--"]);
      if (names === undefined) return undefined;
      // Only attribute paths touched by commits on this worktree's first-parent
      // branch. A merge can import many sibling edits without editing them here.
      const own = names === "" ? "" : yield* ownCommittedPaths(cwd, base, head);
      if (own === undefined) return undefined;
      const ownPaths = new Set(own.split("\0"));
      committed = new Set(
        names
          .split("\0")
          .filter((name) => name && ownPaths.has(name) && !ignored?.has(name))
          .slice(0, MAX_FILES),
      );
    }
    const paths = [...new Set([...committed, ...dirty])].slice(0, MAX_FILES);
    const diffArgs = [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      "--no-renames",
      "--unified=0",
      ...PATCH_RENDER_PREFIX_ARGS,
      base,
      "--",
    ];
    const diff = paths.length === 0 ? undefined : yield* execute(cwd, [...diffArgs, ...paths]);
    if (paths.length > 0 && diff?.exitCode !== 0) return undefined;
    const parsed = new Map(
      diff === undefined || diff.stdoutTruncated
        ? []
        : gitHunks(diff.stdout).map((file) => [file.path, file]),
    );
    const changes = yield* Effect.forEach(
      paths,
      (name) =>
        Effect.gen(function* () {
          if (untracked.has(name)) return { path: name, ranges: [], newFile: true as const };
          const file = parsed.get(name);
          if (file !== undefined) return file;
          // A truncated aggregate or a Git-quoted path requires an isolated diff.
          const isolated = yield* execute(cwd, [...diffArgs, name]);
          if (isolated?.exitCode !== 0) return undefined;
          return {
            path: name,
            ranges: isolated.stdoutTruncated ? [] : isolated.stdout.split("\n").flatMap(hunkRange),
            ...(/^new file mode /mu.test(isolated.stdout.split(/^@@ /mu, 1)[0] ?? "")
              ? { newFile: true as const }
              : {}),
          };
        }),
      { concurrency: 3 },
    );
    if (changes.some((file) => file === undefined)) return undefined;
    const changedAt = yield* Clock.currentTimeMillis;
    return {
      head,
      committed,
      files: changes.filter((file) => file !== undefined),
      signature,
      changedAt,
    };
  });
  const inspect: TeamBoardGit["Service"]["inspect"] = Effect.fnUntraced(
    function* (cwd, base, previous, ignored) {
      const fresh = Option.getOrUndefined(
        yield* readEdits(cwd, base, previous, ignored).pipe(Effect.timeoutOption(GIT_TIMEOUT_MS)),
      );
      if (fresh !== undefined || previous === undefined) return fresh;
      if (!(yield* fs.exists(cwd).pipe(Effect.orElseSucceed(() => false)))) return undefined;
      return previous.stale ? previous : { ...previous, stale: true };
    },
  );
  const conflicts: TeamBoardGit["Service"]["conflicts"] = Effect.fnUntraced(
    function* (cwd, left, right) {
      if (!SHA.test(left) || !SHA.test(right)) return undefined;
      const objects = (yield* output(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "objects",
      ]))?.trim();
      if (objects === undefined) return undefined;
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "team-board-objects-" });
          return yield* execute(
            cwd,
            ["merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", left, right],
            {
              GIT_OBJECT_DIRECTORY: temporary,
              GIT_ALTERNATE_OBJECT_DIRECTORIES: quoteGitPath(objects),
            },
          );
        }),
      ).pipe(Effect.orElseSucceed(() => undefined));
      if (result?.exitCode === 0) return new Set<string>();
      if (result?.exitCode !== 1 || result.stdoutTruncated) return undefined;
      return new Set(result.stdout.split("\0").slice(1).filter(Boolean));
    },
  );
  return TeamBoardGit.of({ repository, head, dirty, worktreeBase, inspect, conflicts });
});

export const layer = Layer.effect(TeamBoardGit, make);
