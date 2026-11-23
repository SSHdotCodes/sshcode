// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone Node benchmark.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Validate the copied client tree the desktop artifact builder packages, including lazy chunks.
const directory = NodePath.resolve(process.argv[2] ?? "apps/server/dist/client");
const manifest = JSON.parse(
  NodeFS.readFileSync(NodePath.join(directory, ".vite/manifest.json"), "utf8"),
) as Record<
  string,
  {
    file: string;
    imports?: string[];
    dynamicImports?: string[];
    css?: string[];
    assets?: string[];
  }
>;
const files = new Set<string>();
for (const [key, entry] of Object.entries(manifest)) {
  for (const dependency of [...(entry.imports ?? []), ...(entry.dynamicImports ?? [])]) {
    if (!manifest[dependency]) throw new Error(`Missing manifest entry ${dependency} from ${key}`);
  }
  for (const file of [entry.file, ...(entry.css ?? []), ...(entry.assets ?? [])]) files.add(file);
}
const missing = [...files].filter((file) => !NodeFS.existsSync(NodePath.join(directory, file)));
if (missing.length > 0) throw new Error(`Missing client chunks/assets: ${missing.join(", ")}`);
console.log(
  JSON.stringify({
    directory,
    manifestEntries: Object.keys(manifest).length,
    files: files.size,
    missing: missing.length,
  }),
);
