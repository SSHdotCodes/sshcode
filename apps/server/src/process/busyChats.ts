// @effect-diagnostics nodeBuiltinImport:off -- load average and core count come from the host.
import * as NodeOS from "node:os";

import { type BusyChatsSnapshot, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as ProcessRunner from "../processRunner.ts";
import { CHAT_ID_ENV } from "./agentScope.ts";

/**
 * Which chats are keeping the Mac busy. Agents carry their chat's id in their
 * environment (agentScope.ts), and everything they start inherits it, detached
 * work included. macOS hides the environment of its own binaries (/bin/sh,
 * /bin/sleep), so a process without a readable id counts for the nearest
 * ancestor that has one.
 *
 * Nothing is sampled while no window watches or while the Mac has spare CPU.
 */
export class BusyChats extends Context.Service<
  BusyChats,
  { readonly stream: Stream.Stream<BusyChatsSnapshot> }
>()("t3/process/busyChats") {}

const SAMPLE_INTERVAL = "15 seconds";
/** The Mac counts as busy once runnable threads fill this share of its cores. */
const BUSY_LOAD_PER_CORE = 0.75;
/** A chat is shown once it keeps a whole core busy. */
const MIN_CHAT_PERCENT = 100;
/** Processes below this are not worth reading the environment of. */
const MIN_PROCESS_PERCENT = 5;
const MAX_ENV_READS = 300;

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly cpuPercent: number;
}

/** Parses `ps -A -o pid=,ppid=,pcpu=`. */
export function parseProcessTable(stdout: string): ReadonlyArray<ProcessRow> {
  const rows: Array<ProcessRow> = [];
  for (const line of stdout.split("\n")) {
    const [pid, ppid, cpu] = line.trim().split(/\s+/);
    const row = { pid: Number(pid), ppid: Number(ppid), cpuPercent: Number(cpu) };
    if (
      Number.isInteger(row.pid) &&
      Number.isInteger(row.ppid) &&
      Number.isFinite(row.cpuPercent)
    ) {
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Parses `ps -wwE -o pid=,command=`, which prints each environment after the
 * arguments. The last match wins, so an argument that merely mentions the
 * variable does not count.
 */
export function parseChatIds(stdout: string): ReadonlyMap<number, string> {
  const pattern = new RegExp(`(?:^|\\s)${CHAT_ID_ENV}=(\\S+)`, "g");
  const ids = new Map<number, string>();
  for (const line of stdout.split("\n")) {
    const pid = Number(/^\s*(\d+)\s/.exec(line)?.[1]);
    const id = [...line.matchAll(pattern)].at(-1)?.[1];
    if (Number.isInteger(pid) && id !== undefined) ids.set(pid, id);
  }
  return ids;
}

/** The busy processes and their ancestors: the ones whose environment can name a chat. */
export function processesToRead(rows: ReadonlyArray<ProcessRow>): ReadonlyArray<number> {
  const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]));
  const pids = new Set<number>();
  const busy = rows
    .filter((row) => row.cpuPercent >= MIN_PROCESS_PERCENT)
    .toSorted((left, right) => right.cpuPercent - left.cpuPercent);
  for (const row of busy) {
    for (let pid: number | undefined = row.pid; pid !== undefined && pid > 1;) {
      if (pids.has(pid)) break;
      pids.add(pid);
      pid = parentOf.get(pid);
    }
    if (pids.size >= MAX_ENV_READS) break;
  }
  return [...pids];
}

/** Adds each busy process's CPU to the chat of its nearest marked ancestor. */
export function chatCpu(
  rows: ReadonlyArray<ProcessRow>,
  chatIds: ReadonlyMap<number, string>,
): BusyChatsSnapshot["chats"] {
  const parentOf = new Map(rows.map((row) => [row.pid, row.ppid]));
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.cpuPercent < MIN_PROCESS_PERCENT) continue;
    let id: string | undefined;
    const seen = new Set<number>();
    for (let pid: number | undefined = row.pid; pid !== undefined && pid > 1;) {
      if (seen.has(pid)) break;
      seen.add(pid);
      id = chatIds.get(pid);
      if (id !== undefined) break;
      pid = parentOf.get(pid);
    }
    if (id !== undefined) totals.set(id, (totals.get(id) ?? 0) + row.cpuPercent);
  }
  return (
    [...totals]
      .filter(([, percent]) => percent >= MIN_CHAT_PERCENT)
      .toSorted(([, left], [, right]) => right - left)
      // Whole tens keep small swings from redrawing every row.
      .map(([threadId, percent]) => ({
        threadId: ThreadId.make(threadId),
        cpuPercent: Math.round(percent / 10) * 10,
      }))
  );
}

const idle: BusyChatsSnapshot = { busy: false, chats: [] };

export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const runner = yield* ProcessRunner.ProcessRunner;
  // Only macOS launches put the chat id in the environment.
  if (platform !== "darwin") return BusyChats.of({ stream: Stream.make(idle) });

  const ps = (args: ReadonlyArray<string>) =>
    runner
      .run({
        command: "/bin/ps",
        args,
        timeout: "5 seconds",
        maxOutputBytes: 16 * 1024 * 1024,
        outputMode: "truncate",
      })
      .pipe(
        Effect.map(({ stdout }) => stdout),
        Effect.orElseSucceed(() => ""),
      );

  const sample = Effect.gen(function* () {
    const cores = NodeOS.availableParallelism();
    if (NodeOS.loadavg()[0]! < cores * BUSY_LOAD_PER_CORE) return idle;
    const rows = parseProcessTable(yield* ps(["-A", "-o", "pid=,ppid=,pcpu="]));
    const pids = processesToRead(rows);
    if (pids.length === 0) return { busy: true, chats: [] };
    const chatIds = parseChatIds(yield* ps(["-wwE", "-o", "pid=,command=", "-p", pids.join(",")]));
    return { busy: true, chats: chatCpu(rows, chatIds) };
  });

  // Every window shares one sample.
  const cache = yield* Cache.make({
    capacity: 1,
    lookup: (_key: "chats") => sample,
    timeToLive: "10 seconds",
  });
  const stream = Stream.fromEffectSchedule(
    Cache.get(cache, "chats"),
    Schedule.spaced(SAMPLE_INTERVAL),
  ).pipe(Stream.changesWith((left, right) => JSON.stringify(left) === JSON.stringify(right)));
  return BusyChats.of({ stream });
});

export const layer = Layer.effect(BusyChats, make).pipe(Layer.provide(ProcessRunner.layer));
