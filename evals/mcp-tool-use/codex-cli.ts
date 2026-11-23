// @effect-diagnostics nodeBuiltinImport:off -- dev-only harness boundary; never imported by the app.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { buildCodexAdditionalContext } from "../../apps/server/src/provider/CodexDeveloperInstructions.ts";
import type { McpToolUseCase, SampleRun } from "./run.ts";

type Definition = { name: string; description: string; inputSchema: unknown };
type Call = SampleRun["calls"][number];

/** No user config, plugins, external MCP servers, or session rollouts in an eval run. */
export const codexArgs = (input: {
  model: string;
  effort: string;
  fixture: string;
  url: string;
  instructions: string;
  tools?: ReadonlyArray<string>;
  runtimeDirectory?: string;
}) => [
  "--no-daemon",
  "exec",
  "--ephemeral",
  "--ignore-user-config",
  "--ignore-rules",
  "--skip-git-repo-check",
  "--json",
  "--color",
  "never",
  "-m",
  input.model,
  "-C",
  input.fixture,
  "-c",
  `model_reasoning_effort=${JSON.stringify(input.effort)}`,
  "-c",
  'default_permissions="eval"',
  "-c",
  'permissions.eval.filesystem={":minimal"="read",":workspace_roots"="read"}',
  "-c",
  "permissions.eval.network.enabled=false",
  "-c",
  'approval_policy="never"',
  "-c",
  "project_doc_max_bytes=0",
  "-c",
  'history.persistence="none"',
  ...(input.runtimeDirectory
    ? [
        "-c",
        `log_dir=${JSON.stringify(NodePath.join(input.runtimeDirectory, "log"))}`,
        "-c",
        `sqlite_home=${JSON.stringify(input.runtimeDirectory)}`,
      ]
    : []),
  "-c",
  "features.apps=false",
  "-c",
  "features.plugins=false",
  "-c",
  `mcp_servers={t3-code={url=${JSON.stringify(input.url)},required=true}}`,
  ...(input.tools ?? []).flatMap((name) => [
    "-c",
    `mcp_servers.t3-code.tools.${name}.approval_mode="approve"`,
  ]),
  "-c",
  `developer_instructions=${JSON.stringify(input.instructions)}`,
  "-",
];

/** Translate synthetic absolute paths into the fixture, and normalize recorded calls back. */
export const fixturePaths = (fixture: string) => {
  const pairs = [
    ["/home/user/app", fixture],
    ["/tmp", NodePath.join(fixture, "world/tmp")],
    ["/Users/dev", NodePath.join(fixture, "world/Users/dev")],
  ] as const;
  const translator = (entries: ReadonlyArray<readonly [string, string]>) => {
    const table = new Map(entries);
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp(
      [...table.keys()]
        .toSorted((a, b) => b.length - a.length)
        .map(escape)
        .join("|"),
      "g",
    );
    const translate = (value: unknown): unknown => {
      if (typeof value === "string") return value.replace(pattern, (match) => table.get(match)!);
      if (Array.isArray(value)) return value.map(translate);
      if (typeof value === "object" && value !== null)
        return Object.fromEntries(
          Object.entries(value).map(([key, item]) => [String(translate(key)), translate(item)]),
        );
      return value;
    };
    return translate;
  };
  return { intoFixture: translator(pairs), fromFixture: translator(pairs.map(([a, b]) => [b, a])) };
};

const sessions = async () => {
  const dir = NodePath.join(NodeOS.homedir(), ".codex", "sessions");
  return new Set(await NodeFSP.readdir(dir, { recursive: true }).catch(() => []));
};

/** Binds only loopback; port zero still must avoid the live app's reserved tunnel ranges. */
export const listenMock = async (
  definitions: ReadonlyArray<Definition>,
  answer: (name: string, input: unknown) => Promise<unknown>,
) => {
  const listed: Array<unknown> = [];
  const server = NodeHttp.createServer(async (request, response) => {
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    try {
      const rpc = JSON.parse(body) as {
        id?: string | number;
        method: string;
        params?: { name?: string; arguments?: unknown; protocolVersion?: string };
      };
      if (rpc.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result: unknown;
      if (rpc.method === "initialize")
        result = {
          protocolVersion: rpc.params?.protocolVersion ?? "2025-03-26",
          serverInfo: { name: "SSHCode eval mock", version: "1" },
          capabilities: { tools: {} },
        };
      else if (rpc.method === "tools/list") {
        result = { tools: definitions };
        listed.push(result);
      } else if (rpc.method === "tools/call") {
        const name = rpc.params?.name ?? "";
        if (!definitions.some((tool) => tool.name === name)) throw new Error("Unknown mock tool");
        const value = await answer(name, rpc.params?.arguments ?? {});
        result = { content: [{ type: "text", text: JSON.stringify(value) }] };
      } else result = {};
      response
        .writeHead(200, { "Content-Type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
    } catch {
      response
        .writeHead(400, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: "Invalid eval request" }));
    }
  });
  for (;;) {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No mock TCP address");
    if (
      (address.port >= 18000 && address.port <= 18999) ||
      (address.port >= 38000 && address.port <= 38999)
    ) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      continue;
    }
    return {
      url: `http://127.0.0.1:${address.port}/mcp`,
      listed,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }
};

/** Runs the installed harness with branch-owned context and a synthetic filesystem. */
export const runCliSample = async (
  testCase: McpToolUseCase,
  options: {
    model: string;
    effort: string;
    fixtureRoot: string;
    definitions: ReadonlyArray<Definition>;
    answer: (name: string, input: unknown) => Promise<unknown>;
  },
) => {
  const fixture = await NodeFSP.mkdtemp(NodePath.join(options.fixtureRoot, `${testCase.id}-`));
  const runtimeDirectory = await NodeFSP.mkdtemp(
    NodePath.join(options.fixtureRoot, "codex-runtime-"),
  );
  const paths = fixturePaths(fixture);
  const calls: Array<Call> = [];
  const mock = await listenMock(options.definitions, async (name, input) => {
    calls.push({ step: calls.length, tool: name, input });
    return paths.intoFixture(await options.answer(name, paths.fromFixture(input)));
  });
  try {
    const world = paths.intoFixture(testCase.setup.world ?? {}) as Record<string, unknown>;
    const files = world.files;
    if (files && typeof files === "object" && !Array.isArray(files)) {
      for (const [name, content] of Object.entries(files)) {
        const target = NodePath.resolve(fixture, name);
        if (!target.startsWith(fixture + NodePath.sep))
          throw new Error("Fixture path escapes its root");
        await NodeFSP.mkdir(NodePath.dirname(target), { recursive: true });
        await NodeFSP.writeFile(
          target,
          typeof content === "string" ? content : JSON.stringify(content),
          { mode: typeof content === "string" && content.startsWith("#!") ? 0o555 : 0o444 },
        );
      }
    }
    const git = (args: ReadonlyArray<string>) =>
      NodeChildProcess.execFileSync(
        "git",
        [
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "user.name=Eval",
          "-c",
          "user.email=eval@example.invalid",
          ...args,
        ],
        {
          cwd: fixture,
          env: {
            PATH: process.env.PATH,
            TMPDIR: process.env.TMPDIR,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_TERMINAL_PROMPT: "0",
          },
          stdio: "ignore",
        },
      );
    git([
      "init",
      "--quiet",
      "--initial-branch",
      typeof world.branch === "string" ? world.branch : "main",
    ]);
    git(["add", "."]);
    git(["commit", "--quiet", "--allow-empty", "-m", "Seed synthetic evaluation world"]);
    const context = Object.values(
      buildCodexAdditionalContext(
        { model: options.model, reasoningEffort: options.effort },
        { browser: options.definitions.some((tool) => tool.name === "preview_open"), device: true },
      ),
    )
      .map((entry) => entry.value)
      .join("\n\n");
    const args = codexArgs({
      ...options,
      fixture,
      url: mock.url,
      instructions: context,
      runtimeDirectory,
      tools: options.definitions.map((tool) => tool.name),
    });
    const before = await sessions();
    const transcript: Array<unknown> = [];
    let stderr = "";
    const child = NodeChildProcess.spawn("codex", args, {
      cwd: fixture,
      stdio: ["pipe", "pipe", "pipe"],
      env: Object.fromEntries(
        Object.entries(process.env).filter(
          ([name]) =>
            !/(?:TOKEN|API_KEY|SECRET|PASSWORD|AUTH)/i.test(name) && !/^T3(?:CODE)?_/.test(name),
        ),
      ),
    });
    const prompt = [
      testCase.setup.role === "native-subagent"
        ? "You are a native subagent; your final reply goes to the parent, not the user."
        : undefined,
      paths.intoFixture(testCase.setup.context),
      `Synthetic fixture world: ${JSON.stringify(world)}`,

      ...(testCase.setup.priorTurns ?? []).map(
        (turn) => `Prior ${turn.role} turn: ${JSON.stringify(paths.intoFixture(turn))}`,
      ),
      paths.intoFixture(
        testCase.setup.role === "delegated-child" ? testCase.prompt : testCase.prompt,
      ),
    ]
      .filter(Boolean)
      .join("\n\n");
    child.stdin.end(prompt);
    const nativeCalls = new Set<string>();
    let buffer = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line) as {
            type?: string;
            item?: {
              id: string;
              type: string;
              command?: string;
              tool?: string;
              prompt?: string;
              action?: unknown;
              changes?: unknown;
            };
          };
          transcript.push(event);
          const item = event.item;
          if (
            (event.type === "item.started" || event.type === "item.completed") &&
            item &&
            !nativeCalls.has(item.id)
          ) {
            const native =
              item.type === "command_execution"
                ? { tool: "Bash", input: { command: item.command } }
                : /collab/i.test(item.type) &&
                    (item.tool === "spawn_agent" || item.tool === "spawnAgent")
                  ? { tool: "Agent", input: { ...item, prompt: item.prompt } }
                  : item.type === "web_search"
                    ? { tool: "WebSearch", input: item }
                    : item.type === "file_change"
                      ? { tool: "Edit", input: { patch: JSON.stringify(item.changes) } }
                      : undefined;
            if (native) {
              nativeCalls.add(item.id);
              calls.push({ step: calls.length, ...native });
            }
          }
        } catch {
          transcript.push(line);
        }
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const after = await sessions();
    const sessionFilesAdded = [...after].filter((name) => !before.has(name));
    const text: Array<string> = [];
    const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    for (const event of transcript) {
      if (typeof event !== "object" || event === null) continue;
      const row = event as Record<string, unknown>;
      if (row.type === "turn.completed" && row.usage && typeof row.usage === "object") {
        const u = row.usage as Record<string, number>;
        usage.input += (u.input_tokens ?? 0) - (u.cached_input_tokens ?? 0);
        usage.output += u.output_tokens ?? 0;
        usage.cacheRead += u.cached_input_tokens ?? 0;
      }
      if (row.type !== "item.completed" || !row.item || typeof row.item !== "object") continue;
      const item = row.item as Record<string, unknown>;
      if (item.type === "agent_message" && typeof item.text === "string") text.push(item.text);
    }
    return {
      calls: calls.map((call) => ({ ...call, input: paths.fromFixture(call.input) })),
      text: text.join("\n\n"),
      stopReason: code === 0 ? "end_turn" : "cli_error",
      usage,
      shellUsage: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
      transcript,
      stderr,
      sessionFilesAdded,
      toolLists: mock.listed,
      command: ["codex", ...args],
      prompt,
    };
  } finally {
    await mock.close();
    await NodeFSP.rm(runtimeDirectory, { recursive: true, force: true });
  }
};
