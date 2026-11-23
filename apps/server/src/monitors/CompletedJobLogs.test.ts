// @effect-diagnostics nodeBuiltinImport:off globalDate:off -- native filesystem fixtures verify retention timestamps and byte offsets.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { markJobLogDelivered, sweepCompletedJobLogs } from "./CompletedJobLogs.ts";

const temporaryJobs = async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "completed-job-logs-"));
  let index = 0;
  const job = async (text = "complete log", receipt = "0\n") => {
    const directory = NodePath.join(
      root,
      `monitor-00000000-0000-0000-0000-${String(++index).padStart(12, "0")}`,
    );
    await NodeFSP.mkdir(directory);
    const logPath = NodePath.join(directory, "output.log");
    await NodeFSP.writeFile(logPath, text);
    if (receipt) await NodeFSP.writeFile(NodePath.join(directory, "exit"), receipt);
    return { directory, logPath };
  };
  return { root, job };
};

it("expires delivered job directories by age and keeps pending or recoverable logs intact", async () => {
  const { root, job } = await temporaryJobs();
  try {
    const delivered = await job();
    const recoverable = await job();
    const live = await job("live bytes", "");
    const undelivered = await job();
    const invalid = await job("unknown", "not an exit code");
    const now = Date.now();
    await markJobLogDelivered(delivered.logPath, now - 8 * 86_400_000);
    await markJobLogDelivered(recoverable.logPath, now - 8 * 86_400_000);
    const before = await NodeFSP.readFile(recoverable.logPath);
    const protectedDirectories = new Set([
      recoverable.directory,
      live.directory,
      undelivered.directory,
    ]);

    const result = await sweepCompletedJobLogs({
      root,
      now,
      isProtected: (directory) => protectedDirectories.has(directory),
    });

    expect(result.removed).toBe(1);
    await expect(NodeFSP.stat(delivered.directory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await NodeFSP.readFile(recoverable.logPath)).toEqual(before);
    expect(await NodeFSP.readFile(live.logPath, "utf8")).toBe("live bytes");
    expect(await NodeFSP.readFile(undelivered.logPath, "utf8")).toBe("complete log");
    expect(await NodeFSP.readFile(invalid.logPath, "utf8")).toBe("unknown");
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("enforces a byte budget oldest first without truncating logs or changing offsets", async () => {
  const { root, job } = await temporaryJobs();
  try {
    const old = await job("old".repeat(60));
    const recent = await job("recent".repeat(30));
    const now = Date.now();
    await markJobLogDelivered(old.logPath, now - 2_000);
    await markJobLogDelivered(recent.logPath, now - 1_000);
    const before = await NodeFSP.readFile(recent.logPath);
    const result = await sweepCompletedJobLogs({
      root,
      now,
      maxBytes: 300,
      isProtected: () => false,
    });
    expect(result.removed).toBe(1);
    expect(await NodeFSP.readFile(recent.logPath)).toEqual(before);
    await expect(NodeFSP.stat(old.directory)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("reclaims legacy delivered logs only with an exit receipt and leaves links and unknown contents", async () => {
  const { root, job } = await temporaryJobs();
  try {
    const legacy = await job();
    const unknown = await job();
    const external = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "job-external-"));
    try {
      await NodeFSP.writeFile(NodePath.join(unknown.directory, "keep.txt"), "unknown file");
      await NodeFSP.utimes(NodePath.join(legacy.directory, "exit"), 0, 0);
      await NodeFSP.symlink(
        external,
        NodePath.join(root, "monitor-11111111-1111-1111-1111-111111111111"),
        "junction",
      );
      await NodeFSP.writeFile(NodePath.join(external, "keep.txt"), "external file");
      expect(
        (
          await sweepCompletedJobLogs({
            root,
            now: Date.now(),
            maxBytes: 1,
            isProtected: () => false,
          })
        ).removed,
      ).toBe(0);
      const result = await sweepCompletedJobLogs({
        root,
        now: Date.now(),
        maxBytes: 1,
        includeLegacy: true,
        isProtected: () => false,
      });
      expect(result.removed).toBe(1);
      expect(await NodeFSP.readFile(NodePath.join(unknown.directory, "keep.txt"), "utf8")).toBe(
        "unknown file",
      );
      expect(await NodeFSP.readFile(NodePath.join(external, "keep.txt"), "utf8")).toBe(
        "external file",
      );
    } finally {
      await NodeFSP.rm(external, { recursive: true, force: true });
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
