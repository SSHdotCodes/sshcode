// @effect-diagnostics nodeBuiltinImport:off - standalone maintainer CLI; no server runtime.
// @effect-diagnostics globalDate:off - report timestamp belongs to the CLI boundary.
// @effect-diagnostics globalTimers:off - bounds an external test subprocess, not Effect work.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { compareMetrics, metricChanges, record, volume } from "../lib/agentQuality.ts";

const root = NodeURL.fileURLToPath(new URL("../../", import.meta.url));
const platform = Effect.runSync(HostProcess.Platform);
const baselinePath = NodePath.join(root, "scripts/agent-quality/baseline.json");

/** Run only fixture/budget tests, in their owning package, with private scratch artifacts. */
async function measure(directory: string) {
  const binary = NodePath.join(root, "node_modules/vite-plus/bin/vp");
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      binary,
      "test",
      "run",
      "src/provider/AgentContextBudget.test.ts",
      "src/orchestration-v2/testkit/OrchestratorReplayFixtures.integration.test.ts",
      "src/mcp/OrchestratorMcpService.test.ts",
      "--testNamePattern=^(?!.*grok_auto_blocked_command)",
      "--reporter=json",
      `--outputFile=${NodePath.join(directory, "tests.json")}`,
    ],
    {
      cwd: NodePath.join(root, "apps/server"),
      env: { ...process.env, T3_AGENT_QUALITY_DIR: directory },
      stdio: ["ignore", "ignore", "ignore"],
      detached: platform !== "win32",
    },
  );
  const stop = (signal: NodeJS.Signals = "SIGTERM") => {
    if (child.pid === undefined) return;
    try {
      if (platform === "win32")
        NodeChildProcess.spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
        });
      else process.kill(-child.pid, signal);
    } catch {
      /* Already exited. */
    }
  };
  // A child that ignores SIGTERM gets SIGKILL, so the wait below always ends.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stopNow = () => {
    stop("SIGTERM");
    killTimer ??= setTimeout(() => stop("SIGKILL"), 10_000);
  };
  const interrupt = () => {
    stopNow();
    process.exitCode = 130;
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  // A wedged fixture cannot leave test workers behind in a release job.
  const timeout = setTimeout(stopNow, 15 * 60_000);
  try {
    return await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(killTimer);
    // Workers the run left in its process group: ask, then make sure. The signal handlers
    // stay until the group is gone, so an interrupt here can't skip the SIGKILL.
    stop("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    stop("SIGKILL");
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}

const parseJson = async (path: string): Promise<unknown> =>
  JSON.parse(await NodeFSP.readFile(path, "utf8"));

async function main() {
  const args = process.argv.slice(2);
  const update = args.includes("--update-baseline");
  const outputIndex = args.indexOf("--output-dir");
  if (
    args.some(
      (arg, index) =>
        arg !== "--update-baseline" &&
        arg !== "--output-dir" &&
        !(outputIndex >= 0 && index === outputIndex + 1),
    )
  )
    throw new Error(
      "Usage: node scripts/agent-quality/report.ts [--update-baseline] [--output-dir PATH]",
    );
  if (outputIndex >= 0 && (!args[outputIndex + 1] || args[outputIndex + 1]!.startsWith("--")))
    throw new Error("--output-dir requires a path");
  const output = NodePath.resolve(
    outputIndex >= 0 ? args[outputIndex + 1]! : NodePath.join(root, ".generated/agent-quality"),
  );
  const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "sshcode-agent-quality-"));
  process.stdout.write("measuring current provider output and replay behavior...\n");
  try {
    const status = await measure(scratch);
    const files = (await NodeFSP.readdir(scratch)).toSorted();
    const context = record(
      await parseJson(NodePath.join(scratch, "context-budget.json")).catch(() => ({})),
    );
    const replays: Record<string, unknown> = {};
    for (const file of files.filter((file) => file.startsWith("replay-"))) {
      const result = record(await parseJson(NodePath.join(scratch, file)));
      const { scenario, provider: _provider, protocol: _protocol, ...metrics } = result;
      if (typeof scenario !== "string") throw new Error("Invalid replay measurement");
      replays[scenario] = metrics;
    }
    const testReport = record(
      await parseJson(NodePath.join(scratch, "tests.json")).catch(() => ({})),
    );
    const mcpResults = Object.fromEntries(
      await Promise.all(
        files
          .filter((file) => file.startsWith("mcp-result-"))
          .map(async (file) => [file.slice(11, -5), await parseJson(NodePath.join(scratch, file))]),
      ),
    );
    const missingMcpResults = [
      "task-status-running",
      "task-status-completed",
      "thread-recovered-true",
      "thread-recovered-false",
    ].filter((name) => !Object.hasOwn(mcpResults, name));
    const appMessages = Object.fromEntries(
      await Promise.all(
        files
          .filter((file) => file.startsWith("app-message-"))
          .map(async (file) => [file.slice(12, -5), await parseJson(NodePath.join(scratch, file))]),
      ),
    );
    const missingAppMessages = ["held-updates", "idle-wake"].filter(
      (name) => !Object.hasOwn(appMessages, name),
    );
    const expected: unknown = await parseJson(
      NodePath.join(scratch, "expected-scenarios.json"),
    ).catch(() => []);
    const missingScenarios = Array.isArray(expected)
      ? expected.filter((key: unknown) => typeof key !== "string" || !Object.hasOwn(replays, key))
      : ["manifest"];
    const tools = Object.fromEntries(
      ((context.tools ?? []) as Array<Record<string, unknown>>).map(({ name, ...metrics }) => [
        String(name),
        metrics,
      ]),
    );
    const failures =
      Number(testReport.numFailedTests ?? 0) +
      Number(testReport.numRuntimeErrorTestSuites ?? 0) +
      (status === 0 ? 0 : 1) +
      missingScenarios.length +
      missingMcpResults.length +
      missingAppMessages.length +
      (context.measured ? 0 : 1) +
      (Array.isArray(expected) && expected.length > 0 ? 0 : 1);
    const metrics = {
      failures,
      contextBudget: context.measured,
      schemaAudit: context.schemaAudit,
      mcpResults,
      appMessages,
      tools,
      replays,
    };
    const baseline = await parseJson(baselinePath).catch((error: unknown) => {
      if (update && record(error).code === "ENOENT") return { metrics: {} };
      throw error;
    });
    const regressions = compareMetrics(record(baseline).metrics, metrics);
    const changes = metricChanges(record(baseline).metrics, metrics);
    const revision = NodeChildProcess.spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    });
    const commit = /^[a-f0-9]{40}$/.test(revision.stdout?.trim() ?? "")
      ? revision.stdout.trim()
      : "unavailable";
    const report = {
      format: 1,
      commit,
      version: record(await parseJson(NodePath.join(root, "apps/server/package.json"))).version,
      generatedAt: new Date().toISOString(),
      methodology:
        "Actual adapter content at replay boundaries; UTF-8 bytes, estimated tokens = ceil(bytes/4). Tool discovery measured separately from live MCP registration. Provider-native tool results are separate from SSHCode sends. Repetition is a candidate, not proof of redundancy. No model quality score is inferred from byte savings.",
      excluded: ["grok_auto_blocked_command (known hanging replay)"],
      tests: {
        passed: testReport.numPassedTests,
        failed: testReport.numFailedTests,
        skipped: testReport.numPendingTests,
      },
      metrics,
      regressions,
      changes,
    };
    const budgetRows = Object.entries(record(context.measured)).map(
      ([name, bytes]) => `| ${name} | ${bytes} | ${volume(Number(bytes)).estimatedTokens} |`,
    );
    const replayRows = Object.entries(replays).map(([scenario, value]) => {
      const item = record(value);
      return `| ${scenario} | ${record(item.total).bytes} | ${record(item.total).estimatedTokens} | ${item.turns} | ${item.toolCalls} | ${record(item.repeated).bytes} |`;
    });
    const largest = Object.entries(tools)
      .toSorted(
        ([, a], [, b]) =>
          Number(b.inputSchemaBytes) +
          Number(b.outputSchemaBytes) -
          Number(a.inputSchemaBytes) -
          Number(a.outputSchemaBytes),
      )
      .slice(0, 5);
    const markdown = [
      "# Agent quality report",
      "",
      `Build ${report.version}. ${failures === 0 && regressions.length === 0 ? "PASS" : "FAIL"}. ${Object.keys(replays).length} replay scenarios.`,
      "",
      report.methodology,
      "",
      "Bytes are measured at app/provider boundaries, not provider billing. Replay fixtures use fake providers and do not assess semantic task quality.",
      "",
      "## Context budget",
      "",
      "| Metric | Bytes | Estimated tokens |",
      "| --- | ---: | ---: |",
      ...budgetRows,
      "",
      "## Largest tool schemas",
      "",
      "| Tool | Description bytes | Input schema bytes | Output schema bytes |",
      "| --- | ---: | ---: | ---: |",
      ...largest.map(
        ([name, tool]) =>
          `| ${name} | ${tool.descriptionBytes} | ${tool.inputSchemaBytes} | ${tool.outputSchemaBytes} |`,
      ),
      "",
      `Schema annotation bytes: ${record(context.schemaAudit).descriptionBytes}; exact repeated annotation bytes: ${record(context.schemaAudit).repeatedDescriptionBytes}; exact repeated output-schema bytes: ${record(context.schemaAudit).repeatedOutputSchemaBytes}. These are review candidates, not proven redundant model context.`,
      "",
      "Tool inventory is measured once, not charged to every replay: recordings do not exercise MCP discovery. All registered agent tools stay visible.",
      "",
      "## Replay content",
      "",
      "| Scenario/provider | Bytes | Estimated tokens | Turns | Tool calls | Repeated bytes |",
      "| --- | ---: | ---: | ---: | ---: | ---: |",
      ...replayRows,
      "",
      "## Current MCP result probes",
      "",
      "These existing service tests exercise current task_status and t3_thread_read behavior. Bytes are the JSON service payload once, before MCP transport envelopes; replay-native result estimates use final projected output and may omit provider internals.",
      "",
      "| Probe | JSON payload bytes | Estimated tokens |",
      "| --- | ---: | ---: |",
      ...Object.entries(mcpResults).map(
        ([name, value]) =>
          `| ${name} | ${record(value).bytes} | ${record(value).estimatedTokens} |`,
      ),
      "",
      "## Current app notification delivery probes",
      "",
      "Actual text dispatched by the current held-update batching and idle-parent wake service paths, before provider formatting. Provider-buffered wakes in replays need no new app text; stored summaries are measured separately. Message classification uses whole payloads, not marker substrings in user instructions.",
      "",
      "| Probe | Text bytes | Estimated tokens |",
      "| --- | ---: | ---: |",
      ...Object.entries(appMessages).map(
        ([name, value]) =>
          `| ${name} | ${record(value).bytes} | ${record(value).estimatedTokens} |`,
      ),
      "",
      "## Gate",
      "",
      `Threshold: 3% per byte/token metric; any increase in failures, calls, turns or repeat counts. Missing baseline coverage fails. Explicitly excluded: ${report.excluded.join(", ")}.`,
      "",
      ...(regressions.length
        ? regressions.map((change) => `- ${change.path}: ${change.before} -> ${change.after}`)
        : ["No regressions."]),
      "",
      "## Changes from baseline",
      "",
      `Measured ${changes.filter((change) => change.delta < 0).length} metric decreases and ${changes.filter((change) => change.delta > 0).length} increases. Token estimates overlap byte deltas.`,
      "",
      "| Metric (largest 20 absolute changes) | Baseline | Current | Delta | Change |",
      "| --- | ---: | ---: | ---: | ---: |",
      ...changes
        .filter((change) => !change.path.endsWith("estimatedTokens"))
        .toSorted((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
        .slice(0, 20)
        .map(
          (change) =>
            `| ${change.path} | ${change.before} | ${change.after} | ${change.delta} | ${change.percent === null ? "new from zero" : `${change.percent.toFixed(2)}%`} |`,
        ),
      "",
      "Wording changes and deferred proposals: see scripts/agent-quality/trims.md in the source checkout.",
      "",
    ].join("\n");
    await NodeFSP.mkdir(output, { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(output, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    await NodeFSP.writeFile(NodePath.join(output, "report.md"), markdown);
    if (failures > 0 || Object.keys(replays).length === 0) {
      process.stdout.write(`failed measurement: ${failures} failures; baseline unchanged\n`);
      process.exitCode = 1;
    } else if (update) {
      await NodeFSP.writeFile(baselinePath, `${JSON.stringify({ format: 1, metrics }, null, 2)}\n`);
      process.stdout.write("baseline updated deliberately\n");
    } else if (regressions.length > 0) process.exitCode = 1;
    process.stdout.write(
      `${output}/report.md\n${output}/report.json\n${regressions.length} regressions\n`,
    );
  } finally {
    await NodeFSP.rm(scratch, { recursive: true, force: true });
  }
}

main().catch(() => {
  // Vitest diagnostics can contain entire payloads. Keep the release log free of bodies.
  process.stderr.write(
    "agent quality measurement failed; check dependencies, budget equality, and fixture tests\n",
  );
  process.exitCode = 1;
});
