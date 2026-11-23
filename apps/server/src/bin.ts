/**
 * Thin CLI entry.
 *
 * Every ACP agent spawns `sshcode acp-mcp-bridge` while opening its session, and
 * terminal-fallback agents run `sshcode acp-mcp-call` per tool call, so their
 * startup sits on first-message latency. Both dispatch here before the full
 * CLI module graph (seconds of evaluation) loads; everything else defers to
 * the real CLI in ./binCli.ts.
 */
import { isEntrypoint } from "./entrypoint.ts";
import { enableCliCompileCache } from "./cliCompileCache.ts";
import { guardSocketTypeOfService } from "@t3tools/shared/socketTypeOfServiceGuard";

if (
  isEntrypoint({
    moduleUrl: import.meta.url,
    entryPath: process.argv[1],
    runtimeMain: import.meta.main,
  })
) {
  // Before the first request: a refused socket marking must never exit the process.
  guardSocketTypeOfService();
  const command = process.argv[2];
  if (command === "acp-mcp-bridge" || command === "acp-mcp-call") {
    const { runAcpMcpCliFastPath } = await import("./mcp/AcpMcpStdioBridge.ts");
    await runAcpMcpCliFastPath(command, process.argv.slice(3));
  } else {
    enableCliCompileCache();
    const { runCli } = await import("./binCli.ts");
    runCli();
  }
}
