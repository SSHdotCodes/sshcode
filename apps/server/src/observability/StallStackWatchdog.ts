// @effect-diagnostics nodeBuiltinImport:off - the watchdog needs a worker thread.
import * as NodeWorkerThreads from "node:worker_threads";

import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

// The main thread bumps a shared counter every BEAT_MS. The worker checks every
// CHECK_MS and captures once the counter has not moved for THRESHOLD_MS, which
// lands 1 to 1.75 s into a block, so every stall the monitor reports (over 2 s)
// gets a stack.
const BEAT_MS = 500;
const CHECK_MS = 250;
const THRESHOLD_MS = 1500;
const MAX_CAPTURES_PER_HOUR = 20;
// The main thread only pauses once it runs JavaScript again, so a long native
// block keeps the request pending. A pause still pending after this is dropped.
const CAPTURE_TIMEOUT_MS = 60_000;
const MAX_FRAMES = 12;
const MAX_FRAME_CHARS = 100;
const MAX_PENDING_STACKS = 8;

/** One call frame as the inspector reports it. Only these fields leave the worker. */
export interface RawFrame {
  readonly functionName: string;
  readonly url: string;
  readonly lineNumber: number;
}

/** The main thread's stack, captured while it was blocked for `blockedMs`. */
export interface StallStack {
  readonly blockedMs: number;
  readonly frames: ReadonlyArray<string>;
}

export type GateResult = "capture" | { readonly resumedAfterMs: number } | undefined;

/**
 * Decides captures from the heartbeat: at most one per stall and `maxPerHour`,
 * none while another inspector client may be attached. Reports how long a
 * captured stall lasted once the beat resumes. Runs inside the worker, so it
 * must stay self-contained: it is injected there as source.
 */
export function makeCaptureGate(thresholdMs: number, maxPerHour: number) {
  let beat: number | undefined;
  let changedAt = 0;
  let captured = false;
  const recent: Array<number> = [];
  return (now: number, value: number, inspectorOpen: boolean): GateResult => {
    if (value !== beat) {
      const resumedAfterMs = now - changedAt;
      const wasCaptured = captured;
      beat = value;
      changedAt = now;
      captured = false;
      return wasCaptured ? { resumedAfterMs } : undefined;
    }
    if (captured || inspectorOpen || now - changedAt < thresholdMs) return undefined;
    while (recent.length > 0 && now - recent[0]! >= 3_600_000) recent.shift();
    if (recent.length >= maxPerHour) return undefined;
    recent.push(now);
    captured = true;
    return "capture";
  };
}

// Source for an eval worker, like the server's other workers, so the npm bundle,
// the desktop app and the single executable need no extra file. It avoids
// `require`, which a process started with --input-type=module lacks.
// The paused handler resumes before doing anything else. If this worker dies
// with the main thread paused, its session closes and V8 resumes on its own.
const workerSource = `
const { parentPort, workerData } = process.getBuiltinModule("node:worker_threads");
const inspector = process.getBuiltinModule("node:inspector");
const state = new Int32Array(workerData.state);
const gate = (${makeCaptureGate.toString()})(workerData.thresholdMs, workerData.maxPerHour);
let pending;
const flush = () => {
  if (pending === undefined || pending.frames === undefined || pending.blockedMs === undefined) return;
  parentPort.postMessage({ type: "stack", blockedMs: pending.blockedMs, frames: pending.frames });
  pending = undefined;
};
const capture = () => {
  const session = new inspector.Session();
  try {
    session.connectToMainThread();
  } catch (error) {
    clearInterval(timer);
    parentPort.postMessage({ type: "unavailable", reason: String(error && error.message) });
    return;
  }
  const current = {};
  pending = current;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    clearTimeout(failsafe);
    try { session.post("Debugger.disable"); } catch {}
    try { session.disconnect(); } catch {}
    if (pending === current && current.frames === undefined) pending = undefined;
  };
  const failsafe = setTimeout(finish, workerData.captureTimeoutMs);
  session.once("Debugger.paused", (message) => {
    try { session.post("Debugger.resume"); } catch {}
    // Names and locations only: never scopes, arguments or source.
    current.frames = message.params.callFrames.slice(0, 40).map((frame) => ({
      functionName: String(frame.functionName),
      url: String(frame.url),
      lineNumber: Number(frame.location.lineNumber),
    }));
    finish();
    flush();
  });
  // Sent together, so the pause is requested in the same dispatch as enable.
  // Waiting for enable's reply lets a native block return before the pause.
  session.post("Debugger.enable");
  session.post("Debugger.pause");
};
const timer = setInterval(() => {
  const result = gate(Date.now(), Atomics.load(state, 0), Atomics.load(state, 1) === 1);
  if (result === "capture") capture();
  else if (result !== undefined && pending !== undefined) {
    pending.blockedMs = result.resumedAfterMs;
    flush();
  }
}, workerData.checkMs);
// Connecting needs no domain, so this probe costs the main thread nothing.
try {
  const probe = new inspector.Session();
  probe.connectToMainThread();
  probe.disconnect();
  parentPort.postMessage({ type: "ready" });
} catch (error) {
  clearInterval(timer);
  parentPort.postMessage({ type: "unavailable", reason: String(error && error.message) });
}
`;

// The packaged server is bundled into hashed chunks, with the Effect runtime in
// its own `Effect-<hash>.mjs`, so that chunk stands in for the effect package.
const BUNDLE_CHUNK = /^(.+)-[\w-]{8}\.(m?js)$/;

const pathOf = (url: string) => {
  const path = url.replace(/^file:\/\//, "");
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
};

const packageOf = (url: string) =>
  /\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(?!.*\/node_modules\/)/.exec(url)?.[1] ??
  (/^Effect-[\w-]{8}\.m?js$/.test(pathOf(url).slice(pathOf(url).lastIndexOf("/") + 1))
    ? "effect"
    : undefined);

// Repo-relative for source files, a hash-free basename for bundle chunks, never
// absolute. A chunk's name then matches across builds; only its lines move.
const fileOf = (url: string) => {
  const path = pathOf(url);
  const repo = /\/((?:apps|packages)\/.+\.tsx?)$/.exec(path);
  if (repo) return repo[1]!;
  const base = path.slice(path.lastIndexOf("/") + 1);
  return base.replace(BUNDLE_CHUNK, "$1.$2");
};

/**
 * Formats a stack top first as `name (file:line)`, at most 12 entries. A run
 * of `node_modules` frames becomes its package name, and a run of Node
 * internals keeps only its outermost frame, the API the caller used.
 */
export const formatFrames = (frames: ReadonlyArray<RawFrame>): Array<string> => {
  const entries: Array<{ readonly kind: "app" | "package" | "node"; readonly text: string }> = [];
  for (const { functionName, url, lineNumber } of frames) {
    const name = functionName || "(anonymous)";
    const pkg = packageOf(url);
    const previous = entries.at(-1);
    if (pkg !== undefined) {
      if (previous?.kind !== "package" || previous.text !== pkg)
        entries.push({ kind: "package", text: pkg });
      continue;
    }
    if (url.startsWith("node:")) {
      const entry = {
        kind: "node" as const,
        text: `${name} (node:${url.slice(5).replace(/^internal\//, "")}:${lineNumber + 1})`,
      };
      if (previous?.kind === "node") entries[entries.length - 1] = entry;
      else entries.push(entry);
      continue;
    }
    // Native and eval frames have no file, and are only useful when named.
    if (url === "") {
      if (functionName) entries.push({ kind: "app", text: name });
      continue;
    }
    entries.push({ kind: "app", text: `${name} (${fileOf(url)}:${lineNumber + 1})` });
  }
  return entries.slice(0, MAX_FRAMES).map(({ text }) => text.slice(0, MAX_FRAME_CHARS));
};

export interface WatchdogOptions {
  readonly beatMs: number;
  readonly checkMs: number;
  readonly thresholdMs: number;
  readonly maxPerHour: number;
  readonly captureTimeoutMs: number;
}

export const defaultOptions: WatchdogOptions = {
  beatMs: BEAT_MS,
  checkMs: CHECK_MS,
  thresholdMs: THRESHOLD_MS,
  maxPerHour: MAX_CAPTURES_PER_HOUR,
  captureTimeoutMs: CAPTURE_TIMEOUT_MS,
};

/**
 * Starts a worker that captures the main thread's stack while the event loop
 * is blocked. Returns `take`, which hands over the stack of the longest block
 * since the previous call. Never fails: where workers or the inspector are
 * unavailable it logs one warning and `take` returns undefined.
 */
export const start = (
  options: WatchdogOptions = defaultOptions,
): Effect.Effect<() => StallStack | undefined, never, Scope.Scope> =>
  Effect.gen(function* () {
    const warn = (reason: string) =>
      Effect.logWarning("event loop stall stacks unavailable", { reason });
    const stacks: Array<StallStack> = [];
    const take = () => {
      const longest = stacks.reduce<StallStack | undefined>(
        (best, stack) => (best === undefined || stack.blockedMs > best.blockedMs ? stack : best),
        undefined,
      );
      stacks.length = 0;
      return longest;
    };
    // [beat counter, 1 while an inspector is open]
    const state = new Int32Array(new SharedArrayBuffer(8));
    let inspectorUrl: () => string | undefined;
    let worker: NodeWorkerThreads.Worker;
    try {
      // Loaded here, as a Node built without the inspector throws on import.
      inspectorUrl = process.getBuiltinModule("node:inspector").url;
      worker = new NodeWorkerThreads.Worker(workerSource, {
        eval: true,
        workerData: { state: state.buffer, ...options },
        resourceLimits: { maxOldGenerationSizeMb: 16, stackSizeMb: 1 },
      });
    } catch (cause) {
      yield* warn(String(cause));
      return take;
    }
    // Worker events arrive outside any fiber; this keeps the server's loggers.
    const runFork = Effect.runForkWith(yield* Effect.context<never>());
    let stopped = false;
    // A plain timer, not a fiber: the beat must cost nothing and never keep the process alive.
    // @effect-diagnostics-next-line globalTimersInEffect:off
    const beat = setInterval(() => {
      Atomics.add(state, 0, 1);
      // Someone debugging could be paused at a breakpoint the watchdog would resume.
      Atomics.store(state, 1, inspectorUrl() === undefined ? 0 : 1);
    }, options.beatMs);
    beat.unref();
    const stop = (reason: string | undefined) => {
      if (stopped) return;
      stopped = true;
      clearInterval(beat);
      if (reason !== undefined) runFork(warn(reason));
    };
    worker.on("message", (message: unknown) => {
      if (typeof message !== "object" || message === null) return;
      const { type, reason, blockedMs, frames } = message as Record<string, unknown>;
      if (type === "ready") {
        // How to confirm on a running server that stacks will be recorded.
        runFork(Effect.logInfo("event loop stall stacks enabled"));
        return;
      }
      if (type === "unavailable") {
        stop(String(reason));
        void worker.terminate();
        return;
      }
      if (type !== "stack" || typeof blockedMs !== "number" || !Array.isArray(frames)) return;
      if (stacks.length >= MAX_PENDING_STACKS) stacks.shift();
      stacks.push({ blockedMs, frames: formatFrames(frames as Array<RawFrame>) });
    });
    worker.on("error", (cause) => stop(cause.message));
    worker.on("exit", (code) => stop(`exited with code ${code}`));
    // After the listeners: adding a "message" listener refs the worker again.
    worker.unref();
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => {
        stop(undefined);
        return worker.terminate();
      }),
    );
    return take;
  });
