// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  VIEWED_IMAGE_COPY_MAX_BYTES,
  keepViewedImageCopy,
  linkedImagePaths,
  pruneViewedImageCopies,
  viewedImageCopiesDir,
  viewedImageCopyPath,
} from "./viewedImageCopies.ts";

describe("viewedImageCopies", () => {
  let stateDir: string;
  let workDir: string;

  beforeEach(() => {
    stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-viewed-state-"));
    workDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-viewed-work-"));
  });

  afterEach(() => {
    NodeFS.rmSync(stateDir, { recursive: true, force: true });
    NodeFS.rmSync(workDir, { recursive: true, force: true });
  });

  const keep = (filePath: string, now = 1_000, threadId = "thread-1") =>
    keepViewedImageCopy({ stateDir, threadId, filePath, now });

  it("keeps a picture under its own name, readable after the original is deleted", async () => {
    const filePath = NodePath.join(workDir, "frame.png");
    NodeFS.writeFileSync(filePath, "first frame");

    expect(await keep(filePath)).toBe(true);
    NodeFS.rmSync(filePath);

    const copy = viewedImageCopyPath(stateDir, "thread-1", filePath);
    expect(copy).not.toBeNull();
    expect(NodePath.basename(copy!)).toBe("frame.png");
    expect(copy!.startsWith(viewedImageCopiesDir(stateDir) + NodePath.sep)).toBe(true);
    expect(NodeFS.readFileSync(copy!, "utf8")).toBe("first frame");
    // Another chat that never showed the file has no copy of it.
    expect(NodeFS.existsSync(viewedImageCopyPath(stateDir, "thread-2", filePath)!)).toBe(false);
  });

  it("replaces the copy when the same path is shown again with new contents", async () => {
    const filePath = NodePath.join(workDir, "frame.png");
    NodeFS.writeFileSync(filePath, "first frame");
    await keep(filePath);
    NodeFS.writeFileSync(filePath, "second frame");
    await keep(filePath, 2_000);

    const copy = viewedImageCopyPath(stateDir, "thread-1", filePath)!;
    expect(NodeFS.readFileSync(copy, "utf8")).toBe("second frame");
    expect(NodeFS.readdirSync(NodePath.dirname(copy))).toEqual(["frame.png"]);
  });

  it("copies nothing for a missing file, another kind of file, a folder or a huge image", async () => {
    expect(await keep(NodePath.join(workDir, "gone.png"))).toBe(false);

    const notes = NodePath.join(workDir, "notes.txt");
    NodeFS.writeFileSync(notes, "text");
    expect(await keep(notes)).toBe(false);
    expect(viewedImageCopyPath(stateDir, "thread-1", notes)).toBeNull();
    expect(viewedImageCopyPath(stateDir, "thread-1", "relative/frame.png")).toBeNull();

    const folder = NodePath.join(workDir, "folder.png");
    NodeFS.mkdirSync(folder);
    expect(await keep(folder)).toBe(false);

    const huge = NodePath.join(workDir, "huge.png");
    NodeFS.writeFileSync(huge, "");
    NodeFS.truncateSync(huge, VIEWED_IMAGE_COPY_MAX_BYTES + 1);
    expect(await keep(huge)).toBe(false);

    expect(NodeFS.existsSync(viewedImageCopiesDir(stateDir))).toBe(false);
  });

  it("deletes the oldest copies first once they pass the size limit", async () => {
    const paths = ["a.png", "b.png", "c.png"].map((name) => NodePath.join(workDir, name));
    for (const [index, filePath] of paths.entries()) {
      NodeFS.writeFileSync(filePath, "x".repeat(100));
      await keep(filePath, (index + 1) * 10_000);
    }

    await pruneViewedImageCopies(stateDir, 250);

    const copies = paths.map((filePath) => viewedImageCopyPath(stateDir, "thread-1", filePath)!);
    expect(copies.map((copy) => NodeFS.existsSync(copy))).toEqual([false, true, true]);
    // The deleted copy's folder goes with it.
    expect(NodeFS.existsSync(NodePath.dirname(copies[0]!))).toBe(false);
  });

  it("finds the absolute image paths a reply links", () => {
    const text = [
      "Here it is: ![chart](/tmp/chart.png) and [the photo](/tmp/photo.jpg#crop).",
      "![spaced](</tmp/my shot.png>) ![encoded](/tmp/my%20other.png)",
      '![home](~/Pictures/a.webp "title") ![url](file:///tmp/from-url.gif)',
      "![web](https://example.com/a.png) ![relative](docs/a.png) [log](/tmp/run.log)",
      "![again](/tmp/chart.png)",
    ].join("\n");

    expect(linkedImagePaths(text, "/Users/someone")).toEqual([
      "/tmp/chart.png",
      "/tmp/photo.jpg",
      "/tmp/my shot.png",
      "/tmp/my other.png",
      "/Users/someone/Pictures/a.webp",
      "/tmp/from-url.gif",
    ]);
  });
});
