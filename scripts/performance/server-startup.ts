// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Fresh Node processes measure module evaluation outside the server runtime.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

// Measure fresh-process server module evaluation, without starting services or opening ports.
const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sshcode-perf-startup-"));
const target = NodeURL.pathToFileURL(
  NodePath.resolve(import.meta.dirname, "../../apps/server/src/server.ts"),
).href;
try {
  const samples = Array.from({ length: 5 }, () => {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `const start = performance.now(); await import(${JSON.stringify(target)}); console.log(performance.now() - start);`,
      ],
      {
        encoding: "utf8",
        timeout: 60_000,
        env: { ...process.env, HOME: directory },
      },
    );
    if (result.status !== 0)
      throw new Error(result.stderr || result.error?.message || "Server import failed");
    return Number(result.stdout.trim().split("\n").at(-1));
  }).sort((a, b) => a - b);
  console.log(
    JSON.stringify(
      { name: "server:module-evaluation", samplesMs: samples, medianMs: samples[2] },
      null,
      2,
    ),
  );
} finally {
  NodeFS.rmSync(directory, { recursive: true, force: true });
}
