// @effect-diagnostics nodeBuiltinImport:off -- detached sessions and file descriptors must outlive the server scope.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeUtil from "node:util";

import { MonitorError } from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { CHAT_ID_ENV, darwinAgentCommand } from "../process/agentScope.ts";

/** Bytes of `buffer[0, length)` up to the last complete UTF-8 character. */
export function completeUtf8Length(buffer: Uint8Array, length: number): number {
  let start = length;
  // Walk back over continuation bytes (10xxxxxx) to the last character's lead byte.
  while (start > 0 && length - start < 4 && (buffer[start - 1]! & 0xc0) === 0x80) start--;
  if (start === 0) return length;
  const lead = buffer[start - 1]!;
  const size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
  // A plain byte, or a lead whose sequence is all here, ends on a whole character.
  return size === 1 || length - (start - 1) >= size ? length : start - 1;
}
export const DurableJob = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(1)),
  startTime: Schema.String,
  logPath: Schema.String,
  exitPath: Schema.String,
  gatePath: Schema.String,
  offset: Schema.Number,
  partial: Schema.String,
});
export type DurableJob = typeof DurableJob.Type;

export class DurableJobProcess extends Context.Service<
  DurableJobProcess,
  {
    readonly start: (input: {
      readonly directory: string;
      readonly command: string;
      readonly cwd: string;
    }) => Effect.Effect<DurableJob, MonitorError>;
    readonly release: (job: DurableJob) => Effect.Effect<void, MonitorError>;
    readonly alive: (job: DurableJob) => Effect.Effect<boolean, MonitorError>;
    readonly read: (job: DurableJob) => Effect.Effect<
      {
        readonly output: string;
        readonly offset: number;
        readonly end: boolean;
        readonly exitCode: number | undefined;
      },
      MonitorError
    >;
    readonly tail: (job: DurableJob) => Effect.Effect<string, MonitorError>;
    readonly stop: (job: DurableJob) => Effect.Effect<void, MonitorError>;
  }
>()("t3/monitors/DurableJobProcess") {}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const io = <A>(reason: "spawn" | "read" | "stop" | "adopt", run: () => Promise<A>) => {
  const effect = Effect.tryPromise({
    try: run,
    catch: (cause) => new MonitorError({ reason, cause }),
  });
  return reason === "spawn"
    ? effect
    : effect.pipe(
        Effect.timeoutOrElse({
          duration: "15 seconds",
          orElse: () => Effect.fail(new MonitorError({ reason })),
        }),
      );
};

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const environment: NodeJS.ProcessEnv = {
    ...(yield* HostProcess.Environment),
    PYTHONUNBUFFERED: "1",
  };
  // A durable shell must never look like a leftover provider session.
  delete environment[CHAT_ID_ENV];
  const agentScope = yield* AgentScope;
  const identity = (pid: number, operation: "spawn" | "read" | "stop") =>
    io(operation, async () => {
      if (platform === "linux") {
        const stat = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8").catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
          throw error;
        });
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        const boot = await NodeFSP.readFile("/proc/sys/kernel/random/boot_id", "utf8");
        return fields[0] === "Z" || Number(fields[2]) !== pid || fields[19] === undefined
          ? undefined
          : `${boot.trim()}:${fields[19]}`;
      }
      const result = await execFile("/bin/ps", ["-p", String(pid), "-o", "pgid=,stat=,lstart="], {
        timeout: 10_000,
        env: { ...environment, TZ: "UTC", LC_ALL: "C" },
      }).catch((error: unknown) => {
        if (error instanceof Error && "code" in error && error.code === 1) return { stdout: "" };
        throw error;
      });
      const match = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(result.stdout);
      return match === null || Number(match[1]) !== pid || match[2]!.startsWith("Z")
        ? undefined
        : match[3];
    });
  const alive = (job: DurableJob) =>
    identity(job.pid, "read").pipe(Effect.map((id) => id === job.startTime));
  const stop = (job: DurableJob) =>
    Effect.gen(function* () {
      if (!(yield* alive(job))) return;
      const signal = (signal: NodeJS.Signals) =>
        io("stop", async () => {
          try {
            process.kill(-job.pid, signal);
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
          }
        });
      yield* signal("SIGTERM");
      yield* Effect.gen(function* () {
        while (yield* alive(job)) {
          const exited = yield* io("stop", async () => {
            const receipt = await NodeFSP.readFile(job.exitPath, "utf8").catch((error: unknown) => {
              if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
              throw error;
            });
            return /^\d+\s*$/.test(receipt);
          });
          if (exited) return;
          yield* Effect.sleep("100 millis");
        }
      }).pipe(Effect.timeoutOption("10 seconds"));
      // The supervisor stays alive through checkpoint flushing. Recheck its identity before reaping.
      if (yield* alive(job)) yield* signal("SIGKILL");
      yield* Effect.gen(function* () {
        while (yield* alive(job)) yield* Effect.sleep("20 millis");
      }).pipe(
        Effect.timeoutOrElse({
          duration: "1 second",
          orElse: () => Effect.fail(new MonitorError({ reason: "stop" })),
        }),
      );
    }).pipe(Effect.mapError((cause) => new MonitorError({ reason: "stop", cause })));
  return DurableJobProcess.of({
    start: (input) =>
      Effect.gen(function* () {
        if (platform !== "darwin" && platform !== "linux")
          return yield* new MonitorError({ reason: "unsupported" });
        const logPath = `${input.directory}/output.log`;
        const exitPath = `${input.directory}/exit`;
        const gatePath = `${input.directory}/start`;
        const shell = environment.SHELL ?? "/bin/sh";
        // The leader waits for the journal before starting work, and stays alive after exit
        // until adoption reaps the group. Its identity thus also protects descendant cleanup.
        const script = [
          'trap "" HUP',
          "stopping=0; trap 'stopping=1' TERM",
          "gate=$1; receipt=$2; shift 2",
          'attempt=0; while [ ! -f "$gate" ] && [ "$stopping" -eq 0 ]; do attempt=$((attempt+1)); [ "$attempt" -ge 600 ] && exit 125; sleep 1; done',
          'if [ "$stopping" -eq 1 ]; then code=143; else "$@"; code=$?; fi',
          'printf "%s\\n" "$code" > "$receipt.partial"',
          'mv "$receipt.partial" "$receipt"',
          "while :; do sleep 3600; done 2>/dev/null",
        ].join("\n");
        const args = [
          "-c",
          script,
          "t3-durable-job",
          gatePath,
          exitPath,
          shell,
          "-l",
          "-c",
          input.command,
        ];
        const launch =
          platform === "linux"
            ? yield* agentScope.wrap({
                command: "/bin/sh",
                args,
                name: "job",
                env: environment,
                survivesRestart: true,
              })
            : darwinAgentCommand("/bin/sh", args);
        yield* io("spawn", () => NodeFSP.mkdir(input.directory, { recursive: true, mode: 0o700 }));
        const child = yield* io("spawn", async () => {
          const log = await NodeFSP.open(logPath, "a", 0o600);
          try {
            const spawned = NodeChildProcess.spawn(launch.command, [...launch.args], {
              cwd: input.cwd,
              env: environment,
              detached: true,
              stdio: ["ignore", log.fd, log.fd],
            });
            await new Promise<void>((resolve, reject) => {
              spawned.once("error", reject);
              spawned.once("spawn", resolve);
            });
            spawned.unref();
            return spawned;
          } finally {
            await log.close();
          }
        });
        const pid = child.pid!;
        const startTime = yield* identity(pid, "spawn").pipe(
          Effect.onError(() =>
            io("stop", async () => {
              process.kill(-pid, "SIGKILL");
            }).pipe(Effect.ignoreCause),
          ),
        );
        if (startTime === undefined) return yield* new MonitorError({ reason: "spawn" });
        return { pid, startTime, logPath, exitPath, gatePath, offset: 0, partial: "" };
      }),
    release: (job) => io("adopt", () => NodeFSP.writeFile(job.gatePath, "", { mode: 0o600 })),
    alive,
    stop,
    read: (job) =>
      io("read", async () => {
        const receipt = await NodeFSP.readFile(job.exitPath, "utf8").catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
          throw error;
        });
        const log = await NodeFSP.open(job.logPath, "r").catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return undefined;
          throw error;
        });
        if (log === undefined)
          return {
            output: "",
            offset: job.offset,
            end: true,
            exitCode: /^\d+\s*$/.test(receipt) ? Number(receipt.trim()) : undefined,
          };
        try {
          const buffer = Buffer.alloc(65_536);
          const { bytesRead } = await log.read(buffer, 0, buffer.length, job.offset);
          const exitCode = /^\d+\s*$/.test(receipt) ? Number(receipt.trim()) : undefined;
          // Do not split a UTF-8 character between persisted offsets, on a full
          // read or a short one (a writer may be mid-character). After the job
          // exited nothing more comes, so the last read keeps every byte.
          const finished = exitCode !== undefined && bytesRead < buffer.length;
          const length = finished ? bytesRead : completeUtf8Length(buffer, bytesRead);
          return {
            output: buffer.subarray(0, length).toString("utf8"),
            offset: job.offset + length,
            end: bytesRead < buffer.length,
            exitCode,
          };
        } finally {
          await log.close();
        }
      }),
    tail: (job) =>
      io("read", async () => {
        const log = await NodeFSP.open(job.logPath, "r").catch((error: unknown) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return undefined;
          throw error;
        });
        if (log === undefined) return "";
        try {
          const size = (await log.stat()).size;
          const buffer = Buffer.alloc(Math.min(size, 1_500));
          const { bytesRead } = await log.read(
            buffer,
            0,
            buffer.length,
            Math.max(0, size - buffer.length),
          );
          return buffer.subarray(0, bytesRead).toString("utf8").split("\n").slice(-15).join("\n");
        } finally {
          await log.close();
        }
      }),
  });
});

export const layer = Layer.effect(DurableJobProcess, make);
