// @effect-diagnostics nodeBuiltinImport:off - Verifies real POSIX process lifetime.
import * as NodeChildProcess from "node:child_process";
import * as NodeReadlinePromises from "node:readline/promises";
import { expect, it } from "vite-plus/test";
import { ProcessTree, until } from "./processes.mts";

it("cleans a detached descendant after the test server exits", async () => {
  const child = NodeChildProcess.spawn(
    process.execPath,
    [
      "-e",
      `
      const { spawn } = require("node:child_process");
      const child = spawn("/bin/sleep", ["120"], { detached: true, stdio: "ignore" });
      process.stdout.write(String(child.pid) + "\\n");
      setInterval(() => {}, 1000);
    `,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  if (child.pid === undefined) throw new Error("Could not spawn fixture");
  const tree = new ProcessTree(child.pid);
  const lines = NodeReadlinePromises.createInterface({ input: child.stdout });
  try {
    const first = await lines[Symbol.asyncIterator]().next();
    const grandchild = Number(first.value);
    if (!grandchild) throw new Error("Fixture did not report its child");
    await until(async () => (await tree.owns(grandchild)) || undefined, 5000, "PID not observed");
    await tree.stop(child);
    expect(() => process.kill(grandchild, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    expect(await tree.capture()).toHaveProperty("size", 0);
  } finally {
    lines.close();
    await tree.stop(child);
  }
}, 30_000);
