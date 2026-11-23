// @effect-diagnostics nodeBuiltinImport:off -- native fixtures verify download directory and symlink identities.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { sweepCrashDownloads } from "./BrowserDownloadCleanup.ts";

it("removes crash-leftover downloads while preserving unrelated files and screenshots", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-downloads-"));
  try {
    const downloads = NodePath.join(root, "downloads");
    const stale = NodePath.join(downloads, "a".repeat(64));
    const unrelated = NodePath.join(downloads, "keep");
    const screenshots = NodePath.join(root, "screenshots");
    await NodeFSP.mkdir(stale, { recursive: true });
    await NodeFSP.mkdir(unrelated);
    await NodeFSP.mkdir(screenshots);
    await NodeFSP.writeFile(NodePath.join(stale, "download"), "stale");
    await NodeFSP.writeFile(NodePath.join(unrelated, "file"), "keep");
    await NodeFSP.writeFile(NodePath.join(screenshots, "screen.png"), "screenshot");
    await NodeFSP.writeFile(NodePath.join(downloads, "b".repeat(64)), "not a directory");

    await sweepCrashDownloads(downloads);

    expect(await NodeFSP.readdir(downloads)).toEqual(["b".repeat(64), "keep"]);
    expect(await NodeFSP.readFile(NodePath.join(unrelated, "file"), "utf8")).toBe("keep");
    expect(await NodeFSP.readFile(NodePath.join(screenshots, "screen.png"), "utf8")).toBe(
      "screenshot",
    );
    await sweepCrashDownloads(NodePath.join(root, "missing"));
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});

it("does not traverse symbolic links at the download root or at a tab directory", async () => {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-browser-downloads-"));
  try {
    const external = NodePath.join(root, "external");
    const downloads = NodePath.join(root, "downloads");
    await NodeFSP.mkdir(external);
    await NodeFSP.mkdir(downloads);
    await NodeFSP.writeFile(NodePath.join(external, "file"), "keep");
    await NodeFSP.symlink(external, NodePath.join(downloads, "c".repeat(64)), "junction");
    await NodeFSP.symlink(downloads, NodePath.join(root, "linked-downloads"), "junction");

    await sweepCrashDownloads(downloads);
    await sweepCrashDownloads(NodePath.join(root, "linked-downloads"));

    expect(await NodeFSP.readFile(NodePath.join(external, "file"), "utf8")).toBe("keep");
    expect((await NodeFSP.lstat(NodePath.join(downloads, "c".repeat(64)))).isSymbolicLink()).toBe(
      true,
    );
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
});
