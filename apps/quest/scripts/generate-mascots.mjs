#!/usr/bin/env node
import { HARNESS_MASCOT_ANIMATIONS } from "../../../packages/shared/src/harnessMascotAnimations.ts";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const output = NodePath.join(root, "apps/quest/app/build/generated/mascots/assets");
await NodeFSP.rm(output, { recursive: true, force: true });
await NodeFSP.mkdir(NodePath.join(output, "mascots"), { recursive: true });
const files = new Set();
for (const animations of Object.values(HARNESS_MASCOT_ANIMATIONS)) {
  for (const variants of Object.values(animations)) {
    for (const variant of variants) {
      if (variant.durations.length > variant.columns * variant.rows)
        throw new Error(`Invalid sprite grid: ${variant.file}`);
      files.add(variant.file);
    }
  }
}
await Promise.all(
  [...files].map((file) =>
    NodeFSP.copyFile(
      NodePath.join(root, "apps/web/public/mascots", file),
      NodePath.join(output, "mascots", file),
    ),
  ),
);
await NodeFSP.writeFile(
  NodePath.join(output, "mascots/manifest.json"),
  JSON.stringify(HARNESS_MASCOT_ANIMATIONS),
);
console.log(
  `Generated Quest mascot manifest and ${files.size} sprite sheets from shared animations.`,
);
