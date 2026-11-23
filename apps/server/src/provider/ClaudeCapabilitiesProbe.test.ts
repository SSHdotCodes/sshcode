// @effect-diagnostics nodeBuiltinImport:off - cleanup uses Node's retrying rm, which the FileSystem service does not expose.
import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  ClaudeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { supportsEnvChdir } from "@t3tools/shared/envTrampoline";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  buildClaudeCapabilitiesProbeQueryOptions,
  spawnClaudeProbeThroughEnv,
  CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES,
  makeClaudeWorkspaceSnapshots,
  probeClaudeCapabilities,
} from "./ClaudeProvider.ts";
import {
  CLAUDE_BTW_SLASH_COMMAND,
  COMPACT_SLASH_COMMAND,
} from "@t3tools/provider-core/server/snapshotProbe";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

type ProbeQuery = ReturnType<typeof ClaudeSdk.query>;

/**
 * Stands in for the SDK query of a probe. Like Claude Code, its process exits once its input
 * ends, here after `exit` settles; an abort ends it at once.
 */
function fakeProbeQuery(
  { prompt, options }: Parameters<typeof ClaudeSdk.query>[0],
  calls: {
    readonly initializationResult?: () => Promise<Partial<ClaudeSdk.SDKControlInitializeResponse>>;
    readonly usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET?: (options?: {
      readonly skipBehaviors?: boolean;
    }) => Promise<Partial<ClaudeSdk.SDKControlGetUsageResponse>>;
  },
  process: {
    readonly onInputEnded?: () => void;
    readonly exit?: Promise<void>;
    readonly onExit?: () => void;
  } = {},
): ProbeQuery {
  const inputEnded = (async () => {
    if (typeof prompt !== "string") for await (const _message of prompt);
    process.onInputEnded?.();
    await process.exit;
  })();
  const aborted = new Promise<void>((resolve) =>
    options?.abortController?.signal.addEventListener("abort", () => resolve(), { once: true }),
  );
  return {
    initializationResult: async () => ({ commands: [] }),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => ({
      rate_limits_available: false,
      rate_limits: null,
    }),
    ...calls,
    // oxlint-disable-next-line require-yield -- the fake process prints nothing before it exits.
    async *[Symbol.asyncIterator]() {
      await Promise.race([inputEnded, aborted]);
      process.onExit?.();
    },
  } as unknown as ProbeQuery;
}

const readyMachineSnapshot = {
  instanceId: ProviderInstanceId.make("claude"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-03-25T00:00:00.000Z",
  version: "2.1.288",
  models: [],
  slashCommands: [{ name: "server-cwd-only" }],
  skills: [],
} satisfies ServerProvider;
const hostPath = process.env.PATH;
const envChdir = HostProcess.Platform.defaultValue() !== "win32" && (await supportsEnvChdir());

// A shell trampoline would not do: dash drops the exported function, and the launcher exits 127.
it.live.skipIf(!envChdir)(
  "starts a Bash launcher that calls an exported function in the probe's workspace",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const workspace = yield* fileSystem.realPath(yield* fileSystem.makeTempDirectoryScoped());
      yield* fileSystem.writeFileString(`${workspace}/claude`, '#!/bin/bash\nt3_launch "$@"\n');
      yield* fileSystem.chmod(`${workspace}/claude`, 0o755);
      const child = spawnClaudeProbeThroughEnv({
        command: "claude",
        args: ["--probe"],
        cwd: workspace,
        env: { PATH: `.:${hostPath}`, "BASH_FUNC_t3_launch%%": '() { echo "$PWD $@"; }' },
        // @effect-diagnostics-next-line abortControllerInEffect:off - The launcher exits on its own.
        signal: new AbortController().signal,
      });
      assert.deepEqual(child.spawnargs.slice(0, 3), ["/usr/bin/env", "-C", workspace]);
      const output = yield* Effect.promise(() => child.stdout.setEncoding("utf8").toArray());
      assert.equal(output.join(""), `${workspace} --probe\n`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it("isolates Claude capability probes without dropping workspace setting sources", () => {
  const abortController = new AbortController();
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController,
    environment: {
      HOME: "/home/user",
      ENABLE_CLAUDEAI_MCP_SERVERS: "true",
      FORCE_CODE_TERMINAL: "1",
    },
    cwd: "/workspace/project",
    managedMcpConfig: false,
    spawnThroughEnv: false,
  });

  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.strictMcpConfig, true);
  assert.equal(options.cwd, "/workspace/project");
  assert.deepEqual(options.settingSources, [...CLAUDE_CAPABILITIES_PROBE_SETTING_SOURCES]);
  assert.deepEqual(options.settings, { disableAllHooks: true });
  assert.deepEqual(options.allowedTools, []);
  assert.equal(options.persistSession, false);
  assert.equal(options.pathToClaudeCodeExecutable, "/usr/bin/claude");
  assert.equal(options.abortController, abortController);
  assert.equal(options.env?.HOME, "/home/user");
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
  assert.equal(options.env?.FORCE_CODE_TERMINAL, undefined);
  assert.equal(options.env?.CLAUDE_CODE_AUTO_CONNECT_IDE, "0");
  assert.equal(options.env?.CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL, "1");
});

it("drops strict MCP mode, and only that, next to an administrator's managed-mcp.json", () => {
  const options = buildClaudeCapabilitiesProbeQueryOptions({
    executablePath: "/usr/bin/claude",
    abortController: new AbortController(),
    environment: { HOME: "/home/user" },
    cwd: undefined,
    managedMcpConfig: true,
    spawnThroughEnv: false,
  });

  // Claude exits before initializing when handed --strict-mcp-config here.
  assert.equal(options.strictMcpConfig, undefined);
  assert.deepEqual(options.mcpServers, {});
  assert.equal(options.env?.ENABLE_CLAUDEAI_MCP_SERVERS, "false");
});

it.layer(NodeServices.layer)("Claude capability probe SDK boundary", (it) => {
  it.effect(
    "discovers commands and skills separately for each cwd without replacing machine metadata",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-workspaces-" });
        const configDir = path.join(tempDir, "claude-home");
        const workspaces = [path.join(tempDir, "one"), path.join(tempDir, "two")];
        for (const cwd of workspaces) {
          const skillDir = path.join(cwd, ".claude", "skills", "existing-skill");
          yield* fs.makeDirectory(skillDir, { recursive: true });
          yield* fs.writeFileString(
            path.join(skillDir, "SKILL.md"),
            "---\nname: existing-skill\ndescription: Existing project skill\n---\nUse this skill.",
          );
        }
        const machineSnapshot = {
          instanceId: ProviderInstanceId.make("claude"),
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          installed: true,
          status: "ready",
          auth: { status: "authenticated", email: "machine@example.com" },
          checkedAt: "2026-03-25T00:00:00.000Z",
          version: "2.1.288",
          models: [],
          slashCommands: [{ name: "server-cwd-only" }],
          skills: [],
        } satisfies ServerProvider;
        let usageCalls = 0;
        const query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
          const { options } = input;
          assert.equal(options?.env?.CLAUDE_CONFIG_DIR, configDir);
          assert.equal(options?.env?.T3_WORKSPACE_PROBE, "owned-instance");
          return fakeProbeQuery(input, {
            initializationResult: async () => ({
              account: { email: "workspace@example.com" },
              commands: [
                {
                  name: options?.cwd === workspaces[0] ? "start-session" : "other-project",
                  description: "Project command",
                  argumentHint: "[topic]",
                },
                { name: "nested:review", description: "Review changes", argumentHint: "" },
                { name: "NESTED:review", description: "", argumentHint: "[path]" },
                { name: "compact", description: "Provider compact", argumentHint: "" },
                { name: "user-command", description: "Existing user command", argumentHint: "" },
              ],
            }),
            usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async () => {
              usageCalls++;
              return { rate_limits_available: false, rate_limits: null };
            },
          });
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
        const workspaceSnapshots = yield* makeClaudeWorkspaceSnapshots(
          decodeClaudeSettings({ homePath: configDir }),
          { ...process.env, T3_WORKSPACE_PROBE: "owned-instance" },
        );
        for (const [index, cwd] of workspaces.entries()) {
          const scoped = yield* workspaceSnapshots.snapshot(machineSnapshot, cwd);
          assert.deepEqual(scoped, {
            ...machineSnapshot,
            slashCommandsPending: false,
            slashCommands: [
              COMPACT_SLASH_COMMAND,
              CLAUDE_BTW_SLASH_COMMAND,
              {
                name: index === 0 ? "start-session" : "other-project",
                description: "Project command",
                input: { hint: "[topic]" },
              },
              { name: "nested:review", description: "Review changes", input: { hint: "[path]" } },
              { name: "user-command", description: "Existing user command" },
            ],
            skills: [
              {
                name: "existing-skill",
                path: path.join(cwd, ".claude", "skills", "existing-skill", "SKILL.md"),
                enabled: true,
                scope: "project",
                description: "Existing project skill",
              },
            ],
          });
        }
        assert.deepEqual(
          query.mock.calls.map(([input]) => input.options?.cwd),
          workspaces,
        );
        assert.equal(usageCalls, 0);
      }).pipe(Effect.scoped),
  );

  it.effect("keeps readable skills during failed command discovery and recovers on retry", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-workspace-retry-" });
      const skillDir = path.join(cwd, ".claude", "skills", "existing-skill");
      yield* fs.makeDirectory(skillDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(skillDir, "SKILL.md"),
        "---\nname: existing-skill\ndescription: Existing project skill\n---\nUse this skill.",
      );
      const query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) =>
        fakeProbeQuery(input, {
          initializationResult: () =>
            Promise.reject<ClaudeSdk.SDKControlInitializeResponse>(
              new Error("Initialization failed"),
            ),
        }),
      );
      yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
      const settings = decodeClaudeSettings({ homePath: cwd });
      const workspaceSnapshots = yield* makeClaudeWorkspaceSnapshots(settings);
      const failed = yield* workspaceSnapshots.snapshot(readyMachineSnapshot, cwd);
      assert.deepEqual(failed, {
        ...readyMachineSnapshot,
        slashCommands: [COMPACT_SLASH_COMMAND, CLAUDE_BTW_SLASH_COMMAND],
        slashCommandsPending: true,
        skills: [
          {
            name: "existing-skill",
            path: path.join(skillDir, "SKILL.md"),
            enabled: true,
            scope: "project",
            description: "Existing project skill",
          },
        ],
      });
      // The failed scan is not reused.
      query.mockImplementation((input) =>
        fakeProbeQuery(input, {
          initializationResult: async () => ({
            commands: [{ name: "recovered", description: "", argumentHint: "" }],
          }),
        }),
      );
      const recovered = yield* workspaceSnapshots.snapshot(readyMachineSnapshot, cwd);
      assert.deepEqual(recovered.slashCommands, [
        COMPACT_SLASH_COMMAND,
        CLAUDE_BTW_SLASH_COMMAND,
        { name: "recovered" },
      ]);
      assert.equal(recovered.status, "ready");
      assert.equal(recovered.slashCommandsPending, false);
      assert.deepEqual(recovered.skills, failed.skills);
      const disabled = yield* (yield* makeClaudeWorkspaceSnapshots({
        ...settings,
        enabled: false,
      })).snapshot(readyMachineSnapshot, cwd);
      assert.equal(disabled, readyMachineSnapshot);
      assert.equal(query.mock.calls.length, 2);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a probe on a Claude config folder waits for the previous probe's process to exit",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const folder = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-lock-" });
        const otherFolder = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-lock-" });
        let finishFirst!: () => void;
        const firstExit = new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
        const running = new Map<string, number>();
        let mostAtOnce = 0;
        const query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
          const dir = input.options?.env?.CLAUDE_CONFIG_DIR ?? "";
          const isFirst = query.mock.calls.length === 1;
          running.set(dir, (running.get(dir) ?? 0) + 1);
          mostAtOnce = Math.max(mostAtOnce, running.get(dir) ?? 0);
          return fakeProbeQuery(
            input,
            {},
            {
              ...(isFirst ? { exit: firstExit } : {}),
              onExit: () => running.set(dir, (running.get(dir) ?? 1) - 1),
            },
          );
        });
        yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
        const probe = (homePath: string) =>
          probeClaudeCapabilities(decodeClaudeSettings({ homePath })).pipe(Effect.forkChild);
        // The first probe has answered; its process is still finishing, say a login renewal.
        yield* Fiber.join(yield* probe(folder));
        assert.equal(running.get(folder), 1);
        const second = yield* probe(folder);
        yield* Fiber.join(yield* probe(otherFolder));
        assert.equal(query.mock.calls.length, 2);
        finishFirst();
        yield* Fiber.join(second);
        assert.equal(query.mock.calls.length, 3);
        assert.equal(mostAtOnce, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("serializes strict no-MCP options and still resolves account capabilities", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-sdk-" });
      const executablePath = yield* path.fromFileUrl(
        new URL("./testing/ClaudeCapabilitiesProbe.fixture.mjs", import.meta.url),
      );
      const invocationPath = path.join(tempDir, "invocation.json");
      // The probe answers before its child has exited, and on Windows a directory
      // that is still some process's cwd cannot be removed. Keep the workspace
      // outside the scoped directory and let it go with a retrying removal once
      // the child has gone.
      const workspaceCwd = yield* fs.makeTempDirectory({ prefix: "t3-claude-probe-cwd-" });
      // Node's own retry rather than an Effect schedule: the TestClock would leave
      // a scheduled retry waiting. If the child still holds the directory after
      // that, an empty temp directory is left behind rather than failing the test.
      yield* Effect.addFinalizer(() =>
        Effect.promise(() =>
          NodeFSP.rm(workspaceCwd, {
            recursive: true,
            force: true,
            maxRetries: 20,
            retryDelay: 250,
          }).catch(() => undefined),
        ),
      );

      const capabilities = yield* probeClaudeCapabilities(
        decodeClaudeSettings({ binaryPath: executablePath }),
        {
          ...process.env,
          T3_PROBE_INVOCATION_PATH: invocationPath,
          ENABLE_CLAUDEAI_MCP_SERVERS: "true",
        },
        workspaceCwd,
      );

      assert.deepEqual(capabilities, {
        email: "dev@example.com",
        subscriptionType: "pro",
        tokenSource: "oauth",
        apiKeySource: undefined,
        apiProvider: undefined,
        slashCommands: [
          {
            name: "review",
            description: "Review changes",
            input: { hint: "[path]" },
          },
        ],
        // The CLI's own model list, for models the manifest does not list yet.
        reportedModels: [
          { slug: "claude-fable-9", name: "Claude Fable 9", effortLevels: ["low", "high"] },
        ],
        usage: {
          rate_limits_available: true,
          rate_limits: { five_hour: { utilization: 12, resets_at: "2026-07-18T14:39:00Z" } },
        },
        // When the usage reading was taken, so an older probe can't replace a newer one.
        usageCheckedAt: "1970-01-01T00:00:00.000Z",
      });

      const invocation = JSON.parse(yield* fs.readFileString(invocationPath)) as {
        readonly args: ReadonlyArray<string>;
        readonly cwd: string;
        readonly connectorEnv: string;
        readonly mcpConfig: unknown;
      };
      assert.equal(invocation.cwd, yield* fs.realPath(workspaceCwd));
      assert.equal(invocation.connectorEnv, "false");
      assert.equal(invocation.args.includes("--strict-mcp-config"), true);
      assert.equal(invocation.args.includes("--mcp-config"), false);
      assert.equal(invocation.mcpConfig, undefined);

      assert.equal(invocation.args.includes("--setting-sources=user,project,local"), true);

      const settingsFlagIndex = invocation.args.indexOf("--settings");
      assert.notEqual(settingsFlagIndex, -1);
      const flagSettings = JSON.parse(invocation.args[settingsFlagIndex + 1] ?? "{}") as {
        readonly disableAllHooks?: boolean;
      };
      assert.equal(flagSettings.disableAllHooks, true);
    }).pipe(Effect.scoped),
  );
});

it.effect("reuses a workspace's commands for half an hour, and rescans once cleared", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-workspace-reuse-" });
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) =>
      fakeProbeQuery(input, {
        initializationResult: async () => ({
          commands: [{ name: "start-session", description: "", argumentHint: "" }],
        }),
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const workspaceSnapshots = yield* makeClaudeWorkspaceSnapshots(
      decodeClaudeSettings({ homePath: cwd }),
    );
    const scan = workspaceSnapshots.snapshot(readyMachineSnapshot, cwd);
    const first = yield* scan;
    yield* scan;
    yield* TestClock.adjust("29 minutes");
    assert.deepEqual((yield* scan).slashCommands, first.slashCommands);
    assert.equal(query.mock.calls.length, 1);
    yield* TestClock.adjust("1 minute");
    yield* scan;
    assert.equal(query.mock.calls.length, 2);
    // Restart agent session clears the instance's caches.
    yield* workspaceSnapshots.invalidate;
    yield* scan;
    assert.equal(query.mock.calls.length, 3);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("preserves initialized capabilities when optional usage times out", () =>
  Effect.gen(function* () {
    const usageStarted = yield* Deferred.make<void>();
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
      abortSignal = input.options?.abortController?.signal;
      return fakeProbeQuery(input, {
        initializationResult: async () => ({
          account: { email: "dev@example.com", subscriptionType: "pro", tokenSource: "oauth" },
          commands: [{ name: "review", description: "Review changes", argumentHint: "[path]" }],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: () => {
          Deferred.doneUnsafe(usageStarted, Effect.void);
          return new Promise(() => {});
        },
      });
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const probe = yield* probeClaudeCapabilities(
      decodeClaudeSettings({ binaryPath: "claude" }),
    ).pipe(Effect.forkChild);
    yield* Deferred.await(usageStarted);
    yield* TestClock.adjust("4 seconds");
    const capabilities = yield* Fiber.join(probe);
    assert.equal(capabilities?.email, "dev@example.com");
    assert.equal(capabilities?.subscriptionType, "pro");
    assert.equal(capabilities?.tokenSource, "oauth");
    assert.deepEqual(capabilities?.slashCommands, [
      { name: "review", description: "Review changes", input: { hint: "[path]" } },
    ]);
    assert.equal(capabilities?.usage, undefined);
    // Claude Code ends the request itself once its input closes.
    assert.equal(abortSignal?.aborted, false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("answers before its Claude process exits, and lets that process exit on its own", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-exit-" });
    const inputEnded = yield* Deferred.make<void>();
    const exited = yield* Deferred.make<void>();
    let finishRenewal!: () => void;
    const renewal = new Promise<void>((resolve) => {
      finishRenewal = resolve;
    });
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
      abortSignal = input.options?.abortController?.signal;
      return fakeProbeQuery(
        input,
        {
          initializationResult: async () => ({
            account: { email: "dev@example.com", tokenSource: "oauth" },
            commands: [],
          }),
        },
        {
          onInputEnded: () => Deferred.doneUnsafe(inputEnded, Effect.void),
          exit: renewal,
          onExit: () => Deferred.doneUnsafe(exited, Effect.void),
        },
      );
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const capabilities = yield* probeClaudeCapabilities(decodeClaudeSettings({ homePath }));
    assert.equal(capabilities?.email, "dev@example.com");
    yield* Deferred.await(inputEnded);
    // Well past the old 4 s cut and the SDK's 2 s and 7 s kill timers, a login renewal is
    // still finishing, and nothing stops it.
    yield* TestClock.adjust("30 seconds");
    assert.equal(abortSignal?.aborted, false);
    assert.equal(yield* Deferred.isDone(exited), false);
    finishRenewal();
    yield* Deferred.await(exited);
    assert.equal(abortSignal?.aborted, false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("stops a Claude process still running a minute after its input ended", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-stuck-" });
    const inputEnded = yield* Deferred.make<void>();
    const aborted = yield* Deferred.make<void>();
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
      const isFirst = query.mock.calls.length === 1;
      if (isFirst) {
        abortSignal = input.options?.abortController?.signal;
        abortSignal?.addEventListener("abort", () => Deferred.doneUnsafe(aborted, Effect.void));
      }
      return fakeProbeQuery(
        input,
        {
          initializationResult: async () => ({
            account: { email: "dev@example.com", tokenSource: "oauth" },
            commands: [],
          }),
        },
        isFirst
          ? {
              onInputEnded: () => Deferred.doneUnsafe(inputEnded, Effect.void),
              exit: new Promise(() => {}),
            }
          : {},
      );
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const settings = decodeClaudeSettings({ homePath });
    const capabilities = yield* probeClaudeCapabilities(settings);
    assert.equal(capabilities?.email, "dev@example.com");
    yield* Deferred.await(inputEnded);
    yield* TestClock.adjust("59 seconds");
    assert.equal(abortSignal?.aborted, false);
    yield* TestClock.adjust("1 second");
    yield* Deferred.await(aborted);
    // Once the stopped process has gone, the folder takes probes again.
    const next = yield* probeClaudeCapabilities(settings);
    assert.equal(next?.email, "dev@example.com");
    assert.equal(query.mock.calls.length, 2);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("an interrupted probe still ends its process gracefully and frees the folder", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const homePath = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-probe-interrupt-" });
    const otherHomePath = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-claude-probe-interrupt-",
    });
    const started = yield* Deferred.make<void>();
    const inputEnded = yield* Deferred.make<void>();
    let finishFirst!: () => void;
    const firstExit = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let abortSignal: AbortSignal | undefined;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) => {
      if (query.mock.calls.length !== 1) return fakeProbeQuery(input, {});
      abortSignal = input.options?.abortController?.signal;
      Deferred.doneUnsafe(started, Effect.void);
      return fakeProbeQuery(
        input,
        // Still initializing when the caller gives up.
        { initializationResult: () => new Promise(() => {}) },
        { onInputEnded: () => Deferred.doneUnsafe(inputEnded, Effect.void), exit: firstExit },
      );
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const probe = (folder: string) =>
      probeClaudeCapabilities(decodeClaudeSettings({ homePath: folder })).pipe(Effect.forkChild);
    const first = yield* probe(homePath);
    yield* Deferred.await(started);
    // The interrupt returns without waiting for the process to exit.
    yield* Fiber.interrupt(first);
    yield* Deferred.await(inputEnded);
    assert.equal(abortSignal?.aborted, false);
    const second = yield* probe(homePath);
    yield* Fiber.join(yield* probe(otherHomePath));
    assert.equal(query.mock.calls.length, 2);
    finishFirst();
    yield* Fiber.join(second);
    assert.equal(query.mock.calls.length, 3);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("asks for usage without the local transcript scan", () =>
  Effect.gen(function* () {
    let usageOptions: unknown;
    const query = vi.spyOn(ClaudeSdk, "query").mockImplementation((input) =>
      fakeProbeQuery(input, {
        initializationResult: async () => ({
          account: { email: "dev@example.com", subscriptionType: "max", tokenSource: "oauth" },
          commands: [],
        }),
        usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: async (options) => {
          usageOptions = options;
          return { rate_limits_available: true, rate_limits: null };
        },
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    yield* probeClaudeCapabilities(decodeClaudeSettings({ binaryPath: "claude" }));
    assert.deepEqual(usageOptions, { skipBehaviors: true });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
