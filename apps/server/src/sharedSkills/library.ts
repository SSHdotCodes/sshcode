// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Launch-arg builders read the library synchronously, and git is a short child process with its own timeout.
import {
  providerUsesSharedSkills,
  type SharedSkill,
  type SharedSkillsCommand,
  type SharedSkillsList,
} from "@t3tools/contracts";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export { providerUsesSharedSkills };

const STATE_FILE = "shared-skills.json";
const CLAUDE_SHARED_DIR = "shared-skills-claude";
const HOLDING_REPOS_DIR = "shared-skill-repos";
const MAX_FRONTMATTER_BYTES = 8_192;
const MAX_FILES = 2_000;
const MAX_BYTES = 32 * 1024 * 1024;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Harnesses that already read ~/.agents/skills, plus Claude and Antigravity,
 * which SSHCode points at the same folders when it launches them.
 * OpenCode, Grok, Cursor, Pi, Kimi, and Vibe have no session switch that hides
 * one skill without writing their own home, so a skill that is off is hidden
 * in SSHCode and skipped by Claude, Codex, and Antigravity only.
 */
export const SHARED_SKILL_HARNESSES_ON =
  "Claude, Codex, OpenCode, Grok, Cursor, Pi, Antigravity, Kimi, and Vibe";
export const SHARED_SKILL_HARNESSES_OFF = "Off in SSHCode. Claude, Codex, and Antigravity skip it.";

interface ManagedRecord {
  readonly source: "folder" | "git";
  readonly url?: string;
  readonly from?: string;
  readonly repo?: string;
  readonly child?: string;
}

interface LibraryState {
  readonly version: 1;
  readonly disabled: readonly string[];
  readonly managed: Readonly<Record<string, ManagedRecord>>;
}

const emptyState = (): LibraryState => ({ version: 1, disabled: [], managed: {} });

export function agentsSkillsDir(homeDir: string): string {
  return NodePath.join(homeDir, ".agents", "skills");
}

function statePath(stateDir: string): string {
  return NodePath.join(stateDir, STATE_FILE);
}

function setAsideUnreadable(stateDir: string): void {
  const file = statePath(stateDir);
  const backup = `${STATE_FILE}.unreadable`;
  let destination = backup;
  let suffix = 0;
  let existing: string[] = [];
  try {
    existing = NodeFS.readdirSync(stateDir);
  } catch {
    existing = [];
  }
  while (existing.includes(destination)) destination = `${backup}.${++suffix}`;
  try {
    NodeFS.renameSync(file, NodePath.join(stateDir, destination));
  } catch {
    // A failed move leaves the file in place. The next read tries again.
  }
}

function readState(stateDir: string): LibraryState {
  const file = statePath(stateDir);
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    setAsideUnreadable(stateDir);
    return emptyState();
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      setAsideUnreadable(stateDir);
      return emptyState();
    }
    const record = parsed as { disabled?: unknown; managed?: unknown };
    const disabled = Array.isArray(record.disabled)
      ? record.disabled.filter(
          (name): name is string => typeof name === "string" && name.length > 0,
        )
      : [];
    const managed: Record<string, ManagedRecord> = {};
    if (record.managed !== null && typeof record.managed === "object") {
      for (const [dir, value] of Object.entries(record.managed)) {
        if (!SAFE_NAME.test(dir) || value === null || typeof value !== "object") continue;
        const entry = value as {
          source?: unknown;
          url?: unknown;
          from?: unknown;
          repo?: unknown;
          child?: unknown;
        };
        if (entry.source !== "folder" && entry.source !== "git") continue;
        managed[dir] = {
          source: entry.source,
          ...(typeof entry.url === "string" ? { url: entry.url } : {}),
          ...(typeof entry.from === "string" ? { from: entry.from } : {}),
          ...(typeof entry.repo === "string" ? { repo: entry.repo } : {}),
          ...(typeof entry.child === "string" ? { child: entry.child } : {}),
        };
      }
    }
    return { version: 1, disabled, managed };
  } catch {
    setAsideUnreadable(stateDir);
    return emptyState();
  }
}

function writeState(stateDir: string, state: LibraryState): void {
  NodeFS.mkdirSync(stateDir, { recursive: true });
  const file = statePath(stateDir);
  const temporary = `${file}.tmp`;
  NodeFS.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  NodeFS.renameSync(temporary, file);
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** Name and description only. The body stays on disk until a harness opens the skill. */
export function readSkillFrontmatter(file: string): { name?: string; description?: string } {
  let text: string;
  try {
    const fd = NodeFS.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(MAX_FRONTMATTER_BYTES);
      const read = NodeFS.readSync(fd, buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      NodeFS.closeSync(fd);
    }
  } catch {
    return {};
  }
  const normalized = text.replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---")) return {};
  const end = normalized.indexOf("\n---", 3);
  if (end < 0) return {};
  const lines = normalized.slice(normalized.indexOf("\n", 3) + 1, end).split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nameMatch = /^name:\s*(.*)$/.exec(line);
    if (nameMatch && name === undefined) {
      name = unquote(nameMatch[1] ?? "");
      continue;
    }
    const descriptionMatch = /^description:\s*(.*)$/.exec(line);
    if (descriptionMatch && description === undefined) {
      const rest = (descriptionMatch[1] ?? "").trim();
      if (rest === "" || rest === "|" || rest === ">" || rest === "|-" || rest === ">-") {
        const parts: string[] = [];
        for (let next = index + 1; next < lines.length; next += 1) {
          const continued = lines[next] ?? "";
          if (!/^\s/.test(continued)) break;
          parts.push(continued.trim());
          index = next;
        }
        description = parts.join(rest.startsWith(">") ? " " : " ").trim();
      } else {
        description = unquote(rest);
      }
    }
  }
  return {
    ...(name && name.length > 0 ? { name } : {}),
    ...(description && description.length > 0 ? { description } : {}),
  };
}

function invocationName(directoryName: string, frontmatterName: string | undefined): string | null {
  if (frontmatterName && SAFE_NAME.test(frontmatterName)) return frontmatterName;
  if (SAFE_NAME.test(directoryName)) return directoryName;
  return null;
}

function clipDescription(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const oneLine = value.replace(/\s+/g, " ").trim();
  if (oneLine.length === 0) return undefined;
  return oneLine.length > 240 ? `${oneLine.slice(0, 239)}…` : oneLine;
}

function isInside(root: string, target: string): boolean {
  const relative = NodePath.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !NodePath.isAbsolute(relative));
}

function listSkillDirs(library: string): string[] {
  try {
    return NodeFS.readdirSync(library, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function readLibrary(homeDir: string, stateDir: string): SharedSkillsList {
  const library = agentsSkillsDir(homeDir);
  const state = readState(stateDir);
  const disabled = new Set(state.disabled.map((name) => name.toLowerCase()));
  const skills: SharedSkill[] = [];
  for (const directoryName of listSkillDirs(library)) {
    const directory = NodePath.join(library, directoryName);
    const skillFile = NodePath.join(directory, "SKILL.md");
    if (!NodeFS.existsSync(skillFile)) continue;
    const frontmatter = readSkillFrontmatter(skillFile);
    const name = invocationName(directoryName, frontmatter.name);
    if (name === null) continue;
    const managed = state.managed[directoryName];
    const enabled = !disabled.has(name.toLowerCase());
    const description = clipDescription(frontmatter.description);
    skills.push({
      name,
      ...(description === undefined ? {} : { description }),
      directoryName,
      path: skillFile,
      enabled,
      source: managed?.source ?? "elsewhere",
      origin:
        managed?.source === "git"
          ? (managed.url ?? "Git")
          : managed?.source === "folder"
            ? (managed.from ?? "Added from a folder")
            : "Managed elsewhere",
      harnesses: enabled ? SHARED_SKILL_HARNESSES_ON : SHARED_SKILL_HARNESSES_OFF,
      canRemove: managed !== undefined,
      canUpdate: managed?.source === "git",
    });
  }
  return { libraryRoot: library, skills };
}

export function enabledSharedSkillDirs(
  homeDir: string,
  stateDir: string,
): ReadonlyArray<{ readonly name: string; readonly directory: string }> {
  return readLibrary(homeDir, stateDir)
    .skills.filter((skill) => skill.enabled)
    .map((skill) => ({ name: skill.name, directory: NodePath.dirname(skill.path) }));
}

/**
 * Claude names a skill after the directory it scans. A plugin whose root is
 * the skill folder is published as `name:name`, so `$name` from the picker
 * misses. Linking `<state>/shared-skills-claude/.claude/skills/<name>` at the
 * library folder and granting that state directory makes the name plain.
 * Returns that directory when at least one link is wanted, otherwise undefined.
 * Real directories are left alone. Symlinks that point into the library and
 * are no longer wanted are removed.
 */
export function syncClaudeSharedSkillDirectory(input: {
  readonly homeDir: string;
  readonly stateDir: string;
  readonly nativeNames: ReadonlySet<string>;
  readonly platform: NodeJS.Platform;
}): string | undefined {
  const library = NodePath.resolve(agentsSkillsDir(input.homeDir));
  const root = NodePath.join(input.stateDir, CLAUDE_SHARED_DIR);
  const skillsDir = NodePath.join(root, ".claude", "skills");
  const wanted = new Map<string, string>();
  for (const skill of readLibrary(input.homeDir, input.stateDir).skills) {
    if (!skill.enabled || !SAFE_NAME.test(skill.name) || wanted.has(skill.name)) continue;
    const native =
      input.nativeNames.has(skill.name.toLowerCase()) ||
      input.nativeNames.has(skill.directoryName.toLowerCase());
    if (native) continue;
    wanted.set(skill.name, NodePath.resolve(NodePath.dirname(skill.path)));
  }

  let skillsDirPresent = false;
  try {
    const existing = NodeFS.lstatSync(skillsDir);
    skillsDirPresent = true;
    if (existing.isSymbolicLink()) {
      NodeFS.unlinkSync(skillsDir);
      skillsDirPresent = false;
    }
  } catch {
    skillsDirPresent = false;
  }
  if (wanted.size === 0 && !skillsDirPresent) return undefined;
  NodeFS.mkdirSync(skillsDir, { recursive: true });

  let entries: NodeFS.Dirent[] = [];
  try {
    entries = NodeFS.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const dest = NodePath.join(skillsDir, entry.name);
    let linked = false;
    try {
      linked = NodeFS.lstatSync(dest).isSymbolicLink();
    } catch {
      continue;
    }
    if (!linked) continue;
    let target: string;
    try {
      target = NodeFS.readlinkSync(dest);
    } catch {
      continue;
    }
    const resolved = NodePath.resolve(skillsDir, target);
    const desired = wanted.get(entry.name);
    const insideLibrary = isInside(library, resolved);
    if (desired !== undefined && NodePath.resolve(desired) === resolved) continue;
    if (!insideLibrary) continue;
    try {
      NodeFS.unlinkSync(dest);
    } catch {
      wanted.delete(entry.name);
    }
  }

  for (const [name, source] of wanted) {
    const dest = NodePath.join(skillsDir, name);
    try {
      NodeFS.lstatSync(dest);
      continue;
    } catch {
      // Missing, so the link can be created.
    }
    try {
      if (input.platform === "win32") NodeFS.symlinkSync(source, dest, "junction");
      else NodeFS.symlinkSync(source, dest);
    } catch {
      // One skill link must not block the session.
    }
  }
  return wanted.size > 0 ? root : undefined;
}

function removeHoldingRepo(stateDir: string, repo: string | undefined): void {
  if (repo === undefined) return;
  const root = NodePath.resolve(stateDir, HOLDING_REPOS_DIR);
  const target = NodePath.resolve(repo);
  if (!isInside(root, target) || NodePath.dirname(target) !== root) return;
  NodeFS.rmSync(target, { recursive: true, force: true });
}

function tomlBasic(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Session `-c` entries. A launch arg that already sets skills.config is kept. */
export function appendCodexSharedSkillDisable(
  launchArgs: string,
  disabledSkillFiles: readonly string[],
): string {
  const files = disabledSkillFiles.filter(
    (file) => !file.includes("'") && !file.includes("\n") && !file.includes("\0"),
  );
  if (files.length === 0) return launchArgs;
  if (
    /(?:^|\s)(?:--config|-c)(?:\s+|=)\s*skills\.config\b/.test(launchArgs) ||
    launchArgs.includes("skills.config=")
  ) {
    return launchArgs;
  }
  const flag = `-c 'skills.config=[${files
    .map((file) => `{path=${tomlBasic(file)},enabled=false}`)
    .join(",")}]'`;
  return launchArgs.trim().length === 0 ? flag : `${launchArgs.trim()} ${flag}`;
}

export function codexLaunchArgsWithSharedSkills(
  launchArgs: string | undefined,
  environment: NodeJS.ProcessEnv,
  homeDir: string,
  stateDir: string,
  resolve: (launchArgs: string | undefined, environment: NodeJS.ProcessEnv) => string,
): string {
  const base = resolve(launchArgs, environment);
  const disabled = readLibrary(homeDir, stateDir)
    .skills.filter((skill) => !skill.enabled)
    .map((skill) => skill.path);
  return appendCodexSharedSkillDisable(base, disabled);
}

function fail(message: string): never {
  throw new Error(message);
}

function lastUrlSegment(url: string): string | undefined {
  let last = "";
  for (const part of url.replace(/\.git$/, "").split(/[/:]/)) {
    if (part.length > 0) last = part;
  }
  return last.length > 0 ? last : undefined;
}

function assertGitRemote(url: string): void {
  if (/[\0\r\n]/.test(url)) fail("That Git URL is not usable.");
  if (/^(https?:\/\/|ssh:\/\/|git:\/\/)/i.test(url)) return;
  if (/^git@[^:\s]+:\S+$/.test(url)) return;
  if (url.startsWith("/") || url.startsWith("~/")) return;
  fail("Enter an https, ssh, or git URL.");
}

function runGit(args: readonly string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn("git", [...args], {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 500) stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Git timed out."));
    }, 60_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `Git exited ${code ?? "unknown"}.`));
    });
  });
}

function copyTree(source: string, destination: string): void {
  let files = 0;
  let bytes = 0;
  const walk = (from: string, to: string) => {
    NodeFS.mkdirSync(to, { recursive: true });
    for (const entry of NodeFS.readdirSync(from, { withFileTypes: true })) {
      if (
        entry.name === ".DS_Store" ||
        entry.name === "node_modules" ||
        entry.name === "__pycache__" ||
        entry.name === ".git"
      ) {
        continue;
      }
      const src = NodePath.join(from, entry.name);
      const dst = NodePath.join(to, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        walk(src, dst);
        continue;
      }
      if (!entry.isFile()) continue;
      const size = NodeFS.statSync(src).size;
      files += 1;
      bytes += size;
      if (files > MAX_FILES || bytes > MAX_BYTES) fail("That skill is too large to add.");
      NodeFS.copyFileSync(src, dst);
      const mode = NodeFS.statSync(src).mode & 0o111;
      if (mode !== 0) NodeFS.chmodSync(dst, NodeFS.statSync(src).mode & 0o777);
    }
  };
  walk(source, destination);
}

function skillDirsIn(source: string): string[] {
  if (NodeFS.existsSync(NodePath.join(source, "SKILL.md"))) return [source];
  let entries: NodeFS.Dirent[] = [];
  try {
    entries = NodeFS.readdirSync(source, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => NodePath.join(source, entry.name))
    .filter((dir) => NodeFS.existsSync(NodePath.join(dir, "SKILL.md")))
    .sort();
}

function removeDir(library: string, directoryName: string): void {
  const target = NodePath.join(library, directoryName);
  if (!isInside(library, target) || NodePath.dirname(target) !== library) {
    fail("That skill is outside the library.");
  }
  NodeFS.rmSync(target, { recursive: true, force: true });
}

function findByName(list: SharedSkillsList, name: string): SharedSkill | undefined {
  const key = name.toLowerCase();
  return list.skills.find((skill) => skill.name.toLowerCase() === key);
}

export async function applySharedSkillsCommand(input: {
  readonly homeDir: string;
  readonly stateDir: string;
  readonly command: SharedSkillsCommand;
}): Promise<SharedSkillsList> {
  const library = agentsSkillsDir(input.homeDir);
  NodeFS.mkdirSync(library, { recursive: true });
  const state = readState(input.stateDir);
  const command = input.command;

  if (command.type === "setSharing") {
    const disabled = state.disabled.filter(
      (name) => name.toLowerCase() !== command.name.toLowerCase(),
    );
    writeState(input.stateDir, {
      ...state,
      disabled: command.enabled ? disabled : [...disabled, command.name],
    });
    return readLibrary(input.homeDir, input.stateDir);
  }

  if (command.type === "remove") {
    const current = readLibrary(input.homeDir, input.stateDir);
    const skill = findByName(current, command.name);
    if (!skill) fail("That skill is not in the library.");
    if (!skill.canRemove) fail("That skill is managed elsewhere.");
    const managed = state.managed[skill.directoryName];
    removeDir(library, skill.directoryName);
    const nextManaged = { ...state.managed };
    delete nextManaged[skill.directoryName];
    if (managed?.repo && !Object.values(nextManaged).some((entry) => entry.repo === managed.repo)) {
      removeHoldingRepo(input.stateDir, managed.repo);
    }
    writeState(input.stateDir, { ...state, managed: nextManaged });
    return readLibrary(input.homeDir, input.stateDir);
  }

  if (command.type === "update") {
    const current = readLibrary(input.homeDir, input.stateDir);
    const skill = findByName(current, command.name);
    if (!skill) fail("That skill is not in the library.");
    if (!skill.canUpdate) fail("Only a skill added from Git can be updated here.");
    const managed = state.managed[skill.directoryName];
    if (!managed) fail("Only a skill added from Git can be updated here.");
    try {
      if (managed.repo) {
        await runGit(["pull", "--ff-only"], managed.repo);
        const source = NodePath.join(managed.repo, managed.child ?? skill.directoryName);
        if (!NodeFS.existsSync(NodePath.join(source, "SKILL.md"))) {
          fail("The repository no longer has that skill.");
        }
        removeDir(library, skill.directoryName);
        copyTree(source, NodePath.join(library, skill.directoryName));
      } else {
        await runGit(["pull", "--ff-only"], NodePath.join(library, skill.directoryName));
      }
    } catch {
      fail("Git could not update that skill.");
    }
    return readLibrary(input.homeDir, input.stateDir);
  }

  if (command.type === "addFolder") {
    const expanded = command.path.startsWith("~/")
      ? NodePath.join(NodeOS.homedir(), command.path.slice(2))
      : command.path;
    const source = NodePath.resolve(expanded);
    if (isInside(library, source)) fail("That folder is already in the library.");
    const dirs = skillDirsIn(source);
    if (dirs.length === 0) fail("That folder has no SKILL.md.");
    const planned = dirs.map((dir) => ({ dir, name: NodePath.basename(dir) }));
    for (const item of planned) {
      if (!SAFE_NAME.test(item.name)) fail("That skill's folder name is not usable.");
      if (NodeFS.existsSync(NodePath.join(library, item.name))) {
        fail("That skill is already in the library.");
      }
    }
    const managed = { ...state.managed };
    for (const item of planned) {
      copyTree(item.dir, NodePath.join(library, item.name));
      managed[item.name] = { source: "folder", from: item.dir };
    }
    writeState(input.stateDir, { ...state, managed });
    return readLibrary(input.homeDir, input.stateDir);
  }

  assertGitRemote(command.url);
  const tempRoot = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sshcode-skill-"));
  try {
    try {
      await runGit(["clone", "--depth", "1", command.url, tempRoot]);
    } catch {
      fail("Git could not clone that repository.");
    }
    const dirs = skillDirsIn(tempRoot);
    if (dirs.length === 0) fail("That repository has no SKILL.md.");
    const rootSkill = dirs.length === 1 && dirs[0] === tempRoot;
    const managed = { ...state.managed };
    if (rootSkill) {
      const frontmatter = readSkillFrontmatter(NodePath.join(tempRoot, "SKILL.md"));
      const repoName = lastUrlSegment(command.url);
      const name = invocationName(
        repoName !== undefined && SAFE_NAME.test(repoName) ? repoName : "skill",
        frontmatter.name,
      );
      if (name === null) fail("That skill's name is not usable.");
      const destination = NodePath.join(library, name);
      if (NodeFS.existsSync(destination)) fail("That skill is already in the library.");
      NodeFS.renameSync(tempRoot, destination);
      managed[name] = { source: "git", url: command.url };
      writeState(input.stateDir, { ...state, managed });
      return readLibrary(input.homeDir, input.stateDir);
    }
    const slug = (lastUrlSegment(command.url) ?? "repo").replace(/[^A-Za-z0-9._-]/g, "-");
    const repoDir = NodePath.join(input.stateDir, HOLDING_REPOS_DIR, slug || "repo");
    if (NodeFS.existsSync(repoDir)) fail("That repository is already installed.");
    NodeFS.mkdirSync(NodePath.dirname(repoDir), { recursive: true });
    NodeFS.renameSync(tempRoot, repoDir);
    for (const dir of dirs) {
      const name = NodePath.basename(dir);
      if (!SAFE_NAME.test(name)) fail("That skill's folder name is not usable.");
      if (NodeFS.existsSync(NodePath.join(library, name)))
        fail("That skill is already in the library.");
    }
    for (const dir of dirs) {
      const name = NodePath.basename(dir);
      copyTree(dir, NodePath.join(library, name));
      managed[name] = { source: "git", url: command.url, repo: repoDir, child: name };
    }
    writeState(input.stateDir, { ...state, managed });
    return readLibrary(input.homeDir, input.stateDir);
  } finally {
    NodeFS.rmSync(tempRoot, { recursive: true, force: true });
  }
}
