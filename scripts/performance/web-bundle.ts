// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone Node benchmark.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeZlib from "node:zlib";

// Run after `bun run build` in apps/web. Include the bootstrap's dynamic main entry.
const directory = NodePath.resolve(import.meta.dirname, "../../apps/web/dist");
const manifest = JSON.parse(
  NodeFS.readFileSync(NodePath.join(directory, ".vite/manifest.json"), "utf8"),
) as Record<string, { file: string; imports?: string[]; dynamicImports?: string[] }>;
const visited = new Set<string>();
function visit(key: string) {
  if (visited.has(key)) return;
  visited.add(key);
  for (const dependency of manifest[key]!.imports ?? []) visit(dependency);
}
visit("index.html");
visit("src/main.tsx");
const chunks = [...visited]
  .map((key) => {
    const file = manifest[key]!.file;
    const content = NodeFS.readFileSync(NodePath.join(directory, file));
    return { file, bytes: content.length, gzipBytes: NodeZlib.gzipSync(content).length };
  })
  .sort((a, b) => b.bytes - a.bytes);
console.log(
  JSON.stringify(
    {
      chunks: chunks.length,
      bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0),
      gzipBytes: chunks.reduce((sum, chunk) => sum + chunk.gzipBytes, 0),
      largest: chunks.slice(0, 12),
    },
    null,
    2,
  ),
);
