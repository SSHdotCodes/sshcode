// @effect-diagnostics nodeBuiltinImport:off - runs before `vp i`, so only Node built-ins exist.
/**
 * Worktree setup, run by the t3.json "Setup Worktree" action as
 * `node scripts/setup-worktree.ts`. Plain Node keeps one command working in
 * every shell SSHCode spawns (zsh, bash, fish, PowerShell): it installs
 * dependencies, links the main checkout's gitignored env files into this
 * worktree, then warms the web dependency cache for user-created worktrees.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const ENV_FILES = [".env", NodePath.join("infra", "relay", ".env")];
const worktree = NodePath.dirname(import.meta.dirname);
const cachePhase = process.env.T3CODE_WORKTREE_SETUP_CACHE;

function configureHooks() {
  return (
    NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(worktree, "node_modules", "vite-plus", "bin", "vp"), "config", "--no-agent"],
      { cwd: worktree, stdio: "inherit" },
    ).status ?? 1
  );
}

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup action.");
}
if (cachePhase === "reuse") {
  const hooks = configureHooks();
  if (hooks !== 0) process.exit(hooks);
}

// `shell` resolves `vp` through PATH, including Windows command shims.
// Setup has no one answering install prompts. Pass pnpm's confirmation flag
// through vp and leave stdin closed so other prompts fail instead of hanging.
// A machine without a global `vp` installs with pnpm from the lockfile as is.
if (cachePhase !== "reuse") {
  const hasVp =
    NodeChildProcess.spawnSync("vp --version", { shell: true, stdio: "ignore" }).status === 0;
  const install = NodeChildProcess.spawnSync(
    hasVp ? "vp i -- --yes" : "pnpm install --frozen-lockfile --prefer-offline",
    {
      cwd: worktree,
      shell: true,
      stdio: ["ignore", "inherit", "inherit"],
      // The install lifecycle normally configures Git hooks, including shared
      // Git config. Do that at claim time, after the branch has been checked out.
      ...(cachePhase === "prepare" ? { env: { ...process.env, VP_GIT_HOOKS: "0" } } : {}),
    },
  );
  if (install.status !== 0) process.exit(install.status ?? 1);
}
if (cachePhase === "prepare") process.exit(0);

// Env files live as real files in the main checkout; worktrees only get
// symlinks to them. Only a symlink is ever replaced, so a real env file is
// never deleted, including when this runs in the main checkout itself.
for (const file of ENV_FILES) {
  const source = NodePath.join(projectRoot, file);
  const sourceStat = NodeFS.lstatSync(source, { throwIfNoEntry: false });
  if (!sourceStat) continue;
  if (!sourceStat.isFile()) {
    process.stderr.write(`Skipping ${file}: ${source} is not a regular file.\n`);
    continue;
  }
  const target = NodePath.join(worktree, file);
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) continue;
  if (existing && NodeFS.readlinkSync(target) === source) continue;
  if (existing) NodeFS.rmSync(target);
  NodeFS.symlinkSync(source, target);
}

// Subagents usually only run tests and typechecks. Vite will build its web
// dependency cache on demand if a dev server is started in the worktree.
if (cachePhase === "reuse" || process.env.T3CODE_SUBAGENT_WORKTREE === "1") process.exit(0);

const warm = NodeChildProcess.spawnSync(
  process.execPath,
  [NodePath.join(worktree, "apps", "web", "scripts", "warm-dep-cache.ts")],
  { cwd: worktree, stdio: "inherit" },
);
process.exit(warm.status ?? 1);
