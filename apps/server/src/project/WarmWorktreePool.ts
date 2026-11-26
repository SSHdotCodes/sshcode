// @effect-diagnostics nodeBuiltinImport:off -- load averages gate host-local maintenance.
import * as NodeOS from "node:os";
import { lock } from "proper-lockfile";
import { ProjectId, T3_PROJECT_FILE_NAME, ThreadId } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  projectScriptRuntimeEnv,
  projectScriptsInheritDefaults,
  resolveProjectScripts,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import * as ExecutionResources from "../execution/ExecutionResources.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { freeDiskBytes } from "../phoneAlerts/diskSpace.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  LEGACY_PARKED_WORKTREES_DIRECTORY,
  WARM_WORKTREES_DIRECTORY,
  recycledWorktreeRecordName,
  warmWorktreeRecordName,
} from "../worktreesDirectory.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

const MAX_SLOTS = 2;
const MAX_RECENT_REPOSITORIES = 16;
const MAX_IDLE_MS = Duration.toMillis(Duration.days(7));
const MIN_FREE_BYTES = 12 * 1024 ** 3;
const SLOW_GIT_MS = 300_000;
const SLOT_FILE = /^([0-9a-f-]{36})\.pool\.json$/;
const GitCommit = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/));
const isGitCommit = Schema.is(GitCommit);
const SetupReceipt = Schema.fromJsonString(
  Schema.Struct({ commit: GitCommit, key: Schema.String }),
);
const encodeReceipt = Schema.encodeEffect(SetupReceipt);
const decodeReceipt = Schema.decodeUnknownEffect(SetupReceipt);

const Target = Schema.Struct({
  gitDir: Schema.String,
  cwd: Schema.String,
  projectId: ProjectId,
  commit: GitCommit,
  usedAt: Schema.Finite,
  activeSince: Schema.Finite,
  setupKey: Schema.String,
});
type Target = typeof Target.Type;

const Slot = Schema.Struct({
  gitDir: Schema.String,
  setupPid: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(1))),
  recycled: Schema.optionalKey(Schema.Boolean),
  ready: Schema.optionalKey(
    Schema.Struct({ commit: GitCommit, key: Schema.String, activeSince: Schema.Finite }),
  ),
  claim: Schema.optionalKey(
    Schema.Struct({
      threadId: ThreadId,
      branch: Schema.String,
      commit: GitCommit,
      ownsBranch: Schema.optionalKey(Schema.Boolean),
    }),
  ),
});
type Slot = typeof Slot.Type;
const SlotJson = Schema.fromJsonString(Slot);
const TargetsJson = Schema.fromJsonString(Schema.Array(Target));
const decodeSlot = Schema.decodeUnknownEffect(SlotJson);
const decodeTargets = Schema.decodeUnknownEffect(TargetsJson);
const encodeSlot = Schema.encodeEffect(SlotJson);
const encodeTargets = Schema.encodeEffect(TargetsJson);

class WarmWorktreeError extends Schema.TaggedError<WarmWorktreeError>()("WarmWorktreeError", {
  operation: Schema.String,
}) {}

interface ClaimInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly ref: string;
  readonly baseRef: string;
  readonly branch: string;
  /** Runs before cancellation can reach the caller. The thread must publish or abandon the lease. */
  readonly onClaimed: (lease: WorktreeLease) => void;
}

interface WorktreeLease {
  readonly path: string;
  /** The thread's workspace metadata has committed. */
  readonly publish: Effect.Effect<void>;
  readonly abandon: Effect.Effect<void>;
}

interface ReleaseInput {
  readonly cwd: string;
  readonly path: string;
  readonly expectedHead?: string;
  readonly force?: boolean | undefined;
}

interface RecordSetupInput {
  readonly projectId: ProjectId;
  readonly cwd: string;
  readonly worktreePath: string;
  readonly command: string;
}

export class WarmWorktreePool extends Context.Service<
  WarmWorktreePool,
  {
    readonly claim: (input: ClaimInput) => Effect.Effect<WorktreeLease | null>;
    readonly recordSetup: (input: RecordSetupInput) => Effect.Effect<void>;
    /** The caller holds the workspace lease through a possible Git removal. */
    readonly recycle: (input: ReleaseInput) => Effect.Effect<"recycled" | "in-use" | "unavailable">;
  }
>()("t3/project/WarmWorktreePool") {}

const checkHostIdle = Effect.sync(
  () => (NodeOS.loadavg()[0] ?? Infinity) < Math.max(2, NodeOS.availableParallelism() / 2),
);

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export const make = (options?: {
  readonly hostIdle?: Effect.Effect<boolean>;
  readonly availableBytes?: (directory: string) => Effect.Effect<number | null>;
}) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const platform = yield* HostProcess.Platform;
    const architecture = yield* HostProcess.Architecture;
    const env = yield* HostProcess.Environment;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const settings = yield* ServerSettings.ServerSettingsService;
    const git = yield* GitVcsDriver.GitVcsDriver;
    const projects = yield* ProjectService.ProjectService;
    const threads = yield* ProjectionStore.ProjectionStoreV2;
    const ownership = yield* Effect.serviceOption(ExecutionResources.ExecutionResources);
    const terminals = yield* Effect.serviceOption(TerminalManager.TerminalManager);
    const setup = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Effect.scope;
    const availableBytes = options?.availableBytes ?? freeDiskBytes;

    // Windows uses a different shell and has no nice. Its normal launch path still applies.
    if (platform !== "darwin" && platform !== "linux") {
      return {
        claim: () => Effect.succeed(null),
        recordSetup: () => Effect.void,
        recycle: () => Effect.succeed("unavailable" as const),
        maintain: Effect.void,
      } satisfies WarmWorktreePool["Service"] & { maintain: Effect.Effect<void> };
    }
    const perRepo =
      env.T3CODE_WARM_WORKTREES_PER_REPO === "0"
        ? 0
        : env.T3CODE_WARM_WORKTREES_PER_REPO === "2"
          ? 2
          : 1;
    const shell = env.SHELL || "/bin/sh";
    const root = path.join(
      yield* fs
        .realPath(config.worktreesDir)
        .pipe(Effect.orElseSucceed(() => path.resolve(config.worktreesDir))),
      WARM_WORKTREES_DIRECTORY,
    );
    const recentFile = path.join(root, "recent.json");
    const managedRoot = path.dirname(root);
    const recent = new Map<string, Target>();
    const occupied = new Set<string>();
    const attempted = new Map<string, number>();
    const claimGate = yield* Semaphore.make(1);
    const reservationGate = yield* Semaphore.make(1);
    const recentGate = yield* Semaphore.make(1);
    let releasesInFlight = 0;
    let ownsPool = false;
    let loaded = false;
    let recentChanged = false;
    let legacyCleaned = false;

    const recordPath = (slot: string) => {
      const name =
        path.dirname(slot) === root
          ? warmWorktreeRecordName(path.basename(slot))
          : recycledWorktreeRecordName(slot, managedRoot, path);
      if (path.dirname(slot) === root && name !== null && !SLOT_FILE.test(name)) return null;
      return name === null ? null : path.join(root, name);
    };
    const writeRecord = (slot: string, record: Slot) =>
      Effect.gen(function* () {
        const filePath = recordPath(slot);
        if (filePath === null) return yield* new WarmWorktreeError({ operation: "record slot" });
        return yield* encodeSlot(record).pipe(
          Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
        );
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    const forget = (slot: string) => {
      const filePath = recordPath(slot);
      return filePath === null ? Effect.void : fs.remove(filePath, { force: true });
    };
    const readRecord = (slot: string) => {
      const filePath = recordPath(slot);
      if (filePath === null) return Effect.succeed(null);
      return fs.readFileString(filePath).pipe(
        Effect.flatMap(decodeSlot),
        Effect.orElseSucceed(() => null),
      );
    };
    const runGit = (cwd: string, args: readonly string[], background = false) =>
      git.execute({
        operation: "WarmWorktreePool.git",
        cwd,
        args,
        allowNonZeroExit: true,
        ...(background ? { priority: "background" as const, timeoutMs: SLOW_GIT_MS } : {}),
      });
    const run = (cwd: string, args: readonly string[], background = false) =>
      runGit(cwd, args, background).pipe(
        Effect.flatMap((result) =>
          result.exitCode === 0 && !result.stdoutTruncated
            ? Effect.succeed(result.stdout)
            : Effect.fail(new WarmWorktreeError({ operation: args[0] ?? "git" })),
        ),
      );

    const acquireOwner = Effect.gen(function* () {
      if (ownsPool) return;
      yield* fs.makeDirectory(root, { recursive: true, mode: 0o700 });
      if ((yield* fs.realPath(root)) !== root) return;
      const release = yield* Effect.tryPromise(() =>
        lock(path.join(root, "owner"), {
          realpath: false,
          stale: 30_000,
          onCompromised: () => {
            ownsPool = false;
          },
        }),
      ).pipe(Effect.option);
      if (Option.isNone(release)) return;
      yield* Scope.addFinalizer(
        scope,
        Effect.tryPromise(() => release.value()).pipe(Effect.ignore),
      );
      ownsPool = true;
    }).pipe(Effect.uninterruptible, Effect.ignore);

    const loadRecent = Effect.gen(function* () {
      if (loaded) return;
      const stored = yield* fs.readFileString(recentFile).pipe(
        Effect.flatMap(decodeTargets),
        Effect.orElseSucceed(() => []),
      );
      for (const target of stored.slice(0, MAX_RECENT_REPOSITORIES)) {
        if (!recent.has(target.gitDir)) recent.set(target.gitDir, target);
      }
      loaded = true;
    });

    const orderedRecent = () => [...recent.values()].sort((a, b) => b.usedAt - a.usedAt);
    const remember = (target: Target) => {
      recent.set(target.gitDir, target);
      for (const old of orderedRecent().slice(MAX_RECENT_REPOSITORIES)) {
        recent.delete(old.gitDir);
        attempted.delete(old.gitDir);
      }
      recentChanged = true;
    };
    const saveRecent = Effect.gen(function* () {
      if (!recentChanged) return;
      recentChanged = false;
      yield* encodeTargets(orderedRecent()).pipe(
        Effect.flatMap((contents) => writeFileStringAtomically({ filePath: recentFile, contents })),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.tapError(() =>
          Effect.sync(() => {
            recentChanged = true;
          }),
        ),
      );
    }).pipe(recentGate.withPermit);

    const slots = Effect.gen(function* () {
      const entries = yield* fs.readDirectory(root);
      const paths = entries.flatMap((entry) => {
        const name = SLOT_FILE.exec(entry)?.[1];
        if (name !== undefined) return [path.join(root, name)];
        if (!entry.startsWith("recycled-") || !entry.endsWith(".pool.json")) return [];
        try {
          const slot = path.join(managedRoot, decodeURIComponent(entry.slice(9, -10)));
          return path.join(root, entry) === recordPath(slot) ? [slot] : [];
        } catch {
          return [];
        }
      });
      // A malformed record still counts toward the cap. Never mutate its checkout.
      return yield* Effect.forEach(paths, (slot) =>
        readRecord(slot).pipe(Effect.map((record) => ({ record, slot }))),
      );
    });

    const wantedRepositories = () => orderedRecent().slice(0, MAX_SLOTS);
    const reserveSlot = Effect.fnUntraced(function* (slot: string, gitDir: string, record: Slot) {
      if (!record.recycled && releasesInFlight > 0) return false;
      const wanted = wantedRepositories();
      if (!wanted.some((target) => target.gitDir === gitDir)) return false;
      const current = yield* slots;
      const capacity = wanted.length === 1 ? perRepo : 1;
      if (
        current.length >= MAX_SLOTS ||
        current.filter((entry) => entry.record?.gitDir === gitDir).length >= capacity
      )
        return false;
      // Save the demand record even when the first release beats the refill tick.
      yield* saveRecent;
      yield* writeRecord(slot, record);
      return true;
    }, reservationGate.withPermit);

    const identify = Effect.fnUntraced(function* (cwd: string) {
      const output = yield* run(cwd, [
        "rev-parse",
        "--path-format=absolute",
        "--show-toplevel",
        "--git-common-dir",
      ]);
      const [top, common, end] = output.split("\n");
      if (!top || !common || end !== "" || !path.isAbsolute(top) || !path.isAbsolute(common)) {
        return yield* new WarmWorktreeError({ operation: "identify repository" });
      }
      return { top: yield* fs.realPath(top), gitDir: yield* fs.realPath(common) };
    });

    const plan = Effect.fnUntraced(function* (target: Omit<Target, "setupKey">) {
      const [project, serverSettings] = yield* Effect.all(
        [projects.getById(target.projectId), settings.getSettings],
        { concurrency: 2 },
      );
      if (serverSettings.worktreesDirectory !== "" || Option.isNone(project)) return null;
      const source = project.value;
      const fileName = T3_PROJECT_FILE_NAME;
      const tree = yield* run(target.cwd, [
        "ls-tree",
        "--full-tree",
        "-z",
        target.commit,
        "--",
        fileName,
        ".gitmodules",
      ]);
      const rootEntries = tree.split("\0");
      if (rootEntries.some((entry) => entry.endsWith("\t.gitmodules"))) return null;
      const configEntry = rootEntries.find((entry) => entry.endsWith(`\t${fileName}`));
      if (configEntry !== undefined && !/^100(?:644|755) blob /.test(configEntry)) return null;
      const file =
        configEntry !== undefined
          ? parseT3ProjectFile(yield* run(target.cwd, ["show", `${target.commit}:${fileName}`]))
          : null;
      if (configEntry !== undefined && file === null) return null;
      const cache = file?.worktreeSetupCache;
      const declared = file?.scripts?.find((script) => script.runOnWorktreeCreate);
      const script = setupProjectScript(resolveProjectScripts(serverSettings, source));
      const command =
        script?.command ??
        (projectScriptsInheritDefaults(serverSettings, source) ? declared?.command : undefined) ??
        null;
      if (command !== null && (!cache || command !== declared?.command)) return null;

      // Cold Git invokes post-checkout before setup. Only reuse where that hook
      // would be absent at checkout time, including ignored, generated dispatchers.
      const gitConfig = yield* runGit(target.cwd, [
        "config",
        "--null",
        "--get-regexp",
        "^(core\\.(hookspath|sparsecheckout|ignorestat|autocrlf|eol|symlinks|fsmonitor)|branch\\.autosetupmerge|extensions\\.worktreeconfig|filter\\.)",
      ]);
      if (gitConfig.stdoutTruncated || (gitConfig.exitCode !== 0 && gitConfig.exitCode !== 1))
        return null;
      const configEntries = new Map(
        gitConfig.stdout.split("\0").flatMap((entry) => {
          const newline = entry.indexOf("\n");
          return newline < 0 ? [] : [[entry.slice(0, newline), entry.slice(newline + 1)] as const];
        }),
      );
      if (configEntries.has("core.sparsecheckout") || configEntries.has("core.ignorestat"))
        return null;
      if (["always", "inherit"].includes(configEntries.get("branch.autosetupmerge") ?? ""))
        return null;
      const hooks = configEntries.get("core.hookspath") ?? path.join(target.gitDir, "hooks");
      if (path.isAbsolute(hooks)) {
        if (hooks !== "/dev/null" && (yield* fs.exists(path.join(hooks, "post-checkout"))))
          return null;
      } else {
        const segments = hooks.split("/");
        if (segments.some((segment) => segment === "..")) return null;
        const hookPath = path.join(hooks, "post-checkout");
        // Check ancestors for symlinks that could make a relative hooks path leave the tree.
        const hookEntries = yield* run(target.cwd, [
          "--literal-pathspecs",
          "ls-tree",
          "--full-tree",
          "-t",
          target.commit,
          "--",
          ...segments.map((_, i) => segments.slice(0, i + 1).join("/")),
          hookPath,
        ]);
        if (
          /^120000 /m.test(hookEntries) ||
          hookEntries.split("\n").some((entry) => entry.endsWith(`\t${hookPath}`))
        )
          return null;
      }

      const key = [
        command === null ? "no setup" : 1,
        process.version,
        architecture,
        shell,
        env.PATH,
        gitConfig.stdout,
      ].join("\0");
      const hash = yield* crypto.digest("SHA-256", new TextEncoder().encode(key));
      return {
        command,
        key: Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join(""),
        inputs: [
          `:(top,literal)${fileName}`,
          ":(top,literal).gitmodules",
          ":(top,glob)**/.gitattributes",
          ...(cache?.inputs ?? []).map((glob) => `:(top,glob)${glob}`),
        ],
      };
    });

    const sameInputs = Effect.fnUntraced(function* (
      target: Target,
      ready: typeof SetupReceipt.Type,
      setupPlan: NonNullable<Effect.Success<ReturnType<typeof plan>>>,
    ) {
      if (ready.key !== setupPlan.key) return false;
      if (ready.commit === target.commit) return true;
      const diff = yield* runGit(target.cwd, [
        "diff",
        "--quiet",
        "--no-ext-diff",
        "--no-relative",
        ready.commit,
        target.commit,
        "--",
        ...setupPlan.inputs,
        ":(top,glob)**/node_modules/**",
      ]);
      return diff.exitCode === 0;
    });

    const runPhase = Effect.fnUntraced(function* (
      target: Target,
      slot: string,
      command: string,
      phase: "prepare" | "reuse",
      recycled = false,
    ) {
      // A hard crash can leave a detached command running. Record its process
      // group before letting it install, so a restarted server waits to remove it.
      const prepareArgs = [
        "/bin/sh",
        "-c",
        'IFS= read -r ready || exit 1; exec "$0" -c "$1"',
        shell,
        command,
      ];
      const childCommand = ChildProcess.make(
        "nice",
        ["-n", "15", ...(phase === "prepare" ? prepareArgs : [shell, "-c", command])],
        {
          cwd: slot,
          extendEnv: true,
          env: {
            ...projectScriptRuntimeEnv({ project: { cwd: target.cwd }, worktreePath: slot }),
            T3CODE_SUBAGENT_WORKTREE: "1",
            T3CODE_WORKTREE_SETUP_CACHE: phase,
            COLORTERM: "",
            NO_COLOR: "1",
            FORCE_COLOR: "0",
          },
          stdin: phase === "prepare" ? "pipe" : "ignore",
          stdout: "ignore",
          stderr: "ignore",
          detached: true,
          forceKillAfter: "2 seconds",
        },
      );
      const install = Effect.scoped(
        Effect.gen(function* () {
          const child = yield* spawner.spawn(childCommand);
          yield* writeRecord(slot, {
            gitDir: target.gitDir,
            setupPid: child.pid,
            ...(recycled ? { recycled } : {}),
          });
          yield* Stream.make("start\n").pipe(Stream.encodeText, Stream.run(child.stdin));
          return yield* child.exitCode;
        }),
      );
      const diskPressure = Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep("5 seconds");
          if (((yield* availableBytes(root)) ?? 0) < MIN_FREE_BYTES) {
            return yield* new WarmWorktreeError({ operation: "disk pressure" });
          }
        }),
      );
      const code = yield* phase === "prepare"
        ? Effect.raceFirst(install, diskPressure).pipe(Effect.timeout("10 minutes"))
        : spawner.exitCode(childCommand).pipe(Effect.timeout("5 seconds"));
      if (code !== 0) return yield* new WarmWorktreeError({ operation: phase });
    });

    const ownsCheckout = (slot: string, gitDir: string) =>
      identify(slot).pipe(
        Effect.map((repo) => repo.top === slot && repo.gitDir === gitDir),
        Effect.orElseSucceed(() => false),
      );
    const modulesReady = (slot: string) => {
      const modules = path.join(slot, "node_modules");
      return Effect.gen(function* () {
        return (
          (yield* fs.realPath(modules)) === modules &&
          (yield* fs.stat(modules)).type === "Directory"
        );
      }).pipe(Effect.orElseSucceed(() => false));
    };
    const clean = (slot: string, keepModules: boolean, background: boolean) =>
      run(slot, ["clean", "-qffdx", ...(keepModules ? ["-e", "node_modules/"] : [])], background);
    const checkout = (slot: string, commit: string, background: boolean, force = false) =>
      run(
        slot,
        [
          "-c",
          "checkout.workers=1",
          "checkout",
          "-q",
          ...(force ? ["--force"] : []),
          "--detach",
          commit,
        ],
        background,
      );
    const trackedChanges = (slot: string, background: boolean) =>
      run(
        slot,
        ["status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=none"],
        background,
      );

    const receiptPath = Effect.fnUntraced(function* (slot: string, common: string) {
      const admin = yield* fs.realPath(
        (yield* run(slot, ["rev-parse", "--absolute-git-dir"])).trimEnd(),
      );
      return path.dirname(admin) === path.join(common, "worktrees")
        ? path.join(admin, "t3-setup.json")
        : null;
    });
    const writeReceipt = Effect.fnUntraced(function* (
      slot: string,
      common: string,
      receipt: typeof SetupReceipt.Type,
    ) {
      const filePath = yield* receiptPath(slot, common);
      if (filePath === null) return;
      yield* writeFileStringAtomically({ filePath, contents: yield* encodeReceipt(receipt) }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    });
    const readReceipt = Effect.fnUntraced(function* (slot: string, common: string) {
      const filePath = yield* receiptPath(slot, common);
      if (filePath === null) return null;
      return yield* fs.readFileString(filePath).pipe(
        Effect.flatMap(decodeReceipt),
        Effect.orElseSucceed(() => null),
      );
    });

    const setupInputsDirty = Effect.fnUntraced(function* (slot: string, inputs: readonly string[]) {
      const diff = yield* runGit(slot, [
        "diff",
        "--quiet",
        "--no-ext-diff",
        "HEAD",
        "--",
        ...inputs,
      ]);
      if (diff.exitCode !== 0) return true;
      return (
        (yield* run(slot, ["ls-files", "--others", "--exclude=node_modules/", "--", ...inputs])) !==
        ""
      );
    });

    const recordSetup: WarmWorktreePool["Service"]["recordSetup"] = Effect.fn(
      "WarmWorktreePool.recordSetup",
    )(
      function* ({ cwd, projectId, worktreePath, command }) {
        if (!ownsPool || perRepo === 0) return;
        const slot = yield* fs.realPath(worktreePath);
        if (recordPath(slot) === null || !(yield* modulesReady(slot))) return;
        const { gitDir } = yield* identify(cwd);
        if (!(yield* ownsCheckout(slot, gitDir))) return;
        const { commitSha: commit } = yield* git.resolveCommit({ cwd: slot, revision: "HEAD" });
        const now = yield* Clock.currentTimeMillis;
        const setupPlan = yield* plan({
          cwd,
          projectId,
          gitDir,
          commit,
          usedAt: now,
          activeSince: now,
        });
        if (setupPlan === null || setupPlan.command !== command) return;
        if (yield* setupInputsDirty(slot, setupPlan.inputs)) return;
        yield* writeReceipt(slot, gitDir, { commit, key: setupPlan.key });
      },
      (effect) => effect.pipe(Effect.ignore),
    );

    /** Saved chats (including archived ones) may reopen at the same path later. */
    const referenced = Effect.fnUntraced(function* (slot: string) {
      const linked = yield* threads.getThreadWorktreePaths({ includeArchived: true });
      for (const { worktreePath } of linked) {
        const candidate = yield* fs
          .realPath(worktreePath)
          .pipe(Effect.orElseSucceed(() => path.resolve(worktreePath)));
        if (candidate === slot) return true;
      }
      for (const { workspaceRoot } of yield* projects.listShells()) {
        const directory = yield* fs
          .realPath(workspaceRoot)
          .pipe(Effect.orElseSucceed(() => path.resolve(workspaceRoot)));
        const relative = path.relative(slot, directory);
        if (
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`) &&
          !path.isAbsolute(relative)
        )
          return true;
      }
      return false;
    });

    const held = Effect.fnUntraced(
      function* (slot: string) {
        if (yield* referenced(slot)) return true;
        if (
          Option.isSome(terminals) &&
          terminals.value.hasOpenInWorkspace &&
          (yield* terminals.value.hasOpenInWorkspace(slot))
        )
          return true;
        return (
          Option.isSome(ownership) &&
          (yield* ownership.value.query({ directory: slot, pinsOnly: true })).length > 0
        );
      },
      Effect.orElseSucceed(() => true),
    );

    const recycleCheckout: WarmWorktreePool["Service"]["recycle"] = Effect.fn(
      "WarmWorktreePool.recycle",
    )(
      function* (input) {
        const slot = yield* fs.realPath(input.path);
        const marker = recordPath(slot);
        // Only the default managed directory is eligible, and its worktree leaf must not be a symlink.
        if (
          marker === null ||
          slot !==
            path.join(yield* fs.realPath(path.dirname(input.path)), path.basename(input.path))
        )
          return "unavailable" as const;
        if (occupied.has(slot) || (yield* fs.exists(marker))) return "recycled" as const;
        const { gitDir } = yield* identify(input.cwd);
        if (!(yield* ownsCheckout(slot, gitDir))) return "unavailable" as const;
        const receiptFile = yield* receiptPath(slot, gitDir);
        if (receiptFile === null) return "unavailable" as const;
        const admin = path.dirname(receiptFile);
        if (yield* held(slot)) return "in-use" as const;
        if (!ownsPool || perRepo === 0) return "unavailable" as const;
        if (((yield* availableBytes(root)) ?? 0) < MIN_FREE_BYTES) return "unavailable" as const;
        if (yield* legacySlotsRemain(false)) return "unavailable" as const;
        yield* loadRecent;
        const target = recent.get(gitDir);
        if (!target || (yield* Clock.currentTimeMillis) - target.usedAt >= MAX_IDLE_MS)
          return "unavailable" as const;
        const setupPlan = yield* plan(target);
        if (setupPlan === null) return "unavailable" as const;
        const head = yield* git.resolveCommit({ cwd: slot, revision: "HEAD" });
        if (input.expectedHead !== undefined && input.expectedHead !== head.commitSha)
          return "in-use" as const;
        const keepModules = setupPlan.command !== null;
        let base = { commit: target.commit, key: setupPlan.key };
        if (keepModules) {
          const receipt = yield* readReceipt(slot, gitDir);
          if (receipt === null || receipt.key !== setupPlan.key || !(yield* modulesReady(slot)))
            return "unavailable" as const;
          // The previous subagent may have changed lockfiles and reinstalled.
          // The original receipt can only certify an unchanged dependency setup.
          if (
            !(yield* sameInputs({ ...target, commit: head.commitSha }, receipt, setupPlan)) ||
            (yield* setupInputsDirty(slot, setupPlan.inputs))
          )
            return "unavailable" as const;
          // A spare can still serve the installed base. Refresh its dependencies
          // in the idle worker if the repository is now delegating from a new lockfile.
          if (!(yield* sameInputs(target, receipt, setupPlan))) base = receipt;
        }
        const dirty = (yield* trackedChanges(slot, false)) !== "";
        if (!input.force && dirty) return "in-use" as const;
        const administrativeState = [
          "locked",
          "index.lock",
          "config.worktree",
          "MERGE_HEAD",
          "CHERRY_PICK_HEAD",
          "REVERT_HEAD",
          "BISECT_START",
          "rebase-merge",
          "rebase-apply",
          "sequencer",
          "info/sparse-checkout",
        ];
        for (const entry of administrativeState) {
          if (yield* fs.exists(path.join(admin, entry))) return "unavailable" as const;
        }
        const index = yield* git.execute({
          operation: "WarmWorktreePool.recycle.inspectIndex",
          cwd: slot,
          args: ["ls-files", "-v", "--stage", "-z"],
          maxOutputBytes: 16 * 1024 * 1024,
        });
        if (
          index.stdoutTruncated ||
          index.stdout
            .split("\0")
            .some(
              (entry) => entry !== "" && (!entry.startsWith("H ") || entry.startsWith("H 160000 ")),
            )
        )
          return "unavailable" as const;
        if (
          yield* run(slot, [
            "for-each-ref",
            "--count=1",
            "refs/worktree",
            "refs/bisect",
            "refs/rewritten",
          ])
        )
          return "unavailable" as const;
        if (occupied.has(slot)) return "recycled" as const;
        occupied.add(slot);
        let reserved = false;
        return yield* Effect.gen(function* () {
          reserved = yield* reserveSlot(slot, gitDir, { gitDir, recycled: true });
          if (!reserved) return "unavailable" as const;
          if (yield* held(slot)) {
            yield* forget(slot);
            return "in-use" as const;
          }
          // Remove hooks and untracked files before switching the detached base.
          // Keeping the stable directory preserves absolute dependency links.
          yield* clean(slot, keepModules, true);
          yield* checkout(slot, base.commit, true, dirty);
          if ((yield* trackedChanges(slot, false)) !== "")
            return yield* new WarmWorktreeError({ operation: "clean recycled checkout" });
          // These files belong to the old worktree session. Its branch and
          // branch reflog live in the common Git directory and are preserved.
          for (const entry of ["logs", "ORIG_HEAD", "FETCH_HEAD", "AUTO_MERGE"]) {
            yield* fs.remove(path.join(admin, entry), { force: true, recursive: true });
          }
          yield* writeRecord(slot, {
            gitDir,
            recycled: true,
            ready: { ...base, activeSince: target.activeSince },
          });
          yield* git.invalidateWorktreeCreationCaches(input.cwd);
          return "recycled" as const;
        }).pipe(
          Effect.onError((cause) =>
            // An interrupted release leaves its journal for restart recovery.
            reserved && !Cause.hasInterruptsOnly(cause)
              ? forget(slot).pipe(Effect.ignore)
              : Effect.void,
          ),
          Effect.ensuring(Effect.sync(() => occupied.delete(slot))),
        );
      },
      Effect.orElseSucceed(() => "unavailable" as const),
    );
    const recycle: WarmWorktreePool["Service"]["recycle"] = (input) =>
      Effect.suspend(() => {
        releasesInFlight++;
        return recycleCheckout(input).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              releasesInFlight--;
            }),
          ),
        );
      });

    /** Only a checkout still registered to this repository can be retired. */
    const remove = Effect.fnUntraced(function* (slot: string, record: Slot) {
      if (record.setupPid !== undefined && processGroupExists(record.setupPid)) return;
      const claim = record.claim;
      let ownsBranch = claim?.ownsBranch === true;
      if (yield* fs.exists(slot)) {
        if (!(yield* ownsCheckout(slot, record.gitDir))) return;
        if (claim && !ownsBranch) {
          const attached = yield* runGit(slot, ["symbolic-ref", "--quiet", "HEAD"]);
          ownsBranch =
            attached.exitCode === 0 && attached.stdout.trimEnd() === `refs/heads/${claim.branch}`;
          if (ownsBranch) yield* writeRecord(slot, { ...record, claim: { ...claim, ownsBranch } });
        }
      }
      const removed = yield* runGit(
        root,
        ["--git-dir", record.gitDir, "worktree", "remove", "--force", "--force", "--", slot],
        true,
      );
      if (removed.exitCode !== 0) {
        if (yield* fs.exists(slot)) return;
        const list = yield* run(root, [
          "--git-dir",
          record.gitDir,
          "worktree",
          "list",
          "--porcelain",
          "-z",
        ]);
        if (list.split("\0").includes(`worktree ${slot}`)) return;
      }
      if (claim && ownsBranch) {
        const current = yield* runGit(root, [
          "--git-dir",
          record.gitDir,
          "rev-parse",
          "--verify",
          `refs/heads/${claim.branch}`,
        ]);
        if (current.exitCode === 0 && current.stdout.trimEnd() === claim.commit) {
          yield* run(root, ["--git-dir", record.gitDir, "branch", "-D", "--", claim.branch], true);
        }
      }
      yield* forget(slot);
    });

    const recover = Effect.fnUntraced(function* (slot: string, record: Slot) {
      if (record.claim) {
        const thread = yield* threads.getThreadShell(record.claim.threadId);
        if (thread?.worktreePath === slot) {
          yield* forget(slot);
          return yield* git.invalidateWorktreeCreationCaches(slot);
        }
      }
      if (record.recycled && (yield* held(slot))) return yield* forget(slot);
      yield* remove(slot, record);
    });

    const prepare = Effect.fn("WarmWorktreePool.prepare")(function* (
      target: Target,
      setupPlan: NonNullable<Effect.Success<ReturnType<typeof plan>>>,
      existing?: string,
    ) {
      const slot = existing ?? path.join(root, yield* crypto.randomUUIDv4());
      if (occupied.has(slot)) return;
      occupied.add(slot);
      yield* Effect.gen(function* () {
        // The slot may have been handed out since maintenance selected it.
        const current = existing === undefined ? null : yield* readRecord(slot);
        const ready = current?.ready;
        if (
          existing !== undefined &&
          (current?.gitDir !== target.gitDir ||
            !ready ||
            current.claim ||
            !(yield* ownsCheckout(slot, target.gitDir)))
        )
          return;
        if (current?.recycled && (yield* held(slot))) return yield* forget(slot);
        const registration = {
          gitDir: target.gitDir,
          ...(current?.recycled ? { recycled: true } : {}),
        };
        if (
          existing === undefined &&
          ((yield* fs.exists(slot)) || (yield* fs.exists(recordPath(slot)!)))
        )
          return;
        const keepModules =
          setupPlan.command !== null &&
          ready !== undefined &&
          (yield* sameInputs(target, ready, setupPlan)) &&
          (yield* modulesReady(slot));
        // A compatible refresh needs only tracked changes. Its prior readiness stays
        // valid if Git is interrupted, because it still describes the same dependencies.
        if (existing === undefined) {
          if (!(yield* reserveSlot(slot, target.gitDir, registration))) return;
        } else if (!keepModules && setupPlan.command !== null) {
          yield* writeRecord(slot, registration);
        }
        if (existing !== undefined) {
          yield* clean(slot, keepModules, true);
          yield* checkout(slot, target.commit, true);
        } else {
          yield* run(
            target.cwd,
            [
              "-c",
              "checkout.workers=1",
              "worktree",
              "add",
              "--detach",
              "--quiet",
              slot,
              target.commit,
            ],
            true,
          );
        }
        if (!keepModules && setupPlan.command !== null)
          yield* runPhase(target, slot, setupPlan.command, "prepare", current?.recycled === true);
        yield* clean(slot, setupPlan.command !== null, true);
        const dirty = yield* trackedChanges(slot, true);
        const trackedModules = yield* run(
          slot,
          ["ls-files", "--", ":(top,glob)**/node_modules/**"],
          true,
        );
        if (
          dirty ||
          trackedModules ||
          (setupPlan.command !== null && !(yield* modulesReady(slot)))
        ) {
          yield* writeRecord(slot, registration);
          return yield* new WarmWorktreeError({ operation: "verify prepared checkout" });
        }
        yield* writeRecord(slot, {
          ...registration,
          ready: { commit: target.commit, key: setupPlan.key, activeSince: target.activeSince },
        });
      }).pipe(Effect.ensuring(Effect.sync(() => occupied.delete(slot))));
    });

    const legacySlotsRemain = Effect.fnUntraced(function* (retire: boolean) {
      if (legacyCleaned) return false;
      const worktreesDir = path.dirname(root);
      for (const repo of yield* fs.readDirectory(worktreesDir)) {
        const directory = path.join(worktreesDir, repo, LEGACY_PARKED_WORKTREES_DIRECTORY);
        if ((yield* fs.realPath(directory).pipe(Effect.orElseSucceed(() => null))) !== directory)
          continue;
        for (const name of yield* fs.readDirectory(directory)) {
          const slot = path.join(directory, name);
          const identity = yield* identify(slot).pipe(Effect.orElseSucceed(() => null));
          if (identity?.top !== slot) continue;
          // Legacy spares may have been edited by an agent. Retire at most one
          // per tick, and count them against the cap before warming new slots.
          if (retire)
            yield* run(
              root,
              ["--git-dir", identity.gitDir, "worktree", "remove", "--force", "--", slot],
              true,
            );
          return true;
        }
      }
      legacyCleaned = true;
      return false;
    });

    const maintainOwned = Effect.fn("WarmWorktreePool.maintain")(function* () {
      yield* loadRecent;
      const now = yield* Clock.currentTimeMillis;
      for (const target of recent.values()) {
        if (now - target.usedAt >= MAX_IDLE_MS) {
          recent.delete(target.gitDir);
          attempted.delete(target.gitDir);
          recentChanged = true;
        }
      }
      yield* saveRecent;
      const free = yield* availableBytes(root);
      const wanted =
        perRepo === 0 || free === null || free < MIN_FREE_BYTES ? [] : wantedRepositories();
      const capacity = wanted.length === 1 ? perRepo : 1;
      const desired = new Map(wanted.map((target) => [target.gitDir, target]));
      const kept = new Map<string, { slot: string; record: Slot }[]>();
      for (const { slot, record } of yield* slots) {
        if (record === null || occupied.has(slot)) continue;
        const repoSlots = kept.get(record.gitDir) ?? [];
        if (
          !record.ready ||
          record.claim ||
          record.ready.activeSince !== desired.get(record.gitDir)?.activeSince ||
          repoSlots.length >= capacity
        ) {
          occupied.add(slot);
          yield* readRecord(slot).pipe(
            Effect.flatMap((current) => (current ? recover(slot, current) : Effect.void)),
            Effect.ensuring(Effect.sync(() => occupied.delete(slot))),
            Effect.ignore,
          );
        } else {
          repoSlots.push({ slot, record });
          kept.set(record.gitDir, repoSlots);
        }
      }
      if (yield* legacySlotsRemain(true)) return;
      const count = (yield* slots).length;
      for (const target of wanted) {
        const repoSlots = kept.get(target.gitDir) ?? [];
        const existing = repoSlots.find(
          ({ record, slot }) =>
            !occupied.has(slot) &&
            (record.ready?.commit !== target.commit || record.ready?.key !== target.setupKey),
        );
        if (!existing && (repoSlots.length >= capacity || count >= MAX_SLOTS)) continue;
        if ((attempted.get(target.gitDir) ?? -1) >= target.usedAt) continue;
        const setupPlan = yield* plan(target).pipe(Effect.orElseSucceed(() => null));
        if (!setupPlan) continue;
        if (recent.get(target.gitDir) === target && target.setupKey !== setupPlan.key) {
          remember({ ...target, setupKey: setupPlan.key });
        }
        if (((yield* availableBytes(root)) ?? 0) < MIN_FREE_BYTES) return;
        yield* prepare(target, setupPlan, existing?.slot).pipe(
          Effect.catch(() =>
            Effect.sync(() => {
              attempted.set(target.gitDir, target.usedAt);
            }),
          ),
        );
        return;
      }
    });

    const maintain = Effect.gen(function* () {
      if (!(yield* options?.hostIdle ?? checkHostIdle)) return;
      yield* acquireOwner;
      if (ownsPool) yield* setup.whenIdle(maintainOwned());
    }).pipe(Effect.ignore);

    const claim: WarmWorktreePool["Service"]["claim"] = Effect.fn("WarmWorktreePool.claim")(
      function* (input) {
        if (!ownsPool || perRepo === 0) return null;
        const identity = yield* identify(input.cwd);
        const ref = yield* git.resolveCommit({ cwd: input.cwd, revision: input.ref });
        if (!isGitCommit(ref.commitSha)) return null;
        yield* loadRecent;
        const previous = recent.get(identity.gitDir);
        const usedAt = yield* Clock.currentTimeMillis;
        const activeSince =
          previous && usedAt - previous.usedAt < MAX_IDLE_MS ? previous.activeSince : usedAt;
        const requested = {
          gitDir: identity.gitDir,
          cwd: input.cwd,
          projectId: input.projectId,
          commit: ref.commitSha,
          usedAt,
          activeSince,
        };
        const setupPlan = yield* plan(requested);
        if (!setupPlan) return null;
        const target = { ...requested, setupKey: setupPlan.key };
        remember(target);
        if (previous?.activeSince !== activeSince) return null;
        // Local branches and tags can use their resolved commit. Keep Git's
        // cold path for remote tracking, DWIM refs and revision expressions.
        if (input.ref !== "HEAD" && input.ref !== target.commit) {
          const symbolic = yield* run(input.cwd, [
            "rev-parse",
            "--symbolic-full-name",
            "--verify",
            "--end-of-options",
            input.ref,
          ]);
          if (!symbolic.startsWith("refs/heads/") && !symbolic.startsWith("refs/tags/"))
            return null;
        }
        const entries = yield* slots;
        const entry = entries.find(
          ({ slot, record }) =>
            record?.gitDir === target.gitDir &&
            record.ready?.activeSince === activeSince &&
            !record.claim &&
            !occupied.has(slot),
        );
        if (!entry) return null;
        const { slot } = entry;
        occupied.add(slot);
        let handedOver = false;
        const release = Effect.sync(() => {
          occupied.delete(slot);
        });
        return yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const record = yield* readRecord(slot);
            if (
              !record ||
              record.gitDir !== target.gitDir ||
              record.ready?.activeSince !== activeSince ||
              record.claim
            )
              return null;
            const ready = record.ready;
            let journaled: Slot | undefined;
            const claimable = yield* restore(
              Effect.gen(function* () {
                if (record.recycled && (yield* held(slot))) {
                  yield* forget(slot);
                  return false;
                }
                if (!(yield* sameInputs(target, ready, setupPlan))) return false;
                const keepModules = setupPlan.command !== null;
                if (
                  !(yield* ownsCheckout(slot, target.gitDir)) ||
                  (keepModules && !(yield* modulesReady(slot)))
                ) {
                  yield* writeRecord(slot, {
                    gitDir: record.gitDir,
                    ...(record.recycled ? { recycled: true } : {}),
                  });
                  return false;
                }
                const attached = yield* runGit(slot, ["symbolic-ref", "--quiet", "HEAD"]);
                if (attached.exitCode !== 1) return false;
                const coldPath = path.join(
                  path.dirname(root),
                  path.basename(input.cwd),
                  input.branch.replaceAll("/", "-"),
                );
                const branchRef = `refs/heads/${input.branch}`;
                const branchExists = yield* runGit(input.cwd, [
                  "show-ref",
                  "--verify",
                  "--quiet",
                  branchRef,
                ]);
                if (
                  branchExists.exitCode !== 1 ||
                  (coldPath !== slot && (yield* fs.exists(coldPath)))
                )
                  return false;
                const baseBranch = yield* git.resolveBranchName(input.cwd, input.baseRef);
                const pending: Slot = {
                  gitDir: record.gitDir,
                  ...(record.recycled ? { recycled: true } : {}),
                  claim: { threadId: input.threadId, branch: input.branch, commit: target.commit },
                };
                yield* writeRecord(slot, pending);
                journaled = pending;
                yield* clean(slot, keepModules, false);
                yield* checkout(
                  slot,
                  target.commit,
                  false,
                  (yield* trackedChanges(slot, false)) !== "",
                );
                yield* run(slot, ["checkout", "--quiet", "-b", input.branch, target.commit]);
                if (setupPlan.command !== null) {
                  yield* runPhase(target, slot, setupPlan.command, "reuse");
                  yield* writeReceipt(slot, target.gitDir, {
                    commit: target.commit,
                    key: setupPlan.key,
                  }).pipe(Effect.ignore);
                }
                if (baseBranch)
                  yield* run(input.cwd, [
                    "config",
                    `branch.${input.branch}.gh-merge-base`,
                    baseBranch,
                  ]);
                return true;
              }),
            ).pipe(
              Effect.onError(() =>
                Effect.suspend(() =>
                  journaled === undefined
                    ? Effect.void
                    : recover(slot, journaled).pipe(Effect.ignore),
                ),
              ),
            );
            if (!claimable) return null;
            const lease: WorktreeLease = {
              path: slot,
              publish: forget(slot).pipe(
                Effect.andThen(git.invalidateWorktreeCreationCaches(slot)),
                Effect.ignore,
                Effect.ensuring(release),
              ),
              abandon: release,
            };
            input.onClaimed(lease);
            handedOver = true;
            return lease;
          }),
        ).pipe(Effect.ensuring(Effect.suspend(() => (handedOver ? Effect.void : release))));
      },
      Effect.orElseSucceed(() => null),
    );

    yield* acquireOwner;
    return {
      claim: (input: ClaimInput) =>
        claimGate.withPermitsIfAvailable(1)(claim(input)).pipe(Effect.map(Option.getOrNull)),
      recordSetup,
      recycle,
      maintain,
    };
  });

export const layer = Layer.effect(
  WarmWorktreePool,
  Effect.gen(function* () {
    const pool = yield* make();
    yield* Effect.forever(Effect.sleep("1 minute").pipe(Effect.andThen(pool.maintain))).pipe(
      Effect.forkScoped,
    );
    return WarmWorktreePool.of(pool);
  }),
);
