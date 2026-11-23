// A conservative mobile-local source reachability proxy, not Hermes device timing.
// Run from the worktree root: bun apps/mobile/scripts/audit-startup-imports.ts
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";

const root = NodePath.resolve(import.meta.dirname, "..");
const stack = NodePath.join(root, "src/Stack.tsx");
const baseline = NodeChildProcess.execFileSync(
  "git",
  ["show", "5e8bc89871:apps/mobile/src/Stack.tsx"],
  { cwd: root, encoding: "utf8" },
);
const extensions = [".ios.ts", ".ios.tsx", ".native.ts", ".native.tsx", ".ts", ".tsx"];
function resolve(from: string, specifier: string) {
  if (!specifier.startsWith(".")) return null;
  const base = NodePath.resolve(NodePath.dirname(from), specifier).replace(/\.(ts|tsx)$/, "");
  return (
    extensions
      .flatMap((extension) => [base + extension, NodePath.join(base, `index${extension}`)])
      .find((file) => file.startsWith(root + NodePath.sep) && NodeFS.existsSync(file)) ?? null
  );
}
function reachable(stackSource: string) {
  const seen = new Set<string>();
  const pending = [NodePath.join(root, "index.ts")];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = file === stack ? stackSource : NodeFS.readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /(?:^|\n)\s*(?:import|export)\s+(?!type\b)([^;]+?)\s+from\s+["']([^"']+)["']/g,
    )) {
      const target = resolve(file, match[2]!);
      if (target) pending.push(target);
    }
  }
  return seen;
}
const before = reachable(baseline);
const after = reachable(NodeFS.readFileSync(stack, "utf8"));
const deferred = [...before].filter((file) => !after.has(file));
console.log(
  JSON.stringify(
    {
      baselineMobileLocalModules: before.size,
      currentMobileLocalModules: after.size,
      deferredMobileLocalModules: deferred.length,
      deferredSourceBytes: deferred.reduce((sum, file) => sum + NodeFS.statSync(file).size, 0),
      modules: deferred.map((file) => NodePath.relative(root, file)).sort(),
    },
    null,
    2,
  ),
);
