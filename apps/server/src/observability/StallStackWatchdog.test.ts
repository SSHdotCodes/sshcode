// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- a real worker watches real blocking of this thread.
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Schedule from "effect/Schedule";

import * as StallStackWatchdog from "./StallStackWatchdog.ts";

const frame = (functionName: string, url: string, lineNumber: number) => ({
  functionName,
  url,
  lineNumber,
});

describe("formatFrames", () => {
  it("keeps names and short locations, collapsing packages and Node internals", () => {
    expect(
      StallStackWatchdog.formatFrames([
        frame("getStderr", "node:child_process", 173),
        frame("execFileSync", "node:internal/child_process", 956),
        frame("run", "file:///Users/someone/code/t3/apps/server/src/git/Git.ts", 41),
        frame(
          "",
          "file:///Users/someone/code/t3/node_modules/.pnpm/effect@4/node_modules/effect/dist/Effect.js",
          9,
        ),
        frame(
          "runLoop",
          "file:///Users/someone/code/t3/node_modules/.pnpm/effect@4/node_modules/effect/dist/Fiber.js",
          90,
        ),
        frame("x", "file:///opt/t3/node_modules/@effect/platform-node/dist/a.js", 1),
        frame("", "", 0),
        frame("JSON.parse", "", 0),
        frame(
          "handle",
          "file:///Applications/T3%20Code.app/Contents/Resources/server/dist/bin.mjs",
          12_344,
        ),
        frame("listOnTimeout", "node:internal/timers", 604),
        frame("processTimers", "node:internal/timers", 540),
      ]),
    ).toEqual([
      "execFileSync (node:child_process:957)",
      "run (apps/server/src/git/Git.ts:42)",
      "effect",
      "@effect/platform-node",
      "JSON.parse",
      "handle (bin.mjs:12345)",
      "processTimers (node:timers:541)",
    ]);
  });

  it("collapses the bundled Effect runtime and drops build hashes", () => {
    const chunk = (name: string) =>
      `file:///Applications/T3%20Code.app/Contents/Resources/app.asar/apps/server/dist/${name}`;
    expect(
      StallStackWatchdog.formatFrames([
        frame("prepare", "node:sqlite", 1),
        frame("runStatement", chunk("binCli-Bq3x_9-z.mjs"), 81_233),
        frame("runLoop", chunk("Effect-D4a1b2c3.mjs"), 900),
        frame("evaluate", chunk("Effect-D4a1b2c3.mjs"), 1200),
        frame("projectTurns", chunk("binCli-Bq3x_9-z.mjs"), 50_000),
        frame("", chunk("Effect-D4a1b2c3.mjs"), 3),
        frame("main", chunk("bin.mjs"), 10),
      ]),
    ).toEqual([
      "prepare (node:sqlite:2)",
      "runStatement (binCli.mjs:81234)",
      "effect",
      "projectTurns (binCli.mjs:50001)",
      "effect",
      "main (bin.mjs:11)",
    ]);
  });

  it("keeps at most 12 short frames", () => {
    const frames = StallStackWatchdog.formatFrames(
      Array.from({ length: 40 }, (_, index) =>
        frame(`f${index}${"x".repeat(200)}`, "file:///srv/app/dist/bin.mjs", index),
      ),
    );
    expect(frames).toHaveLength(12);
    expect(frames[0]!.startsWith("f0x")).toBe(true);
    expect(Math.max(...frames.map((text) => text.length))).toBe(100);
  });
});

describe("makeCaptureGate", () => {
  it("captures once per stall and reports how long it lasted", () => {
    const gate = StallStackWatchdog.makeCaptureGate(1500, 20);
    expect(gate(0, 1, false)).toBeUndefined();
    expect(gate(1000, 1, false)).toBeUndefined();
    expect(gate(1500, 1, false)).toBe("capture");
    expect(gate(4000, 1, false)).toBeUndefined();
    expect(gate(4200, 2, false)).toEqual({ resumedAfterMs: 4200 });
    // A block too short to capture reports nothing when it ends.
    expect(gate(5000, 2, false)).toBeUndefined();
    expect(gate(5200, 3, false)).toBeUndefined();
  });

  it("skips while an inspector is open", () => {
    const gate = StallStackWatchdog.makeCaptureGate(1500, 20);
    gate(0, 1, false);
    expect(gate(2000, 1, true)).toBeUndefined();
    expect(gate(2500, 2, true)).toBeUndefined();
  });

  it("captures at most the hourly cap", () => {
    const gate = StallStackWatchdog.makeCaptureGate(1000, 3);
    const stall = (at: number) => {
      gate(at, at, false);
      return gate(at + 1000, at, false);
    };
    expect([stall(0), stall(10_000), stall(20_000), stall(30_000)]).toEqual([
      "capture",
      "capture",
      "capture",
      undefined,
    ]);
    // The first capture leaves the hour window.
    expect(stall(3_600_000)).toBe("capture");
    expect(stall(3_610_000)).toBe("capture");
    expect(stall(3_620_000)).toBe("capture");
    expect(stall(3_630_000)).toBeUndefined();
  });
});

// Real worker and inspector. Blocks are 1.5 s against a 0.5 s threshold, and
// nothing asserts exact timing, so a loaded machine still captures.
const fast: StallStackWatchdog.WatchdogOptions = {
  ...StallStackWatchdog.defaultOptions,
  beatMs: 100,
  checkMs: 50,
  thresholdMs: 500,
};

function blockWithBusyLoopForStallTest() {
  const end = Date.now() + 1500;
  let spins = 0;
  while (Date.now() < end) spins++;
  return spins;
}

function blockWithNativeCallForStallTest() {
  // Like a synchronous SQLite call: native code that never yields to JavaScript.
  NodeChildProcess.execFileSync(process.execPath, ["-e", "setTimeout(() => {}, 1500)"]);
}

// Polls the watchdog until the worker has delivered a stack.
const nextStack = (take: () => StallStackWatchdog.StallStack | undefined) =>
  Effect.sync(take).pipe(
    Effect.repeat({
      until: (stack) => stack !== undefined,
      schedule: Schedule.spaced("100 millis"),
    }),
    Effect.timeout("20 seconds"),
    Effect.map((stack) => stack!),
  );

describe("StallStackWatchdog", () => {
  it.live("records the stack of a blocked main thread", () => {
    const logs: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      logs.push(Array.isArray(message) ? message[0] : message);
    });
    return Effect.gen(function* () {
      const take = yield* StallStackWatchdog.start(fast);
      yield* Effect.sync(() => logs.includes("event loop stall stacks enabled")).pipe(
        Effect.repeat({ until: (ready) => ready, schedule: Schedule.spaced("50 millis") }),
        Effect.timeout("20 seconds"),
      );

      blockWithBusyLoopForStallTest();
      const busy = yield* nextStack(take);
      expect(busy.blockedMs).toBeGreaterThan(fast.thresholdMs);
      // Vitest's module runner gives test files no script URL, so only the name shows here.
      expect(busy.frames[0]).toMatch(/^blockWithBusyLoopForStallTest\b/);

      blockWithNativeCallForStallTest();
      const native = yield* nextStack(take);
      expect(native.frames.some((text) => /^blockWithNativeCallForStallTest\b/.test(text))).toBe(
        true,
      );
      expect(logs).not.toContain("event loop stall stacks unavailable");
    }).pipe(Effect.scoped, Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
  });

  it("never keeps the process alive", () => {
    // A process that starts the watchdog and never closes its scope must still exit.
    const module = NodeURL.pathToFileURL(`${import.meta.dirname}/StallStackWatchdog.ts`).href;
    const script = `
      import * as Effect from "effect/Effect";
      import * as Scope from "effect/Scope";
      const { start } = await import(${JSON.stringify(module)});
      const scope = Effect.runSync(Scope.make());
      await Effect.runPromise(start().pipe(Scope.provide(scope)));
      // Long enough for the worker to boot and the heartbeat to run.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.log("started");
    `;
    const started = Date.now();
    const output = NodeChildProcess.execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: `${import.meta.dirname}/../..`,
        timeout: 30_000,
        stdio: "pipe",
        encoding: "utf8",
      },
    );
    // The worker really ran, so its unref is what let the process end.
    expect(output).toContain("event loop stall stacks enabled");
    expect(output).toContain("started");
    // Well under the 30 s kill: the process ended by itself.
    expect(Date.now() - started).toBeLessThan(25_000);
  });
});
