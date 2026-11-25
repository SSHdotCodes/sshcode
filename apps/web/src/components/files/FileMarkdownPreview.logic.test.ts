import { resolvePathLinkTarget } from "@t3tools/shared/fileLinks";
import { describe, expect, it } from "vite-plus/test";
import { resolveFileMarkdownBaseDir } from "./FileMarkdownPreview.logic";

describe("relative images in Markdown file previews", () => {
  it.each([
    ["2026-11-23T14:05/README.md", "/workspace/2026-11-23T14:05/diagram.png"],
    ["/README.md", "/diagram.png"],
    ["README.md", "/workspace/diagram.png"],
  ])("resolves an image beside %s", (documentPath, imagePath) => {
    const baseDir = resolveFileMarkdownBaseDir(documentPath, "/workspace");
    expect(resolvePathLinkTarget("diagram.png", baseDir)).toBe(imagePath);
  });
});
