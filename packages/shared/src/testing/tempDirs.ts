// @effect-diagnostics nodeBuiltinImport:off - synchronous test fixtures, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach } from "vite-plus/test";

/**
 * Temp directories for one test file. Call once at the top of the file; each
 * directory the returned function makes is removed after the test that made it.
 */
export function useTempDirs(): (prefix: string) => string {
  const made: Array<string> = [];
  afterEach(() => {
    for (const dir of made.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  });
  return (prefix) => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
    made.push(dir);
    return dir;
  };
}
