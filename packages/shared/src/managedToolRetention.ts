// @effect-diagnostics nodeBuiltinImport:off -- Process inspection and lstat require OS-specific Node APIs.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import * as HostProcess from "./HostProcess.ts";

const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const scanOptions = { timeout: 10_000, maxBuffer: 32 * 1024 * 1024 };
const hasCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code;

export const isManagedToolVersion = (name: string) =>
  /^v?\d+(?:\.\d+){2,3}(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(name);

export type ManagedToolProcesses = { readonly uses: (directory: string) => boolean };

// Match directory boundaries and keep the scan private. Command lines can contain secrets.
function references(haystack: string, directory: string) {
  let offset = 0;
  for (;;) {
    const index = haystack.indexOf(directory, offset);
    if (index === -1) return false;
    offset = index + directory.length;
    const next = haystack[offset];
    if (next === undefined || /[/\\\s\0'":]/u.test(next)) return true;
  }
}

/**
 * Gone, or a same-user process the kernel will not show us (another user
 * namespace, a confined profile). Containers and sandboxed apps are common, so
 * one of them must not stop every prune. Its command line is still checked
 * through the `ps` listing.
 */
const cannotInspect = (error: unknown) =>
  ["ENOENT", "ESRCH", "EACCES", "EPERM"].some((code) => hasCode(error, code));

async function readLinuxProcessPaths() {
  const paths: string[] = [];
  const optional = <A>(read: Promise<A>, missing: A) =>
    read.catch((error: unknown) => {
      if (cannotInspect(error)) return missing;
      throw error;
    });
  for (const pid of await NodeFSP.readdir("/proc")) {
    if (!/^\d+$/u.test(pid)) continue;
    const directory = "/proc/" + pid;
    const owner = await optional(
      NodeFSP.stat(directory).then((info): number | undefined => info.uid),
      undefined,
    );
    if (owner === undefined || owner !== process.getuid?.()) continue;
    paths.push(
      await optional(NodeFSP.readlink(directory + "/exe"), ""),
      await optional(NodeFSP.readlink(directory + "/cwd"), ""),
      await optional(NodeFSP.readFile(directory + "/maps", "utf8"), ""),
    );
    for (const fd of await optional(NodeFSP.readdir(directory + "/fd"), [])) {
      paths.push(await optional(NodeFSP.readlink(directory + "/fd/" + fd), ""));
    }
  }
  return paths.join("\0");
}

export const scanManagedToolProcesses = Effect.tryPromise(async (signal) => {
  const options = { ...scanOptions, signal };
  // Inspect the actual kernel even when a provider test overrides its platform.
  const platform = HostProcess.Platform.defaultValue();
  if (platform === "win32") {
    const { stdout } = await exec(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | ForEach-Object { $_.ExecutablePath; $_.CommandLine }",
      ],
      { ...options, windowsHide: true },
    );
    const normalize = (value: string) => value.toLowerCase().replaceAll("\\", "/");
    const processes = normalize(stdout);
    return processes.trim()
      ? { uses: (directory: string) => references(processes, normalize(directory)) }
      : null;
  }
  if (platform !== "darwin" && platform !== "linux") return null;
  const { stdout: commands } = await exec("/bin/ps", ["-axww", "-o", "command="], options);
  if (!commands.trim()) return null;
  const files =
    platform === "darwin"
      ? (
          await exec(
            "/usr/sbin/lsof",
            ["-nP", "-a", "-u", String(process.getuid?.()), "-F0n"],
            options,
          )
        ).stdout
      : await readLinuxProcessPaths();
  if (!files.trim()) return null;
  return {
    uses: (directory: string) => references(commands, directory) || references(files, directory),
  };
}).pipe(Effect.orElseSucceed(() => null));

const safeDirectory = async (directory: string, expected: string) => {
  const info = await NodeFSP.lstat(directory);
  return info.isDirectory() && (await NodeFSP.realpath(directory)) === expected ? info : null;
};

const io = <A>(run: () => Promise<A>) => Effect.tryPromise(run);

export interface ManagedToolPruneResult {
  readonly candidates: ReadonlyArray<string>;
  readonly skippedInUse: ReadonlyArray<string>;
  readonly processScanFailed: boolean;
}

const nothingToPrune: ManagedToolPruneResult = {
  candidates: [],
  skippedInUse: [],
  processScanFailed: false,
};

/** Call under the install/activation lock when the installer has one. Dry runs never write. */
export const pruneManagedToolVersions = Effect.fn("pruneManagedToolVersions")(function* <
  E,
  R,
>(input: {
  readonly toolsDirectory: string;
  readonly versionsDirectory: string;
  readonly current: string;
  readonly rollback?: string | undefined;
  readonly isVersion?: (name: string) => boolean;
  readonly compareVersions?: (left: string, right: string) => number;
  readonly completed: (name: string, directory: string) => Effect.Effect<boolean, E, R>;
  readonly leased?: (name: string) => Effect.Effect<boolean, E, R>;
  readonly processes?: Effect.Effect<ManagedToolProcesses | null>;
  readonly dryRun?: boolean;
  readonly stillCurrent?: Effect.Effect<boolean, E, R>;
}) {
  const isVersion = input.isVersion ?? isManagedToolVersion;
  const tools = NodePath.resolve(input.toolsDirectory);
  const relative = NodePath.relative(tools, NodePath.resolve(input.versionsDirectory));
  if (!relative || NodePath.isAbsolute(relative) || relative.split(NodePath.sep).includes("..")) {
    return nothingToPrune;
  }
  if (!isVersion(input.current)) return nothingToPrune;

  // Parent aliases such as macOS /tmp are normal. Reject links from tools/ down.
  const canonicalParent = yield* io(() => NodeFSP.realpath(NodePath.dirname(tools))).pipe(
    Effect.option,
  );
  if (canonicalParent._tag === "None") return nothingToPrune;
  const expectedTools = NodePath.join(canonicalParent.value, NodePath.basename(tools));
  const inspectRoot = io(async () => {
    if (!(await safeDirectory(tools, expectedTools))) return null;
    let directory = tools;
    let canonical = expectedTools;
    for (const component of relative.split(NodePath.sep)) {
      directory = NodePath.join(directory, component);
      canonical = NodePath.join(canonical, component);
      if (!(await safeDirectory(directory, canonical))) return null;
    }
    return canonical;
  }).pipe(Effect.orElseSucceed(() => null));

  const root = yield* inspectRoot;
  if (root === null) return nothingToPrune;
  const versions = yield* io(() => NodeFSP.readdir(root));
  const completed = [];
  for (const name of versions) {
    if (!isVersion(name)) continue;
    const directory = NodePath.join(root, name);
    const info = yield* io(() => safeDirectory(directory, directory)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (info && (yield* input.completed(name, directory)))
      completed.push({ name, directory, info });
  }
  if (!completed.some(({ name }) => name === input.current)) return nothingToPrune;

  const others = completed
    .filter(({ name }) => name !== input.current)
    .sort((a, b) =>
      input.compareVersions
        ? input.compareVersions(b.name, a.name)
        : b.info.mtimeMs - a.info.mtimeMs || b.name.localeCompare(a.name, "en", { numeric: true }),
    );
  const rollback = others.find(({ name }) => name === input.rollback) ?? others[0];
  const obsolete = others.filter(({ name }) => name !== rollback?.name);
  if (obsolete.length === 0) return nothingToPrune;

  const processes = yield* input.processes ?? scanManagedToolProcesses;
  if (processes === null) return { ...nothingToPrune, processScanFailed: true };
  const candidates: string[] = [];
  const skippedInUse: string[] = [];
  for (const { name, directory, info } of obsolete) {
    if (
      processes.uses(directory) ||
      processes.uses(NodePath.join(tools, relative, name)) ||
      (input.leased && (yield* input.leased(name)))
    ) {
      skippedInUse.push(directory);
      continue;
    }
    if (input.stillCurrent && !(yield* input.stillCurrent)) break;
    if ((yield* inspectRoot) !== root) break;
    const current = yield* io(() => safeDirectory(directory, directory)).pipe(
      Effect.orElseSucceed(() => null),
    );
    if (current?.dev !== info.dev || current.ino !== info.ino) continue;
    if (!input.dryRun) yield* io(() => NodeFSP.rm(directory, { recursive: true, force: true }));
    candidates.push(directory);
  }
  return { candidates, skippedInUse, processScanFailed: false } satisfies ManagedToolPruneResult;
});
