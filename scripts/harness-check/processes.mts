// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Standalone POSIX process supervisor.
import * as NodeChildProcess from "node:child_process";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

export class CheckFailure extends Error {}

export async function until<A>(
  read: () => Promise<A | undefined>,
  timeoutMs: number,
  reason: string,
  signal?: AbortSignal,
): Promise<A> {
  const deadline = performance.now() + timeoutMs;
  do {
    signal?.throwIfAborted();
    const value = await read();
    if (value !== undefined) return value;
    await NodeTimersPromises.setTimeout(250, undefined, { signal });
  } while (performance.now() < deadline);
  throw new CheckFailure(reason);
}

interface ProcessIdentity {
  readonly pid: number;
  readonly parent: number;
  readonly group: number;
  readonly started: string;
}

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

async function processes(): Promise<Map<number, ProcessIdentity>> {
  const { stdout } = await execFile("/bin/ps", ["-ax", "-o", "pid=,ppid=,pgid=,lstart="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    timeout: 5000,
  });
  const found = new Map<number, ProcessIdentity>();
  for (const row of stdout.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/.exec(row);
    if (!match) continue;
    const pid = Number(match[1]);
    found.set(pid, { pid, parent: Number(match[2]), group: Number(match[3]), started: match[4]! });
  }
  return found;
}

/** Some adapters create their own process groups. Remember those by ancestry while the server lives. */
export class ProcessTree {
  private readonly seen = new Map<number, string>();
  private readonly interval: ReturnType<typeof setInterval>;

  private readonly root: number;
  private scanning: ReturnType<ProcessTree["scan"]> | undefined;

  constructor(root: number) {
    this.root = root;
    this.interval = setInterval(() => void this.capture().catch(() => {}), 1000);
    this.interval.unref();
  }

  capture(): Promise<ReadonlyMap<number, ProcessIdentity>> {
    return (this.scanning ??= this.scan().finally(() => {
      this.scanning = undefined;
    }));
  }

  private async scan(): Promise<ReadonlyMap<number, ProcessIdentity>> {
    const snapshot = await processes();
    const owned = new Map<number, ProcessIdentity>();
    const byParent = new Map<number, ProcessIdentity[]>();
    for (const entry of snapshot.values()) {
      const siblings = byParent.get(entry.parent) ?? [];
      siblings.push(entry);
      byParent.set(entry.parent, siblings);
      if (
        entry.pid === this.root ||
        entry.group === this.root ||
        this.seen.get(entry.pid) === entry.started
      ) {
        owned.set(entry.pid, entry);
      }
    }
    for (const entry of owned.values()) {
      this.seen.set(entry.pid, entry.started);
      for (const child of byParent.get(entry.pid) ?? []) owned.set(child.pid, child);
    }
    return owned;
  }

  async owns(pid: number): Promise<boolean> {
    return (await this.capture().catch(() => undefined))?.has(pid) === true;
  }

  async stop(child: NodeChildProcess.ChildProcess): Promise<void> {
    clearInterval(this.interval);
    await this.capture().catch(() => undefined);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    const empty = async () =>
      (await this.capture().catch(() => undefined))?.size === 0 ? true : undefined;
    try {
      await until(empty, 2500, "Graceful shutdown timed out");
    } catch {
      await until(
        async () => {
          const remaining = await this.capture().catch(() => undefined);
          if (!remaining) {
            // The detached root's group is ours even if a process snapshot failed.
            signalOwnedProcess(-this.root, "SIGKILL");
            return;
          }
          if (remaining.size === 0) return true;
          for (const pid of remaining.keys()) signalOwnedProcess(pid, "SIGSTOP");
          for (const pid of (await this.capture().catch(() => remaining)).keys()) {
            signalOwnedProcess(pid, "SIGKILL");
          }
        },
        12_000,
        "Test server processes survived cleanup",
      );
    }
  }
}

function signalOwnedProcess(pid: number, signal: NodeJS.Signals) {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
