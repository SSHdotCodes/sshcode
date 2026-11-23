// @effect-diagnostics nodeBuiltinImport:off - Standalone Node benchmark.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Compare the exact same workload against a git revision without switching branches.
const revision = process.argv[2];
if (!revision)
  throw new Error("Usage: node scripts/performance/compare-desktop.ts <baseline-revision>");
const root = NodePath.resolve(import.meta.dirname, "../..");
const baselineFiles = [
  "apps/web/src/session-logic.perf-baseline.ts",
  "apps/web/src/components/chat/MessagesTimeline.logic.perf-baseline.ts",
  "packages/client-runtime/src/state/sessionBoxes.perf-baseline.ts",
  "apps/web/src/desktopPerformance.baseline.bench.ts",
];
for (const file of baselineFiles) {
  if (NodeFS.existsSync(NodePath.join(root, file)))
    throw new Error(`Refusing to overwrite ${file}`);
}
function source(file: string) {
  return NodeChildProcess.execFileSync("git", ["show", `${revision}:${file}`], {
    cwd: root,
    encoding: "utf8",
  });
}
function write(file: string, contents: string) {
  NodeFS.writeFileSync(NodePath.join(root, file), contents, { flag: "wx" });
}
try {
  write(baselineFiles[0]!, source("apps/web/src/session-logic.ts"));
  write(
    baselineFiles[1]!,
    source("apps/web/src/components/chat/MessagesTimeline.logic.ts").replaceAll(
      '"../../session-logic"',
      '"../../session-logic.perf-baseline"',
    ),
  );
  write(baselineFiles[2]!, source("packages/client-runtime/src/state/sessionBoxes.ts"));
  write(
    baselineFiles[3]!,
    NodeFS.readFileSync(NodePath.join(root, "apps/web/src/desktopPerformance.bench.ts"), "utf8")
      .replaceAll('"./session-logic"', '"./session-logic.perf-baseline"')
      .replaceAll(
        '"./components/chat/MessagesTimeline.logic"',
        '"./components/chat/MessagesTimeline.logic.perf-baseline"',
      )
      .replaceAll(
        '"@t3tools/client-runtime/state/session-boxes"',
        '"../../../packages/client-runtime/src/state/sessionBoxes.perf-baseline.ts"',
      ),
  );
  const result = NodeChildProcess.spawnSync(
    NodePath.join(root, "node_modules/.bin/vp"),
    [
      "test",
      "bench",
      baselineFiles[3]!,
      "apps/web/src/desktopPerformance.bench.ts",
      "--run",
      "--reporter",
      "verbose",
      "--no-file-parallelism",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  for (const file of baselineFiles) NodeFS.rmSync(NodePath.join(root, file), { force: true });
}
