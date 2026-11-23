// @effect-diagnostics nodeBuiltinImport:off - Execute only the generated network guard against fake sockets.
import * as NodeVM from "node:vm";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId, PreviewTabId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import { make } from "./QaSandbox.ts";
import * as Host from "./QaSandboxHost.ts";
import { PreviewAutomationBroker } from "../mcp/PreviewAutomationBroker.ts";
import { ProjectService } from "../project/ProjectService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";

const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("qa-test"),
  capabilities: new Set(["preview"]),
  issuedAt: 0,
  requestNamespace: "qa",
  client: undefined,
  thread: {
    threadId: ThreadId.make("qa-thread"),
    providerSessionId: "qa-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
};

const fixture = Effect.gen(function* () {
  const calls: Array<string> = [];
  const files: Array<Host.SandboxFiles> = [];
  const seeded = new Set<string>();
  const disposed = yield* Deferred.make<void>();
  let fail = false;
  let launch: Effect.Effect<void> = Effect.void;
  const host = Host.QaSandboxHost.of({
    prepare: (id, repositoryPath) =>
      Effect.sync(() => {
        const file = {
          id,
          repositoryPath,
          directory: `/private/tmp/t3-qa-${id}`,
          serverPort: 31001,
          webPort: 31002,
          logPath: `/private/tmp/t3-qa-${id}.log`,
        };
        files.push(file);
        calls.push("prepare");
        return file;
      }),
    launch: () =>
      Effect.sync(() => {
        calls.push("launch");
      }).pipe(Effect.andThen(Effect.suspend(() => launch))),
    ready: () =>
      Effect.suspend(() =>
        fail
          ? Effect.fail(
              new Host.QaSandboxHostError({
                stage: "readiness",
                cause: new Error("raw multi\nline log"),
              }),
            )
          : Effect.void,
      ),
    pair: () => Effect.succeed("http://127.0.0.1:31001/#token=private-credential"),
    seed: (files) =>
      Effect.gen(function* () {
        calls.push("seed");
        if (seeded.has(files.id))
          return yield* Effect.fail(
            new Host.QaSandboxHostError({ stage: "seed", cause: "QA project already exists." }),
          );
        seeded.add(files.id);
      }),
    dispose: (_files, keepLog) =>
      Effect.sync(() => {
        calls.push(keepLog ? "dispose-keep-log" : "dispose");
      }).pipe(Effect.andThen(Deferred.succeed(disposed, undefined)), Effect.asVoid),
  });
  const broker = Layer.mock(PreviewAutomationBroker)({
    invoke: ({ operation, input }) =>
      Effect.sync(() => {
        calls.push(operation);
        if (operation === "open")
          expect(input).toMatchObject({ open: false, reuseExistingTab: false });
        return { tabId: PreviewTabId.make("qa-tab") } as never;
      }),
  });
  const qa = yield* make.pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Layer.succeed(Host.QaSandboxHost, host),
        broker,
        Layer.mock(ProjectService)({
          getById: () => Effect.succeed(Option.some({ workspaceRoot: "/project" } as never)),
        }),
        Layer.mock(ThreadManagementService)({
          getThreadShell: () =>
            Effect.succeed({ projectId: "qa-project", worktreePath: "/caller-worktree" } as never),
        }),
      ),
    ),
  );
  return {
    qa,
    calls,
    files,
    disposed,
    setLaunch: (effect: Effect.Effect<void>) => {
      launch = effect;
    },
    fail: () => {
      fail = true;
    },
  };
});

it.effect("starts, lists only the caller's sandboxes, pairs a background tab and stops", () =>
  Effect.gen(function* () {
    const { qa, calls, files } = yield* fixture;
    const started = yield* qa.run(scope, {
      action: "start",
      repositoryPath: "/checkout",
      seed: "chat",
    });
    expect(started).toMatchObject({
      id: files[0]?.id,
      url: "http://127.0.0.1:31001/",
      tabId: "qa-tab",
      readyMs: 0,
      fixturePrompts: expect.stringContaining("qa:stream"),
    });
    expect(JSON.stringify(started)).not.toContain("private-credential");
    const { fixturePrompts: _fixturePrompts, ...listed } = started;
    expect(yield* qa.run(scope, { action: "status" })).toEqual({ sandboxes: [listed] });
    const other = {
      ...scope,
      thread: {
        ...scope.thread,
        threadId: ThreadId.make("other-thread"),
        providerSessionId: "other",
      },
    };
    expect(yield* qa.run(other, { action: "status" })).toEqual({ sandboxes: [] });
    expect(yield* qa.run(other, { action: "stop", id: files[0]?.id })).toEqual({ stopped: [] });
    yield* qa.run(scope, { action: "stop" });
    expect(calls).toEqual(["prepare", "launch", "open", "seed", "waitFor", "dispose", "close"]);
    expect(yield* qa.run(scope, { action: "status" })).toEqual({ sandboxes: [] });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("hands back the running sandbox for the same checkout instead of a cold start", () =>
  Effect.gen(function* () {
    const { qa, calls, files } = yield* fixture;
    const first = yield* qa.run(scope, { action: "start", repositoryPath: "/checkout" });
    const again = yield* qa.run(scope, { action: "start", repositoryPath: "/checkout" });
    expect(again).toMatchObject({ id: files[0]?.id, tabId: "qa-tab", reused: true });
    expect(calls.filter((call) => call === "prepare")).toHaveLength(1);
    const other = yield* qa.run(scope, { action: "start", repositoryPath: "/other-checkout" });
    expect(other).toMatchObject({ id: files[1]?.id });
    expect(other).not.toHaveProperty("reused");
    expect(first).not.toHaveProperty("reused");
    yield* qa.run(scope, { action: "stop" });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect.each([false, true])(
  "reuses a seeded chat without recreating its project (seed at start: %s)",
  (seedAtStart) =>
    Effect.gen(function* () {
      const { qa, calls } = yield* fixture;
      const first = yield* qa.run(scope, {
        action: "start",
        repositoryPath: "/checkout",
        ...(seedAtStart ? { seed: "chat" as const } : {}),
      });
      const seeded = yield* qa.run(scope, {
        action: "start",
        repositoryPath: "/checkout",
        seed: "chat",
      });
      expect(seeded).toMatchObject({ id: first.id, tabId: "qa-tab", reused: true });
      const again = yield* qa.run(scope, {
        action: "start",
        repositoryPath: "/checkout",
        seed: "chat",
      });
      expect(again).toMatchObject({ id: first.id, tabId: "qa-tab", reused: true });
      expect(calls.filter((call) => call === "seed")).toHaveLength(1);
      expect(calls).not.toContain("dispose");
      yield* qa.run(scope, { action: "stop" });
      expect(yield* qa.run(scope, { action: "status" })).toEqual({ sandboxes: [] });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("stops after 30 idle minutes; preview use renews the lease", () =>
  Effect.gen(function* () {
    const { qa, calls, disposed } = yield* fixture;
    yield* qa.run(scope, { action: "start", repositoryPath: "/checkout" });
    yield* TestClock.adjust("29 minutes");
    yield* qa.touch(scope);
    yield* TestClock.adjust("29 minutes");
    expect(calls).not.toContain("dispose");
    yield* TestClock.adjust("1 minute");
    yield* Deferred.await(disposed);
    expect(yield* qa.run(scope, { action: "status" })).toEqual({ sandboxes: [] });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("cleans up on shutdown", () =>
  Effect.gen(function* () {
    let calls: Array<string> = [];
    yield* Effect.scoped(
      Effect.gen(function* () {
        const fixtureValue = yield* fixture;
        calls = fixtureValue.calls;
        yield* fixtureValue.qa.run(scope, { action: "start", repositoryPath: "/checkout" });
      }),
    );
    expect(calls.slice(-2)).toEqual(["dispose", "close"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("reports a one-line failure and a log path, retaining no running sandbox", () =>
  Effect.gen(function* () {
    const { qa, fail, calls } = yield* fixture;
    fail();
    const result = yield* qa.run(scope, { action: "start", repositoryPath: "/checkout" });
    expect(result).toMatchObject({
      error: "QA sandbox readiness failed.",
      logPath: expect.stringMatching(/^\/private\/tmp\/t3-qa-.*\.log$/),
    });
    expect(JSON.stringify(result)).not.toContain("raw multi");
    expect(calls).toContain("dispose-keep-log");
    expect(yield* qa.run(scope, { action: "status" })).toEqual({ sandboxes: [] });
    if ("logPath" in result && typeof result.logPath === "string")
      yield* (yield* FileSystem.FileSystem).remove(result.logPath);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("matches exact environment markers, including orphaned children", () => {
  expect(
    Host.markedProcessIds(
      "12 node T3CODE_QA_SANDBOX=abc\n13 node T3CODE_QA_SANDBOX=abc\n14 node T3CODE_QA_SANDBOX=abcd\n15 /checkout/abc\n16 node OTHER_T3CODE_QA_SANDBOX=abc",
      "abc",
    ),
  ).toEqual([12, 13]);
});

it("freezes and kills marked orphaned children, leaving unrelated processes and ports alone", async () => {
  const processes = new Map([
    [1, "other"],
    [2, "qa"],
    [3, "qa"],
  ]);
  const signals: Array<string> = [];
  let checkedPorts = false;
  await Host.stopSandboxProcesses({
    list: async () => [...processes].filter(([, marker]) => marker === "qa").map(([pid]) => pid),
    signal: (pid, signal) => {
      signals.push(`${pid}:${signal}`);
      if (signal === "SIGKILL") processes.delete(pid);
    },
    settle: async () => {},
    assertPortsFree: async () => {
      checkedPorts = true;
    },
  });
  expect(signals).toEqual(["2:SIGSTOP", "3:SIGSTOP", "2:SIGKILL", "3:SIGKILL"]);
  expect([...processes]).toEqual([[1, "other"]]);
  expect(checkedPorts).toBe(true);
});

it("waits for a killed process to let go of its port", async () => {
  let checks = 0;
  let settles = 0;
  await Host.stopSandboxProcesses({
    list: async () => [],
    signal: () => {},
    settle: async () => {
      settles++;
    },
    assertPortsFree: async () => {
      if (++checks < 3) throw new Error("port occupied");
    },
  });
  expect(checks).toBe(3);
  expect(settles).toBe(2);
});

it("does not remove sandbox state while one of its ports is occupied", async () => {
  await expect(
    Host.stopSandboxProcesses({
      list: async () => [],
      signal: () => {},
      settle: async () => {},
      assertPortsFree: async () => {
        throw new Error("port occupied");
      },
    }),
  ).rejects.toThrow("port occupied");
});

it("blocks live ports and remote hosts with asynchronous socket errors, while allowing its own ports", () => {
  const denied: Array<string> = [];
  const deferred: Array<() => void> = [];
  let connected = 0;
  class Socket {
    connect(..._args: Array<unknown>) {
      connected++;
      return this;
    }
    destroy(error: { code: string }) {
      denied.push(error.code);
      return this;
    }
  }
  const source = Host.sandboxNetworkSource(31001, 31002).replace("import net from 'node:net';", "");
  NodeVM.runInNewContext(source, {
    net: { Socket },
    queueMicrotask: (callback: () => void) => deferred.push(callback),
  });
  const socket = new Socket();
  expect(() => socket.connect({ host: "127.0.0.1", port: 51001 })).not.toThrow();
  expect(() => socket.connect({ host: "remote.invalid", port: 31001 })).not.toThrow();
  expect(connected).toBe(0);
  expect(denied).toEqual([]);
  deferred.forEach((callback) => callback());
  expect(denied).toEqual(["EACCES", "EACCES"]);
  socket.connect({ host: "127.0.0.1", port: 31001 });
  socket.connect(31002, "localhost");
  expect(connected).toBe(2);
});

it.effect("defaults to the calling thread's own worktree", () =>
  Effect.gen(function* () {
    const { qa, files } = yield* fixture;
    yield* qa.run(scope, { action: "start" });
    expect(files[0]?.repositoryPath).toBe("/caller-worktree");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("finishes launching before cancellation removes its marked processes", () =>
  Effect.gen(function* () {
    const { qa, calls, setLaunch } = yield* fixture;
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    setLaunch(Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(release))));
    const running = yield* qa
      .run(scope, { action: "start", repositoryPath: "/checkout" })
      .pipe(Effect.forkChild);
    yield* Deferred.await(started);
    const interrupting = yield* Fiber.interrupt(running).pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    expect(calls).not.toContain("dispose");
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(interrupting);
    expect(calls).toContain("dispose");
    expect(yield* qa.run(scope, { action: "status" })).toEqual({ sandboxes: [] });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
