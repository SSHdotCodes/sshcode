// @effect-diagnostics nodeBuiltinImport:off -- fake systemd binaries live in a temp dir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as Logger from "effect/Logger";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as NodeChildProcess from "node:child_process";

import {
  agentSliceMemoryLimits,
  classifyScope,
  DARWIN_TASKPOLICY,
  darwinAgentCommand,
  isLeftoverDarwinAgent,
  make,
  ownedAgentSlice,
  parseDarwinProcessList,
  type ScopeState,
} from "./agentScope.ts";

const GiB = 1024 ** 3;

const running: ScopeState = {
  loadState: "loaded",
  activeState: "active",
  result: "success",
  oomKills: 0,
  populated: true,
};

describe("classifyScope", () => {
  it("reports an OOM kill only once systemd records it", () => {
    expect(classifyScope({ ...running, activeState: "failed", result: "oom-kill" })).toBe(
      "oom-killed",
    );
    // The agent pipe can close before systemd handles the kill.
    expect(classifyScope({ ...running, oomKills: 1 })).toBe("stopping");
    expect(classifyScope({ ...running, populated: false })).toBe("stopping");
    expect(classifyScope({ ...running, activeState: "deactivating" })).toBe("stopping");
  });

  it("does not wait on a live agent or a scope that ended for another reason", () => {
    expect(classifyScope(running)).toBe("running");
    expect(classifyScope({ ...running, activeState: "inactive", populated: undefined })).toBe(
      "gone",
    );
    expect(classifyScope({ ...running, loadState: "not-found", activeState: "inactive" })).toBe(
      "gone",
    );
  });
});

describe("agentSliceMemoryLimits", () => {
  it("leaves 6 GB before throttling and 4 GB before a kill on large machines", () => {
    expect(agentSliceMemoryLimits(64 * GiB, true)).toEqual({ high: 58 * GiB, max: 60 * GiB });
  });

  it("still gives agents most of a small machine", () => {
    expect(agentSliceMemoryLimits(8 * GiB, true)).toEqual({ high: 4 * GiB, max: 6 * GiB });
  });

  it("skips the throttle without swap, where it would stall agents instead of a kill", () => {
    expect(agentSliceMemoryLimits(64 * GiB, false)).toEqual({ high: "infinity", max: 60 * GiB });
  });
});

// Runs the real service against a fake user manager. `units` holds the
// ActiveState and Result that `systemctl show` reports for each scope or
// slice, and `calls` records every command in order.
interface FakeUnit {
  activeState: string;
  result: string;
  controlGroup?: string;
}

const withFakeSystemd = <A, E>(
  body: (input: {
    readonly scope: Effect.Success<typeof make>;
    readonly units: Map<string, FakeUnit>;
    readonly calls: ReadonlyArray<ReadonlyArray<string>>;
    readonly stateDir: string;
    readonly cgroupRoot: string;
  }) => Effect.Effect<A, E>,
  // A user manager older than systemd 253 rejects OOMPolicy on scopes.
  {
    oomPolicy = true,
    stopFails = false,
    swapKb = 2 * 1024 ** 2,
  }: {
    readonly oomPolicy?: boolean;
    readonly stopFails?: boolean;
    /** SwapTotal in /proc/meminfo; undefined leaves meminfo unreadable. */
    readonly swapKb?: number | undefined;
  } = {},
) =>
  Effect.gen(function* () {
    const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-scope-"));
    for (const name of ["systemd-run", "systemctl", "agent"]) {
      NodeFS.writeFileSync(NodePath.join(bin, name), "", { mode: 0o755 });
    }
    const cgroupRoot = NodePath.join(bin, "cgroup");
    const units = new Map<string, FakeUnit>();
    const calls: Array<ReadonlyArray<string>> = [];
    const output = (stdout: string, code = 0): ProcessRunner.ProcessRunOutput => ({
      stdout,
      stderr: "",
      code: ChildProcessSpawner.ExitCode(code),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    });
    const runner = ProcessRunner.ProcessRunner.of({
      run: ({ command, args }) =>
        Effect.sync(() => {
          calls.push(args);
          if (
            !oomPolicy &&
            NodePath.basename(command) === "systemd-run" &&
            args.includes("--property=OOMPolicy=stop")
          ) {
            return output("", 1);
          }
          const [, verb, unit = ""] = args;
          if (stopFails && verb === "stop") {
            return {
              ...output(""),
              stderr: `Failed to stop ${args.at(-1)}: Unit not loaded.`,
              code: ChildProcessSpawner.ExitCode(5),
            };
          }
          if (verb === "reset-failed") units.delete(unit);
          if (verb !== "show") return output("");
          const state = units.get(unit);
          return output(
            state === undefined
              ? "LoadState=not-found\nActiveState=inactive\nResult=success\n"
              : `LoadState=loaded\nActiveState=${state.activeState}\nResult=${state.result}\n` +
                  `ControlGroup=${state.controlGroup ?? ""}\n`,
          );
        }),
    });
    const fileSystem = yield* FileSystem.FileSystem;
    const scope = yield* make.pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: bin, XDG_RUNTIME_DIR: "/run/user/1" }),
      Effect.provideService(FileSystem.FileSystem, {
        ...fileSystem,
        readFileString: (path, encoding) =>
          path === "/proc/meminfo" && swapKb !== undefined
            ? Effect.succeed(`MemTotal:       16384 kB\nSwapTotal:      ${swapKb} kB\n`)
            : fileSystem.readFileString(path.replace("/sys/fs/cgroup", cgroupRoot), encoding),
      }),
    );
    const { stateDir } = yield* ServerConfig.ServerConfig;
    return yield* body({ scope, units, calls, stateDir, cgroupRoot }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(bin, { recursive: true, force: true }))),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-scope-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

const unitOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--unit="))?.slice("--unit=".length) ?? "";

const sliceOf = (launch: { readonly args: ReadonlyArray<string> }) =>
  launch.args.find((arg) => arg.startsWith("--slice="))?.slice("--slice=".length) ?? "";

/** An active scope as systemd and the kernel report it, with the agent itself gone. */
const exitedAgent = (
  units: Map<string, FakeUnit>,
  cgroupRoot: string,
  unit: string,
  { populated, oomKills }: { readonly populated: boolean; readonly oomKills: number | undefined },
) => {
  const controlGroup = `/${unit}`;
  NodeFS.mkdirSync(NodePath.join(cgroupRoot, controlGroup), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(cgroupRoot, controlGroup, "cgroup.events"),
    `populated ${populated ? 1 : 0}\nfrozen 0\n`,
  );
  // An undefined count leaves memory.events unreadable.
  if (oomKills !== undefined) {
    NodeFS.writeFileSync(
      NodePath.join(cgroupRoot, controlGroup, "memory.events"),
      `low 0\nhigh 0\nmax 0\noom ${oomKills}\noom_kill ${oomKills}\noom_group_kill 0\n`,
    );
  }
  units.set(unit, { activeState: "active", result: "success", controlGroup });
};

const stopsOf = (calls: ReadonlyArray<ReadonlyArray<string>>) =>
  calls.filter(([, verb]) => verb === "stop");
describe("AgentScope service", () => {
  it.effect("labels a thread from its newest scope until its next session clears it", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const first = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(first), { activeState: "failed", result: "oom-kill" });
        const second = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        units.set(unitOf(second), { activeState: "active", result: "success" });
        // The older scope was OOM-killed, but the newest one is still running.
        expect(yield* scope.oomKilled("a")).toBe(false);

        units.set(unitOf(second), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("a")).toBe(true);
        // A retried failure reads the same, even after the failed unit is reset.
        units.delete(unitOf(second));
        expect(yield* scope.oomKilled("a")).toBe(true);

        // The next session may run without a scope, for example on Cursor.
        yield* scope.clear("a");
        expect(yield* scope.oomKilled("a")).toBe(false);
      }),
    ),
  );

  it.effect("keeps a running scope while hundreds of other threads launch", () =>
    withFakeSystemd(({ scope, units }) =>
      Effect.gen(function* () {
        const live = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "live" });
        units.set(unitOf(live), { activeState: "active", result: "success" });
        for (let index = 0; index < 600; index++) {
          yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: `other-${index}` });
        }
        units.set(unitOf(live), { activeState: "failed", result: "oom-kill" });
        expect(yield* scope.oomKilled("live")).toBe(true);
      }),
    ),
  );

  it.effect("stops agents a killed server left before the first launch", () =>
    withFakeSystemd(({ scope, units, calls, stateDir }) =>
      Effect.gen(function* () {
        units.set(ownedAgentSlice(stateDir), { activeState: "active", result: "success" });
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const stops = calls.filter(([, verb]) => verb === "stop");
        expect(stops).toEqual([["--user", "stop", ownedAgentSlice(stateDir)]]);
        // Agents run in this server's own slice; terminals stay outside it.
        expect(sliceOf(agent)).toBe(ownedAgentSlice(stateDir));
        // An agent that ignores SIGTERM is killed well inside the stop's wait.
        expect(agent.args).toContain("--property=TimeoutStopSec=10s");
        const terminal = yield* scope.wrap({
          command: "agent",
          args: [],
          name: "terminal",
          survivesRestart: true,
        });
        expect(sliceOf(terminal)).toBe("app-t3code-agents.slice");
        const job = yield* scope.wrap({
          command: "agent",
          args: [],
          name: "job",
          survivesRestart: true,
        });
        expect(sliceOf(job)).toBe("app-t3code-agents.slice");
        // Only the first launch looks for leftovers.
        expect(calls.filter(([, verb]) => verb === "stop")).toHaveLength(1);
      }),
    ),
  );

  it.effect("stops leftover processes only in an active agent scope", () =>
    withFakeSystemd(({ scope, units, calls, cgroupRoot }) =>
      Effect.gen(function* () {
        const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        const unit = unitOf(agent);
        expect(agent.unit).toBe(unit);

        yield* scope.stop("session-2.scope");
        expect(calls.some((args) => args.includes("session-2.scope"))).toBe(false);
        yield* scope.stop(unit);
        exitedAgent(units, cgroupRoot, unit, { populated: false, oomKills: 0 });
        yield* scope.stop(unit);
        exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: 0 });
        units.get(unit)!.activeState = "deactivating";
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([]);

        units.get(unit)!.activeState = "active";
        yield* scope.stop(unit);
        expect(stopsOf(calls)).toEqual([["--user", "stop", "--no-block", unit]]);
        expect(yield* scope.oomKilled("a")).toBe(false);
      }),
    ),
  );

  it.effect.each([true, false])(
    "cleans up an OOM exit without losing its diagnosis (OOMPolicy=%s)",
    (oomPolicy) =>
      withFakeSystemd(
        ({ scope, units, calls, cgroupRoot }) =>
          Effect.gen(function* () {
            const agent = yield* scope.wrap({
              command: "agent",
              args: [],
              name: "t",
              threadId: "a",
            });
            const unit = unitOf(agent);
            exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: undefined });
            yield* scope.stop(unit);
            expect(stopsOf(calls)).toEqual(
              oomPolicy ? [] : [["--user", "stop", "--no-block", unit]],
            );

            // The kernel records the kill before systemd records the OOM result.
            exitedAgent(units, cgroupRoot, unit, { populated: true, oomKills: 1 });
            yield* scope.stop(unit);
            expect(stopsOf(calls)).toHaveLength(oomPolicy ? 0 : 2);

            if (oomPolicy) {
              units.set(unit, { activeState: "failed", result: "oom-kill" });
              expect(yield* scope.oomKilled("a")).toBe(true);
              units.delete(unit);
              expect(yield* scope.oomKilled("a")).toBe(true);
            }
          }),
        { oomPolicy },
      ),
  );

  it.effect("reports failed daemon cleanup without failing session teardown", () => {
    const warnings: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      warnings.push(message);
    });
    return withFakeSystemd(
      ({ scope, units, cgroupRoot }) =>
        Effect.gen(function* () {
          const agent = yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          exitedAgent(units, cgroupRoot, unitOf(agent), { populated: true, oomKills: 0 });
          yield* scope.stop(unitOf(agent));
          expect(warnings.flat()).toContain("Could not stop an exited agent's scope");
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
      { stopFails: true },
    );
  });

  it.effect.each([
    { case: "with swap", swapKb: 2 * 1024 ** 2, throttled: true },
    // Without swap, MemoryHigh only throttles; MemoryMax must OOM-kill the runaway.
    { case: "without swap", swapKb: 0, throttled: false },
    { case: "when meminfo is unreadable", swapKb: undefined, throttled: true },
  ])("sets the agents slice memory limits $case", ({ swapKb, throttled }) =>
    withFakeSystemd(
      ({ scope, calls }) =>
        Effect.gen(function* () {
          yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
          const limits = agentSliceMemoryLimits(NodeOS.totalmem(), throttled);
          expect(calls.find(([, verb]) => verb === "set-property")?.slice(-2)).toEqual([
            `MemoryHigh=${limits.high}`,
            `MemoryMax=${limits.max}`,
          ]);
          expect(limits.high === "infinity").toBe(!throttled);
        }),
      { swapKb },
    ),
  );

  it.effect("leaves a quiet slice alone", () =>
    withFakeSystemd(({ scope, calls }) =>
      Effect.gen(function* () {
        yield* scope.wrap({ command: "agent", args: [], name: "t", threadId: "a" });
        expect(calls.filter(([, verb]) => verb === "stop")).toEqual([]);
      }),
    ),
  );
});

describe("AgentScope on macOS", () => {
  const onMac = <A, E>(
    body: (input: {
      readonly scope: Effect.Success<typeof make>;
      readonly agent: string;
    }) => Effect.Effect<A, E>,
  ) =>
    Effect.gen(function* () {
      const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-scope-"));
      const agent = NodePath.join(bin, "agent");
      NodeFS.writeFileSync(agent, "", { mode: 0o755 });
      const fileSystem = yield* FileSystem.FileSystem;
      const scope = yield* make.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          // Only the leftover-agent check runs a command; nothing is left over here.
          run: ({ command }) =>
            command === "/bin/ps"
              ? Effect.succeed({ stdout: "", stderr: "", code: 0 } as never)
              : Effect.die("macOS needs no other helper commands"),
        }),
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Environment, { PATH: bin }),
        // The test may run on Linux, which has no taskpolicy.
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          exists: (path) =>
            path === DARWIN_TASKPOLICY ? Effect.succeed(true) : fileSystem.exists(path),
        }),
      );
      return yield* body({ scope, agent }).pipe(
        Effect.ensuring(Effect.sync(() => NodeFS.rmSync(bin, { recursive: true, force: true }))),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-scope-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );

  it.effect("starts agents at utility priority and leaves terminals alone", () =>
    onMac(({ scope, agent }) =>
      Effect.gen(function* () {
        expect(yield* scope.wrap({ command: "agent", args: ["--x"], name: "claude" })).toEqual({
          command: DARWIN_TASKPOLICY,
          args: ["-c", "utility", agent, "--x"],
        });
        expect(
          yield* scope.wrap({
            command: "zsh",
            args: ["-l"],
            name: "terminal",
            survivesRestart: true,
          }),
        ).toEqual({ command: "zsh", args: ["-l"] });
        // A missing binary still fails at spawn with its own name.
        expect(yield* scope.wrap({ command: "missing", args: [], name: "codex" })).toEqual({
          command: "missing",
          args: [],
        });
      }),
    ),
  );

  it.effect("lowers the priority of everything the agent starts, detached work included", () =>
    Effect.gen(function* () {
      // taskpolicy and these priority numbers exist only on macOS.
      if ((yield* HostProcess.Platform) !== "darwin") return;
      const runner = yield* ProcessRunner.ProcessRunner;
      const priorityOf = (script: string) =>
        runner
          .run({ ...darwinAgentCommand("/bin/sh", ["-c", script]), timeout: "10 seconds" })
          .pipe(Effect.map(({ stdout }) => Number(stdout.trim())));
      const normal = yield* runner
        .run({ command: "/bin/sh", args: ["-c", "ps -o pri= -p $$"], timeout: "10 seconds" })
        .pipe(Effect.map(({ stdout }) => Number(stdout.trim())));
      const detached = yield* priorityOf("nohup /bin/sh -c 'ps -o pri= -p $$' 2>/dev/null & wait");
      // Utility work runs at priority 20 where normal work runs at 31. A test
      // run already at background priority starts everything lower still.
      expect(detached).toBeLessThanOrEqual(Math.min(normal, 20));
    }).pipe(Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
});

describe("agents a previous server left on macOS", () => {
  const thread = "T3CODE_THREAD_ID=9f58d2fe-14e2-41e8-8e7b-8b147a161031";
  const line = (pid: number, ppid: number, command: string) =>
    `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${String(pid).padStart(5)} ${command}`;

  it("stops the agent itself, never the jobs it started or the user's own Claude", () => {
    const processes = parseDarwinProcessList(
      [
        // Claude from a server that quit: adopted by launchd, still carrying its chat.
        line(
          33470,
          1,
          `/Users/me/.local/bin/claude --output-format stream-json --verbose --input-format stream-json --model claude-opus-5-5 HOME=/Users/me ${thread}`,
        ),
        // The same agent under a live server.
        line(
          74017,
          73626,
          `/Users/me/.local/bin/claude --output-format stream-json --input-format stream-json ${thread}`,
        ),
        // A training loop the agent started with nohup: same chat id, not an agent.
        line(85572, 1, `.venv/bin/python rl/loop.py --name rl2 ${thread}`),
        // A one-shot claude -p the agent detached.
        line(90001, 1, `/Users/me/.local/bin/claude -p summarize ${thread}`),
        // The user's own Claude Code, started outside SSHCode.
        line(
          90002,
          1,
          "/Users/me/.local/bin/claude --output-format stream-json --input-format stream-json HOME=/Users/me",
        ),
        line(80857, 1, `/opt/homebrew/bin/codex app-server ${thread}`),
        line(80858, 1, "/opt/homebrew/bin/codex app-server T3CODE_CODEX_APP_SERVER=1"),
        line(80859, 1, "/opt/homebrew/bin/codex app-server"),
        "garbage",
      ].join("\n"),
    );
    expect(processes.filter(isLeftoverDarwinAgent).map((process) => process.pid)).toEqual([
      33470, 80857, 80858,
    ]);
  });

  // Real time: the stand-in is this process's own child, a zombie until Node reaps it.
  it.live("stops leftovers once, before the first agent starts", () =>
    Effect.gen(function* () {
      if ((yield* HostProcess.Platform) !== "darwin") return;
      const bin = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-scope-"));
      NodeFS.writeFileSync(NodePath.join(bin, "agent"), "", { mode: 0o755 });
      // Stands in for an old Claude: its own process group, like a detached spawn.
      const leftover = NodeChildProcess.spawn("/bin/sleep", ["60"], {
        detached: true,
        stdio: "ignore",
      });
      const pid = leftover.pid!;
      const exited = new Promise<void>((resolve) => leftover.once("exit", () => resolve()));
      let listings = 0;
      const fileSystem = yield* FileSystem.FileSystem;
      const scope = yield* make.pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: ({ command }) => {
            if (command !== "/bin/ps") return Effect.die("unexpected command");
            listings += 1;
            return Effect.succeed({
              stdout: line(
                pid,
                1,
                `/Users/me/.local/bin/claude --input-format stream-json ${thread}`,
              ),
              stderr: "",
              code: 0,
            } as never);
          },
        }),
        Effect.provideService(HostProcess.Environment, { PATH: bin }),
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          exists: (path) =>
            path === DARWIN_TASKPOLICY ? Effect.succeed(true) : fileSystem.exists(path),
        }),
      );
      // Terminals belong to the user and don't wait for the check.
      yield* scope.wrap({ command: "zsh", args: [], name: "terminal" });
      expect(listings).toBe(0);
      yield* scope.wrap({ command: "agent", args: [], name: "claude", threadId: "t1" });
      yield* Effect.promise(() => exited);
      yield* scope.wrap({ command: "agent", args: [], name: "codex", threadId: "t2" });
      expect(listings).toBe(1);
      NodeFS.rmSync(bin, { recursive: true, force: true });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-agent-scope-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
