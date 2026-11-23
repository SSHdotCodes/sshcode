import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// The phone runs on Hermes, which has no ES2023 copying array methods: a call
// throws "undefined is not a function" and blanks the screen (New chat, 2026-11-07).
const MISSING_ON_HERMES = /\.(toSorted|toReversed|toSpliced)\s*\(/u;
const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
const phoneSourceRoots = [
  "apps/mobile/src",
  "packages/client-runtime/src",
  "packages/shared/src",
  "packages/contracts/src",
];

function sourceFiles(directory: string): string[] {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/u.test(entry.name) && !/\.test\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

describe("Hermes compatibility", () => {
  it("phone code never calls array methods Hermes lacks", () => {
    const offenders = phoneSourceRoots
      .flatMap((root) => sourceFiles(NodePath.join(repoRoot, root)))
      .flatMap((file) =>
        NodeFS.readFileSync(file, "utf8")
          .split("\n")
          .flatMap((line, index) =>
            MISSING_ON_HERMES.test(line) && !/^\s*(\/\/|\*)/u.test(line)
              ? [`${NodePath.relative(repoRoot, file)}:${index + 1}`]
              : [],
          ),
      );
    expect(offenders).toEqual([]);
  });

  // Hermes returns `matchAll` results without `groups` (checked in the running
  // app, 2026-11-10: `match` and `exec` keep them). Named groups read from a
  // `matchAll` result are undefined there, so the shared model-link parser found
  // nothing on the phone. Read `matchAll` captures by number.
  it("phone code never reads named groups from matchAll", () => {
    const offenders = phoneSourceRoots
      .flatMap((root) => sourceFiles(NodePath.join(repoRoot, root)))
      .filter((file) => {
        const source = NodeFS.readFileSync(file, "utf8");
        return /\.matchAll\s*\(/u.test(source) && /\bmatch\w*\??\.groups\b/iu.test(source);
      })
      .map((file) => NodePath.relative(repoRoot, file));
    expect(offenders).toEqual([]);
  });
});
