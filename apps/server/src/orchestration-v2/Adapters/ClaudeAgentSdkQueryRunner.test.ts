// @effect-diagnostics nodeBuiltinImport:off -- the fake CLI and its leftover child are real processes.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import { vi } from "vite-plus/test";

import { AgentScope } from "@t3tools/shared/AgentScope";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  awaitClaudeAiConnectors,
  CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
  claudeAiConnectorsAnswered,
  claudeLaunchMayHaveConnectors,
  ClaudeAgentSdkQueryRunner,
  type ClaudeAgentSdkQueryOpenInput,
  layerQueryRunner,
  spawnClaudeProcessGroup,
} from "./ClaudeAdapterV2.ts";
import { supportsEnvChdir } from "@t3tools/shared/envTrampoline";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

it.effect("logs successful task stops for replay and omits failed stops", () =>
  Effect.gen(function* () {
    const writes: unknown[] = [];
    const stopTask = vi.fn(async (_taskId: string) => {});
    const query = vi.spyOn(ClaudeSdk, "query").mockReturnValue({
      stopTask,
    } as unknown as ClaudeSdk.Query);
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const threadId = ThreadId.make("thread-stop");
    const providerSessionId = ProviderSessionId.make("session-stop");
    yield* Effect.gen(function* () {
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const session = yield* runner.open({
        threadId,
        providerSessionId,
        options: {
          sessionId: "native-session-stop",
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
        },
      });
      writes.length = 0;
      yield* session.stopTask("workflow-task");
      assert.deepEqual(stopTask.mock.calls, [["workflow-task"]]);
      assert.deepEqual(writes, [
        {
          provider: "claudeAgent",
          protocol: CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
          kind: "protocol",
          providerSessionId,
          event: {
            direction: "outgoing",
            stage: "decoded",
            payload: { type: "query.stop_task", taskId: "workflow-task" },
          },
        },
      ]);
      stopTask.mockRejectedValueOnce(new Error("Stop failed"));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(session.stopTask("failed-task"))));
      assert.equal(writes.length, 1);
    }).pipe(
      Effect.provide(
        layerQueryRunner.pipe(
          Layer.provide(
            Layer.succeed(ProviderEventLoggers, {
              native: {
                filePath: "/tmp/events.log",
                write: (event) =>
                  Effect.sync(() => {
                    writes.push(event);
                  }),
                close: () => Effect.void,
              },
              canonical: undefined,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const realQueryRunner = layerQueryRunner.pipe(
  Layer.provide(
    Layer.succeed(ProviderEventLoggers, {
      native: undefined,
      canonical: undefined,
    }),
  ),
  Layer.provide(NodeServices.layer),
);

it.effect("forks the native transcript in each Claude account", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-history-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    const ambient = vi
      .spyOn(ClaudeSdk, "forkSession")
      .mockRejectedValue(new Error("ambient account"));
    yield* Effect.addFinalizer(() => Effect.sync(() => ambient.mockRestore()));
    const runner = yield* ClaudeAgentSdkQueryRunner;
    const sessionId = "76543210-1234-4234-9234-123456789000";
    for (const account of ["first", "second"]) {
      const configDir = NodePath.join(root, account);
      const dir = "/fixture/workspace";
      const project = NodePath.join(configDir, "projects", "-fixture-workspace");
      NodeFS.mkdirSync(project, { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(project, sessionId + ".jsonl"),
        JSON.stringify({
          type: "user",
          uuid: "76543210-1234-4234-9234-123456789001",
          parentUuid: null,
          sessionId,
          cwd: dir,
          message: { role: "user", content: account },
        }) + "\n",
      );
      const subagents = NodePath.join(project, sessionId, "subagents");
      NodeFS.mkdirSync(subagents, { recursive: true });
      const agentId = "a1234567890abcdef";
      const agentPath = NodePath.join(subagents, "agent-" + agentId);
      NodeFS.copyFileSync(NodePath.join(project, sessionId + ".jsonl"), agentPath + ".jsonl");
      const toolUseId = "toolu_" + account;
      NodeFS.writeFileSync(agentPath + ".meta.json", JSON.stringify({ toolUseId }));
      assert.equal(
        yield* runner.subagentLaunchToolUseId({
          sessionId,
          agentId,
          dir,
          configDir,
          threadId: ThreadId.make("fixture"),
          providerSessionId: ProviderSessionId.make("fixture"),
        }),
        toolUseId,
      );
      const fork = yield* runner.forkSession({
        sessionId,
        options: { dir },
        configDir,
        threadId: ThreadId.make("fixture"),
        providerSessionId: ProviderSessionId.make("fixture"),
      });
      assert.include(
        NodeFS.readFileSync(NodePath.join(project, fork.sessionId + ".jsonl"), "utf8"),
        account,
      );
    }
    assert.equal(ambient.mock.calls.length, 0);
  }).pipe(Effect.provide(realQueryRunner)),
);

const resumedMcpQueryInput = {
  threadId: ThreadId.make("thread-restart-registration"),
  providerSessionId: ProviderSessionId.make("session-restart-registration"),
  options: {
    resume: "native-resume-test",
    model: "claude-sonnet-4-6",
    tools: [],
    permissionMode: "default",
    mcpServers: {
      "t3-code": {
        type: "http",
        url: "http://localhost:3773/mcp",
        headers: { Authorization: "Bearer test-mcp-credential" },
      },
    },
  },
} satisfies ClaudeAgentSdkQueryOpenInput;

it.effect("reopens a stalled MCP registration before delivering the resumed prompt", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const disposalStarted = Promise.withResolvers<void>();
      const finishDisposal = Promise.withResolvers<void>();
      const prompts: AsyncIterable<ClaudeSdk.SDKUserMessage>[] = [];
      const firstClose = vi.fn();
      const secondClose = vi.fn();
      const firstRegistration = vi.fn(() => {
        registrationStarted.resolve();
        return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
      });
      const secondRegistration = vi.fn(async () => ({
        added: ["t3-code"],
        removed: [],
        errors: {},
      }));
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ prompt }) => {
        assert.notTypeOf(prompt, "string");
        if (typeof prompt === "string") throw new Error("Expected streaming input");
        prompts.push(prompt);
        return {
          initializationResult: async () => ({}),
          setMcpServers: prompts.length === 1 ? firstRegistration : secondRegistration,
          close: prompts.length === 1 ? firstClose : secondClose,
          [Symbol.asyncDispose]: async () => {
            firstClose();
            disposalStarted.resolve();
            await finishDisposal.promise;
          },
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner.open(resumedMcpQueryInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");
      yield* Effect.promise(() => disposalStarted.promise);
      assert.equal(querySpy.mock.calls.length, 1);
      finishDisposal.resolve();
      const session = yield* Fiber.join(opening);
      yield* Effect.addFinalizer(() => session.close.pipe(Effect.orDie));

      assert.equal(firstClose.mock.calls.length, 1);
      assert.equal(secondClose.mock.calls.length, 0);
      assert.equal(querySpy.mock.calls.length, 2);
      for (const [call] of querySpy.mock.calls) {
        assert.equal(call.options?.resume, "native-resume-test");
        assert.isUndefined(call.options?.mcpServers);
      }
      assert.deepEqual(secondRegistration.mock.calls, [[resumedMcpQueryInput.options.mcpServers]]);
      const message = {
        type: "user",
        message: { role: "user", content: "Continue where you left off." },
        parent_tool_use_id: null,
        session_id: "native-resume-test",
      } satisfies ClaudeSdk.SDKUserMessage;
      yield* session.offer(message);
      assert.isTrue((yield* Effect.promise(() => prompts[0]![Symbol.asyncIterator]().next())).done);
      const delivered = yield* Effect.promise(() => prompts[1]![Symbol.asyncIterator]().next());
      assert.deepEqual(delivered.value, message);
      assert.isFalse(delivered.done);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

const docs = (status: string) => ({ name: "claude.ai Claude Docs", status, scope: "claudeai" });
const gmail = (status: string) => ({ name: "claude.ai Gmail", status });
const own = { name: "t3-code", status: "connected", scope: "dynamic" };

it("reads whether the account's claude.ai connectors have answered", () => {
  assert.isUndefined(claudeAiConnectorsAnswered([]));
  assert.isUndefined(claudeAiConnectorsAnswered([own]));
  assert.isFalse(claudeAiConnectorsAnswered([own, docs("connected"), gmail("pending")]));
  assert.isTrue(claudeAiConnectorsAnswered([own, docs("connected"), gmail("connected")]));
  // A connector that failed or needs sign-in has answered: nothing more to wait for.
  assert.isTrue(claudeAiConnectorsAnswered([docs("failed"), gmail("needs-auth")]));
});

it("waits for connectors only where an earlier turn can have announced them", () => {
  assert.isTrue(claudeLaunchMayHaveConnectors({ resume: "native" }));
  assert.isTrue(claudeLaunchMayHaveConnectors({ resume: "native", env: { HOME: "/home" } }));
  // A new conversation has nothing announced, so nothing can be reported gone.
  assert.isFalse(claudeLaunchMayHaveConnectors({}));
  assert.isFalse(
    claudeLaunchMayHaveConnectors({
      resume: "native",
      env: { ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
    }),
  );
  assert.isFalse(
    claudeLaunchMayHaveConnectors({
      resume: "native",
      env: { ANTHROPIC_BASE_URL: "https://example.test" },
    }),
  );
});

it.effect("holds until the connectors answer, and never past the deadline", () =>
  Effect.gen(function* () {
    // Connected on the third look.
    let looks = 0;
    const answering = yield* awaitClaudeAiConnectors(async () => {
      looks += 1;
      return looks < 3 ? [own, docs("pending")] : [own, docs("connected")];
    }).pipe(Effect.forkChild);
    yield* TestClock.adjust("250 millis");
    assert.deepEqual(yield* Fiber.join(answering), { listed: true, answered: true, waitedMs: 200 });

    // Never listed: gives up at the deadline and says none was seen.
    const absent = yield* awaitClaudeAiConnectors(async () => [own], 1_000).pipe(Effect.forkChild);
    yield* TestClock.adjust("2 seconds");
    assert.deepEqual(yield* Fiber.join(absent), {
      listed: false,
      answered: false,
      waitedMs: 1_000,
    });

    // A CLI that cannot answer is not waited on at all.
    assert.deepEqual(
      yield* awaitClaudeAiConnectors(() => Promise.reject(new Error("no such request"))),
      { listed: false, answered: false, waitedMs: 0 },
    );

    // A status request that never returns still ends at the deadline.
    const stuck = yield* awaitClaudeAiConnectors(() => new Promise(() => {}), 1_000).pipe(
      Effect.forkChild,
    );
    yield* TestClock.adjust("2 seconds");
    assert.deepEqual(yield* Fiber.join(stuck), { listed: false, answered: false, waitedMs: 1_000 });
  }),
);

it.effect("delivers a resumed prompt only after the claude.ai connectors answered", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const firstLook = Promise.withResolvers<void>();
      let connected = false;
      const status = vi.fn(async () => {
        firstLook.resolve();
        return [docs(connected ? "connected" : "pending")];
      });
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            initializationResult: async () => ({}),
            setMcpServers: async () => ({ added: ["t3-code"], removed: [], errors: {} }),
            mcpServerStatus: status,
            close: () => {},
            [Symbol.asyncDispose]: async () => {},
          }) as unknown as ClaudeSdk.Query,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner.open(resumedMcpQueryInput).pipe(Effect.forkChild);
      yield* Effect.promise(() => firstLook.promise);
      yield* TestClock.adjust("300 millis");
      assert.isUndefined(opening.pollUnsafe());
      connected = true;
      yield* TestClock.adjust("100 millis");
      const session = yield* Fiber.join(opening);
      yield* Effect.addFinalizer(() => session.close.pipe(Effect.orDie));
      assert.isAtLeast(status.mock.calls.length, 2);

      // A new conversation is not held: there is nothing to report gone.
      status.mockClear();
      const { resume: _resume, ...fresh } = resumedMcpQueryInput.options;
      const created = yield* runner.open({
        ...resumedMcpQueryInput,
        options: { ...fresh, sessionId: "native-new-test" },
      });
      yield* Effect.addFinalizer(() => created.close.pipe(Effect.orDie));
      assert.equal(status.mock.calls.length, 0);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect.each([true, false])("only retries after confirmed process exit: %s", (exits) =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const cleanupProgress = Promise.withResolvers<"kill" | "retry">();
      const events = new NodeEvents.EventEmitter();
      const stdin = new NodeStream.PassThrough();
      const stdout = new NodeStream.PassThrough();
      const child = {
        stdin,
        stdout,
        killed: false,
        exitCode: null,
        kill: vi.fn(() => {
          cleanupProgress.resolve("kill");
          return true;
        }),
        on: events.on.bind(events),
        once: events.once.bind(events),
        off: events.off.bind(events),
      } satisfies ClaudeSdk.SpawnedProcess;
      const signal = yield* Effect.abortSignal;
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(({ options }) => {
        const first = querySpy.mock.calls.length === 1;
        if (first) {
          options?.spawnClaudeCodeProcess?.({ command: "claude", args: [], env: {}, signal });
        } else {
          cleanupProgress.resolve("retry");
        }
        return {
          initializationResult: async () => ({}),
          setMcpServers: () => {
            registrationStarted.resolve();
            return first
              ? new Promise<ClaudeSdk.McpSetServersResult>(() => {})
              : Promise.resolve({ added: ["t3-code"], removed: [], errors: {} });
          },
          close: vi.fn(),
          [Symbol.asyncDispose]: disposed,
        } as unknown as ClaudeSdk.Query;
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          querySpy.mockRestore();
          stdin.destroy();
          stdout.destroy();
        }),
      );
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const opening = yield* runner
        .open({
          ...resumedMcpQueryInput,
          options: { ...resumedMcpQueryInput.options, spawnClaudeCodeProcess: () => child },
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");

      assert.equal(yield* Effect.promise(() => cleanupProgress.promise), "kill");
      assert.equal(querySpy.mock.calls.length, 1);
      assert.deepEqual(child.kill.mock.calls, [["SIGKILL"]]);
      if (exits) events.emit("exit", null, "SIGKILL");
      else yield* TestClock.adjust("10 seconds");
      const result = yield* Fiber.join(opening);
      assert.equal(Exit.isSuccess(result), exits);
      if (Exit.isSuccess(result)) yield* result.value.close;
      assert.equal(querySpy.mock.calls.length, exits ? 2 : 1);
      assert.equal(disposed.mock.calls.length, 1);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect("does not reuse a fresh session ID after MCP registration times out", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const registrationStarted = Promise.withResolvers<void>();
      const disposed = vi.fn(async () => {});
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            initializationResult: async () => ({}),
            setMcpServers: () => {
              registrationStarted.resolve();
              return new Promise<ClaudeSdk.McpSetServersResult>(() => {});
            },
            [Symbol.asyncDispose]: disposed,
          }) as unknown as ClaudeSdk.Query,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const { resume, ...options } = resumedMcpQueryInput.options;
      const opening = yield* runner
        .open({
          ...resumedMcpQueryInput,
          options: { ...options, sessionId: resume },
        })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => registrationStarted.promise);
      yield* TestClock.adjust("90 seconds");
      const result = yield* Fiber.join(opening);

      assert.equal(result._tag, "Failure");
      assert.equal(querySpy.mock.calls.length, 1);
      assert.equal(disposed.mock.calls.length, 1);
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

it.effect.each([
  ["opens after a slow CLI boot", "120 seconds", true],
  ["times out a CLI that never boots", "5 minutes", false],
] as const)("%s", ([, bootWait, boots]) =>
  Effect.scoped(
    Effect.gen(function* () {
      const waiting = Promise.withResolvers<void>();
      const booted = Promise.withResolvers<void>();
      const querySpy = vi.spyOn(ClaudeSdk, "query").mockImplementation(
        () =>
          ({
            initializationResult: () => {
              waiting.resolve();
              return booted.promise;
            },
            // The CLI answers control requests only after it has booted.
            setMcpServers: async () => {
              waiting.resolve();
              await booted.promise;
              return { added: ["t3-code"], removed: [], errors: {} };
            },
            close: vi.fn(),
            [Symbol.asyncDispose]: async () => {},
          }) as unknown as ClaudeSdk.Query,
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => querySpy.mockRestore()));
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const { resume, ...options } = resumedMcpQueryInput.options;
      const opening = yield* runner
        .open({ ...resumedMcpQueryInput, options: { ...options, sessionId: resume } })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => waiting.promise);
      yield* TestClock.adjust(bootWait);
      if (boots) booted.resolve();
      const result = yield* Fiber.join(opening);

      assert.equal(result._tag, boots ? "Success" : "Failure");
      if (result._tag === "Success") yield* result.success.close;
      else
        assert.equal(
          makeProviderFailure({
            cause: { _tag: "ProviderAdapterTurnStartError", cause: result.failure },
          }).message,
          "Claude timed out while starting up. Retry the turn; if it keeps failing, check Claude and the server logs.",
        );
    }).pipe(Effect.provide(realQueryRunner)),
  ),
);

/** Writes an executable stand-in for the Claude CLI into a fresh directory. */
function fakeClaudeCli(script: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-cli-"));
  const cli = NodePath.join(dir, "claude");
  NodeFS.writeFileSync(cli, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return cli;
}

const openFakeCli = (cli: string) =>
  Effect.gen(function* () {
    const runner = yield* ClaudeAgentSdkQueryRunner;
    return yield* runner.open({
      threadId: ThreadId.make("thread-fake-cli"),
      providerSessionId: ProviderSessionId.make("session-fake-cli"),
      options: {
        sessionId: "native-session-fake-cli",
        model: "claude-sonnet-4-6",
        tools: [],
        permissionMode: "default",
        pathToClaudeCodeExecutable: cli,
      },
    });
  });

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("Claude CLI process", () => {
  // A native cwd makes libuv wait for chdir, which a hung mount stalls with the whole server.
  it.effect("enters the cwd in the child, so a missing one fails the CLI and not the spawn", () =>
    Effect.gen(function* () {
      if (!(yield* Effect.promise(supportsEnvChdir))) return;
      const cli = fakeClaudeCli('pwd -P > "$(dirname "$0")/cwd"');
      const dir = NodePath.dirname(cli);
      const workspace = NodePath.join(dir, "work space");
      NodeFS.mkdirSync(workspace);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      );
      const exitCode = (cwd: string) =>
        Effect.promise(
          () =>
            new Promise<number | null>((resolve) => {
              const child = spawnClaudeProcessGroup(
                {
                  command: cli,
                  args: [],
                  cwd,
                  env: process.env,
                  signal: new AbortController().signal,
                },
                undefined,
                true,
              );
              assert.deepEqual(child.spawnargs.slice(0, 3), ["/usr/bin/env", "-C", cwd]);
              child.once("exit", resolve);
            }),
        );
      assert.equal(yield* exitCode(workspace), 0);
      assert.equal(
        NodeFS.readFileSync(NodePath.join(dir, "cwd"), "utf8"),
        `${NodeFS.realpathSync(workspace)}\n`,
      );
      assert.equal(yield* exitCode(NodePath.join(dir, "missing")), 125);
    }).pipe(Effect.scoped),
  );

  // The CLI stops the MCP servers it started, but not their children: a
  // plugin's `bun server.ts` outlives its `bun run` wrapper (#3089). The fake
  // CLI leaves a child running the same way. The child holds a FIFO open, so
  // its death reads as end-of-file here, with no polling.
  it.effect("stops what the CLI left running when the session closes", () =>
    Effect.gen(function* () {
      const cli = fakeClaudeCli(
        [
          'dir=$(dirname "$0")',
          'sleep 600 > "$dir/alive" &',
          'echo $! > "$dir/leftover.pid"',
          "cat > /dev/null",
        ].join("\n"),
      );
      const dir = NodePath.dirname(cli);
      NodeChildProcess.execFileSync("mkfifo", [NodePath.join(dir, "alive")]);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          // Only does anything when the test fails: do not leak its child.
          try {
            process.kill(Number(NodeFS.readFileSync(NodePath.join(dir, "leftover.pid"), "utf8")));
          } catch {}
          NodeFS.rmSync(dir, { recursive: true, force: true });
        }),
      );
      const alive = NodeFS.createReadStream(NodePath.join(dir, "alive"));
      const leftoverStarted = new Promise<void>((resolve) => alive.once("open", () => resolve()));
      const leftoverStopped = new Promise<void>((resolve) => alive.once("close", () => resolve()));
      alive.resume();

      const stopped = yield* Deferred.make<string>();
      const session = yield* openFakeCli(cli).pipe(
        Effect.provide(
          realQueryRunner.pipe(
            Layer.provide(
              Layer.succeed(AgentScope, {
                ...AgentScope.defaultValue(),
                wrap: ({ command, args }) =>
                  Effect.succeed({ command, args, unit: "t3code-claude-test.scope" }),
                stop: (unit) => Deferred.succeed(stopped, unit).pipe(Effect.asVoid),
              }),
            ),
          ),
        ),
      );
      yield* Effect.promise(() => leftoverStarted);
      yield* session.close;
      yield* Effect.promise(() => leftoverStopped);
      assert.strictEqual(yield* Deferred.await(stopped), "t3code-claude-test.scope");
    }),
  );
});
