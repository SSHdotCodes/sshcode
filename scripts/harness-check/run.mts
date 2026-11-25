// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone maintainer CLI.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import {
  CommandId,
  MessageId,
  ORCHESTRATION_V2_WS_METHODS as RPC,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  type ServerProviderModel,
} from "../../packages/contracts/src/index.ts";
import { createModelPickerCatalog } from "../../packages/client-runtime/src/modelPickerCatalog.ts";
import { isReasoningSelectDescriptor } from "../../packages/shared/src/model.ts";
import { CheckFailure, until } from "./processes.mts";
import { openServer, type CheckServer } from "./server.mts";

const harnesses = [
  { id: "claudeAgent", name: "Claude Code", cli: "claude", models: [/^claude-haiku-\d+-\d+$/] },
  {
    id: "codex",
    name: "Codex",
    cli: "codex",
    models: [/^gpt-6(?:\.\d+)?-luna$/, /^gpt-5\.6-luna$/, /^gpt-5\.4-mini$/],
  },
  { id: "grok", name: "Grok", cli: "grok", models: [/^grok-build$/] },
  {
    id: "antigravity",
    name: "Antigravity",
    cli: "agy",
    models: [/^gemini-\d+\.\d+-flash(?:-low)?$/, /^gemini-4-argon$/],
  },
  {
    id: "acpRegistry_devin",
    name: "Devin",
    cli: "devin",
    models: [
      /^(?:gpt-[\d.]+-mini|gpt-[\d.]+-luna|claude-haiku-[\d.-]+|gemini-[\d.]+-flash)(?:-none|-low)?$/,
      /^gpt-[\d.]+-none$/,
    ],
  },
  {
    id: "opencode",
    name: "OpenCode",
    cli: "opencode",
    models: [
      /^opencode\/inkling-[\d.-]+-small-free$/,
      /^opencode\/(?:step-[\w.-]+|minimax-[\w.-]+)-free$/,
    ],
  },
  {
    id: "pi",
    name: "Pi",
    cli: "pi",
    models: [
      /^openai-codex\/gpt-(?:6(?:\.\d+)?-luna|5\.6-luna|5\.4-mini)$/,
      /^anthropic\/claude-haiku-[\d.-]+$/,
      /^opencode\/inkling-[\d.-]+-small-free$/,
    ],
  },
  { id: "muse", name: "Muse", cli: "muse", models: [/^muse-ember(?:-[\d.]+)?$/] },
] as const;
type Harness = (typeof harnesses)[number];
const scenarios = ["start", "steer", "stop", "resume", "effort", "picker", "usage"] as const;
type Scenario = (typeof scenarios)[number];
type Result = { status: "PASS" | "FAIL" | "SKIP"; reason: string };
type Row = {
  harness: Harness["name"];
  model: string | null;
  scenarios: Record<Scenario, Result>;
};

const signalController = new AbortController();
const signal = signalController.signal;
let interrupted = false;
const onSignal = () => {
  interrupted = true;
  signalController.abort();
};

async function rpc<A, E>(operation: Effect.Effect<A, E>, timeout = 8000): Promise<A> {
  return Effect.runPromise(Effect.timeout(operation, timeout), { signal });
}

function failureReason(error: unknown): string {
  if (error instanceof CheckFailure) return error.message;
  // Never print provider stderr, arbitrary RPC defects, account data, or auth URLs.
  const classification = error instanceof Error ? `${error.name} ${error.message}` : String(error);
  if (/TimeoutError|timed out/i.test(classification)) return "Client RPC did not answer in time";
  if (/Authentication|authentication_failed|unauthenticated|sign.in/i.test(classification)) {
    return "Provider authentication required";
  }
  if (/EnvironmentAuthorizationError/i.test(classification)) return "Server rejected RPC scope";
  const rpcError =
    /\b(ProjectMutationError|OrchestrationV2DispatchCommandError|OrchestrationV2ThreadLaunchError|Socket(Open|Read|Close)Error|RpcClientDefect|SchemaError|TypeError|ReferenceError)\b/.exec(
      classification,
    );
  if (rpcError) return `RPC failed (${rpcError[0]})`;
  return "Server RPC or local check failed";
}

function mark(row: Row, scenario: Scenario, status: Result["status"], reason: string) {
  row.scenarios[scenario] = { status, reason };
}

async function check(row: Row, scenario: Scenario, run: () => Promise<string>): Promise<boolean> {
  signal.throwIfAborted();
  try {
    mark(row, scenario, "PASS", await run());
    return true;
  } catch (error) {
    signal.throwIfAborted();
    mark(row, scenario, "FAIL", failureReason(error));
    return false;
  }
}

async function executable(cli: string): Promise<string | undefined> {
  for (const directory of (process.env.PATH ?? "").split(NodePath.delimiter).filter(Boolean)) {
    const path = NodePath.resolve(directory, cli);
    if (
      await NodeFSP.access(path, NodeFS.constants.X_OK).then(
        () => true,
        () => false,
      )
    )
      return path;
  }
}

function chooseModel(harness: Harness, provider: ServerProvider): ServerProviderModel | undefined {
  const safeModels = provider.models.filter(
    (model) =>
      !model.unavailableReason &&
      !/qwen|token.plan|contributor/i.test(
        [model.slug, model.name, model.subProvider, model.family].join(" "),
      ),
  );
  for (const pattern of harness.models) {
    const candidates = safeModels.filter((model) => pattern.test(model.slug));
    const ordered = candidates.sort(
      (a, b) =>
        Number(a.isLegacy ?? false) - Number(b.isLegacy ?? false) ||
        b.slug.localeCompare(a.slug, "en", { numeric: true }),
    );
    if (ordered[0]) return ordered[0];
  }
}

function effortFor(model: ServerProviderModel) {
  const order = ["off", "none", "minimal", "low", "medium", "standard"];
  for (const descriptor of model.capabilities?.optionDescriptors ?? []) {
    if (!isReasoningSelectDescriptor(descriptor)) continue;
    const defaultValue =
      descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
    const value = order.find(
      (candidate) =>
        candidate !== defaultValue && descriptor.options.some((option) => option.id === candidate),
    );
    if (value) return { id: descriptor.id, value };
  }
}

function projectRun(projection: OrchestrationV2ThreadProjection, messageId: MessageId) {
  return projection.runs.find((run) => run.userMessageId === messageId);
}

function pending(run: OrchestrationV2Run): boolean {
  return ["preparing", "queued", "starting", "running", "waiting"].includes(run.status);
}

function runFailure(projection: OrchestrationV2ThreadProjection, run: OrchestrationV2Run): string {
  const error = projection.turnItems.findLast(
    (item) => item.type === "error" && item.runId === run.id,
  );
  return error?.type === "error"
    ? `Run ${run.status} (${error.failure.class})`
    : `Run ${run.status}`;
}

function conversation(server: CheckServer, projectId: ProjectId, selection: ModelSelection) {
  const threadId = ThreadId.make(NodeCrypto.randomUUID());
  const projection = () => rpc(server.client[RPC.getThreadProjection]({ threadId }));
  return {
    threadId,
    projection,
    async launch(text: string) {
      const messageId = MessageId.make(NodeCrypto.randomUUID());
      await rpc(
        server.client[RPC.launchThread]({
          commandId: CommandId.make(NodeCrypto.randomUUID()),
          creationSource: "web",
          threadId,
          projectId,
          title: "Harness live check",
          generateTitle: false,
          modelSelection: selection,
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "root" },
          initialMessage: { messageId, text, attachments: [] },
        }),
      );
      return messageId;
    },
    send: (text: string, steer = false) => send(server, threadId, text, steer),
    waitForReply: (messageId: MessageId, reply: string) =>
      waitForReply(server, threadId, messageId, reply),
  };
}

async function send(server: CheckServer, threadId: ThreadId, text: string, steer = false) {
  const messageId = MessageId.make(NodeCrypto.randomUUID());
  await rpc(
    server.client[RPC.dispatchCommand]({
      type: "message.dispatch",
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      createdBy: "user",
      creationSource: "web",
      threadId,
      messageId,
      text,
      attachments: [],
      deliveryIntent: steer ? "steer" : "auto",
      dispatchMode: { type: "start_immediately" },
    }),
  );
  return messageId;
}

async function stop(server: CheckServer, threadId: ThreadId, run: OrchestrationV2Run) {
  await rpc(
    server.client[RPC.dispatchCommand]({
      type: "run.interrupt",
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId,
      runId: run.id,
      holdQueue: true,
    }),
  );
}

async function waitForReply(
  server: CheckServer,
  threadId: ThreadId,
  messageId: MessageId,
  reply: string,
) {
  let lastStatus = "not projected";
  try {
    return await until(
      async () => {
        const projection = await rpc(server.client[RPC.getThreadProjection]({ threadId }));
        const run = projectRun(projection, messageId);
        if (!run) return;
        lastStatus = run.status;
        if (pending(run)) return;
        if (run.status !== "completed") {
          if (run.automaticProviderRetry?.status === "scheduled") await stop(server, threadId, run);
          throw new CheckFailure(runFailure(projection, run));
        }
        if (!hasReply(projection, run, reply))
          throw new CheckFailure("Run completed without the requested reply");
        return { run, projection };
      },
      40_000,
      "Timed out awaiting reply",
      signal,
    );
  } catch (error) {
    if (error instanceof CheckFailure && error.message === "Timed out awaiting reply") {
      throw new CheckFailure(`No reply within 40s (run ${lastStatus})`);
    }
    throw error;
  }
}

function hasReply(
  projection: OrchestrationV2ThreadProjection,
  run: OrchestrationV2Run,
  token: string,
) {
  return projection.messages.some(
    (message) =>
      message.role === "assistant" &&
      message.runId === run.id &&
      !message.streaming &&
      message.text.includes(token),
  );
}

function shellPrompt(marker: string, seconds: number, reply: string) {
  return `Run this exact foreground shell command now, no other tools. When done, reply only ${reply}.\n/bin/sh -c 'printf "%s\\n" "$$" > "${marker}"; exec /bin/sleep ${seconds}'`;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function runningShell(
  server: CheckServer,
  projection: () => Promise<OrchestrationV2ThreadProjection>,
  messageId: MessageId,
  marker: string,
) {
  return until(
    async () => {
      const state = await projection();
      const run = projectRun(state, messageId);
      if (!run) return;
      if (!pending(run))
        throw new CheckFailure(`${runFailure(state, run)} before shell was observed`);
      const pid = Number(await NodeFSP.readFile(marker, "utf8").catch(() => ""));
      if (pid > 1 && Number.isSafeInteger(pid) && (await server.owns(pid)) && isAlive(pid))
        return { pid, run };
    },
    30_000,
    "No live shell PID observed in the test server tree",
    signal,
  );
}

interface ResumeCheck {
  row: Row;
  threadId: ThreadId;
  remembered: string;
  effort: ReturnType<typeof effortFor>;
}

async function exercise(input: {
  row: Row;
  server: CheckServer;
  workspace: string;
  projectId: ProjectId;
  provider: ServerProvider;
  model: ServerProviderModel;
}): Promise<ResumeCheck | undefined> {
  const { row, server, workspace, projectId, provider, model } = input;
  const effort = effortFor(model);
  const selection: ModelSelection = {
    instanceId: provider.instanceId,
    model: model.slug,
    options: [
      ...(effort ? [effort] : []),
      ...(row.harness === "Muse" ? [{ id: "contributorMode", value: false }] : []),
    ],
  };
  const chat = conversation(server, projectId, selection);
  const remembered = NodeCrypto.randomBytes(5).toString("hex");
  const started = await check(row, "start", async () => {
    const id = await chat.launch(`Remember this code for later: ${remembered}. Reply only ACK.`);
    await chat.waitForReply(id, "ACK");
    return "Turn completed and replied";
  });
  if (!started) return;

  await check(row, "steer", async () => {
    const reply = `steer-${NodeCrypto.randomBytes(4).toString("hex")}`;
    const marker = NodePath.join(workspace, `steer-${NodeCrypto.randomUUID()}.pid`);
    const id = await chat.send(shellPrompt(marker, 12, "FIRST"));
    const { run } = await runningShell(server, chat.projection, id, marker);
    const steeringId = await chat.send(
      `Change the current reply. Use no tools. Reply only ${reply}.`,
      true,
    );
    await until(
      async () => {
        const projection = await chat.projection();
        const original = projection.runs.find((candidate) => candidate.id === run.id);
        const separate = projectRun(projection, steeringId);
        const message = projection.messages.find((candidate) => candidate.id === steeringId);
        if (separate?.status === "queued" && separate.steerWhenLiveRunId !== run.id) {
          throw new CheckFailure("Steering was queued as a separate run");
        }
        if (message?.runId === run.id && hasReply(projection, run, reply)) {
          if (pending(original ?? run)) return;
          if (original?.status === "completed") return true;
        }
        if (original && !pending(original)) {
          throw new CheckFailure(
            `${runFailure(projection, original)} without a steered reply in the same run`,
          );
        }
      },
      40_000,
      "Active turn did not answer the steer",
      signal,
    );
    return "Follow-up answered in the active run";
  });

  await check(row, "stop", async () => {
    const stopChat = conversation(server, projectId, selection);
    const marker = NodePath.join(workspace, `stop-${NodeCrypto.randomUUID()}.pid`);
    const id = await stopChat.launch(shellPrompt(marker, 120, "DONE"));
    const { pid, run } = await runningShell(server, stopChat.projection, id, marker);
    await stop(server, stopChat.threadId, run);
    await until(
      async () => {
        const state = await stopChat.projection();
        const stopped = projectRun(state, id);
        if (stopped && !pending(stopped) && !isAlive(pid)) {
          if (stopped.status !== "interrupted" && stopped.status !== "cancelled") {
            throw new CheckFailure(`Shell exited but ${runFailure(state, stopped)}`);
          }
          return true;
        }
      },
      7000,
      "Stop did not settle the run and remove its shell PID within 7s",
      signal,
    );
    return "Run interrupted and shell PID exited";
  });

  return { row, threadId: chat.threadId, remembered, effort };
}

async function resume(server: CheckServer, { row, threadId, remembered, effort }: ResumeCheck) {
  let resumedMessage: MessageId | undefined;
  await check(row, "resume", async () => {
    // Send immediately on the restarted connection, with only the thread id and the prompt.
    resumedMessage = await send(
      server,
      threadId,
      "What code did I ask you to remember? Reply only with the code.",
    );
    await waitForReply(server, threadId, resumedMessage, remembered);
    return "First message after restart answered with the original code";
  });
  await check(row, "effort", async () => {
    if (!effort) throw new CheckFailure("Model has no selectable low-cost non-default effort");
    const projection = await rpc(server.client[RPC.getThreadProjection]({ threadId }));
    if (
      !projection.thread.modelSelection.options?.some(
        (option) => option.id === effort.id && option.value === effort.value,
      )
    ) {
      throw new CheckFailure("Thread effort selection was lost on restart");
    }
    const resumedRun = resumedMessage && projectRun(projection, resumedMessage);
    if (!resumedRun)
      throw new CheckFailure("Thread effort persisted; no resumed run was projected");
    if (
      !resumedRun.modelSelection.options?.some(
        (option) => option.id === effort.id && option.value === effort.value,
      )
    ) {
      throw new CheckFailure("Resumed run did not inherit the stored effort");
    }
    return `Thread and resumed run retained ${effort.id}=${effort.value}`;
  });
}

async function main() {
  const output = NodePath.resolve(process.argv[2] ?? "/private/tmp/harness-check-results.json");
  const root = NodePath.resolve(import.meta.dirname, "../..");
  const rows: Row[] = harnesses.map(({ name }) => ({
    harness: name,
    model: null,
    scenarios: Object.fromEntries(
      scenarios.map((scenario) => [
        scenario,
        { status: "SKIP", reason: "Prerequisite did not pass" } satisfies Result,
      ]),
    ) as Row["scenarios"],
  }));
  const base = await NodeFSP.mkdtemp("/private/tmp/sshcode-harness-check-");
  const workspace = NodePath.join(base, "workspace");
  let server: CheckServer | undefined;
  let error: string | undefined;
  let stage = "setup";
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await NodeFSP.mkdir(NodePath.join(base, "userdata"));
    await NodeFSP.mkdir(workspace);
    const providerInstances = Object.fromEntries(
      await Promise.all(
        harnesses.map(async (harness) => {
          const binaryPath = await executable(harness.cli);
          if (!binaryPath)
            return [
              harness.id,
              {
                driver: harness.id === "acpRegistry_devin" ? "acpRegistry" : harness.id,
                enabled: false,
              },
            ];
          return [
            harness.id,
            harness.id === "acpRegistry_devin"
              ? {
                  driver: "acpRegistry",
                  enabled: true,
                  config: { agentId: "devin", commandPath: binaryPath, enabled: true },
                }
              : { driver: harness.id, enabled: true, config: { binaryPath, enabled: true } },
          ];
        }),
      ),
    );
    const settings = {
      enableProviderUpdateChecks: false,
      enableAgentBrowserAccess: false,
      enableAgentDeviceAccess: false,
      providerInstances,
    };
    await NodeFSP.writeFile(
      NodePath.join(base, "userdata", "settings.json"),
      JSON.stringify(settings),
      { mode: 0o600 },
    );
    const serverOptions = { root, base, workspace, signal };
    stage = "server connection";
    server = await openServer(serverOptions);
    stage = "project creation";
    const firstServer = server;
    const projectId = ProjectId.make(NodeCrypto.randomUUID());
    await rpc(
      server.client[WS_METHODS.projectsMutate]({
        type: "project.create",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        projectId,
        title: "Harness live check",
        workspaceRoot: workspace,
      }),
    );
    // Discovery can finish independently. Each probe uses the same status API as Settings.
    stage = "provider discovery";
    const discovery = await Promise.all(
      harnesses.map(async (harness) => {
        if (!providerInstances[harness.id]?.enabled) return false;
        try {
          await rpc(
            firstServer.client[WS_METHODS.serverRefreshProviders]({
              instanceId: ProviderInstanceId.make(harness.id),
            }),
            50_000,
          );
          return true;
        } catch {
          return false;
        }
      }),
    );
    stage = "server config";
    const config = await rpc(server.client[WS_METHODS.serverGetConfig]({}), 30_000);
    const picker = createModelPickerCatalog(
      config.providers.flatMap((provider) =>
        provider.enabled && provider.installed && provider.availability !== "unavailable"
          ? provider.models.map((model) => ({
              ...model,
              instanceId: provider.instanceId,
              driver: provider.driver,
              instanceName: provider.displayName ?? provider.driver,
            }))
          : [],
      ),
      { providers: config.providers, providerInstances: config.settings?.providerInstances },
    );
    stage = "live scenarios";
    const checks: ResumeCheck[] = [];
    for (const [index, harness] of harnesses.entries()) {
      const row = rows[index]!;
      const provider = config.providers.find((candidate) => candidate.instanceId === harness.id);
      let ineligible = "";
      if (!providerInstances[harness.id]?.enabled) ineligible = "CLI missing from PATH";
      else if (!provider?.installed) ineligible = "Server did not find the installed CLI";
      else if (provider.auth.status === "unauthenticated") ineligible = "CLI is not signed in";
      if (ineligible || !provider) {
        for (const scenario of scenarios)
          mark(row, scenario, "SKIP", ineligible || "Provider absent from server catalog");
        if (providerInstances[harness.id]?.enabled && !provider?.installed) {
          mark(row, "picker", "FAIL", ineligible || "Provider absent from server catalog");
        }
        continue;
      }
      const model = chooseModel(harness, provider);
      if (model) row.model = model.slug;
      await check(row, "picker", async () => {
        if (!model) throw new CheckFailure("Server catalog has no allowlisted low-cost model");
        if (
          !picker.sources.some(
            (route) => route.instanceId === provider.instanceId && route.slug === model.slug,
          )
        ) {
          throw new CheckFailure("Model route is hidden in the default picker");
        }
        return "Model route visible in the default picker";
      });
      await check(row, "usage", async () => {
        const limits = provider.usageLimits;
        if (limits?.windows.length) return `${limits.windows.length} quota window(s)`;
        throw new CheckFailure(
          limits?.unavailable
            ? `Usage limit snapshot: ${limits.unavailable.reason}`
            : discovery[index]
              ? "No usage limit windows returned"
              : "Provider refresh did not complete",
        );
      });
      if (!model) continue;
      const resumed = await exercise({ row, server, workspace, projectId, provider, model });
      if (resumed) checks.push(resumed);
    }
    if (checks.length > 0) {
      stage = "test server restart";
      await server.close();
      server = undefined;
      server = await openServer({ ...serverOptions, port: firstServer.port });
      const restarted = server;
      await Promise.all(checks.map((entry) => resume(restarted, entry)));
    }
  } catch (cause) {
    error = interrupted ? "Interrupted by signal" : `${stage} · ${failureReason(cause)}`;
  } finally {
    try {
      await server?.close();
    } catch (cause) {
      error = failureReason(cause);
    }
    await NodeFSP.rm(base, { recursive: true, force: true });
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    console.table(
      rows.map(({ harness, model, scenarios: results }) => ({
        harness,
        model: model ?? "—",
        ...Object.fromEntries(scenarios.map((scenario) => [scenario, results[scenario].status])),
      })),
    );
    for (const row of rows) {
      const reasons = new Map<string, Scenario[]>();
      for (const scenario of scenarios) {
        const { status, reason } = row.scenarios[scenario];
        if (status === "PASS") continue;
        const label = `${status} · ${reason}`;
        const names = reasons.get(label) ?? [];
        names.push(scenario);
        reasons.set(label, names);
      }
      for (const [reason, names] of reasons) {
        console.log(`${row.harness} · ${names.join(", ")} · ${reason}`);
      }
    }
    await NodeFSP.writeFile(
      output,
      JSON.stringify({ error: error ?? null, rows }, null, 2) + "\n",
      { mode: 0o600 },
    );
    if (error) console.error(error);
    console.log(`JSON report ${output}`);
    process.exitCode = interrupted
      ? 130
      : error ||
          rows.some((row) =>
            scenarios.some((scenario) => row.scenarios[scenario].status === "FAIL"),
          )
        ? 1
        : 0;
  }
}

await main();
