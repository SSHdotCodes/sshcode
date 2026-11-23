import { describe, expect, it } from "vite-plus/test";

import { pickedScratchFolder } from "./scratchFolder";

describe("pickedScratchFolder", () => {
  const root = "/Users/me/.t3/scratch";

  it("hides the managed folder a thread gets under the scratch root", () => {
    expect(pickedScratchFolder(`${root}/2026-10-15-fix-login-abcd1234`, root)).toBeNull();
    expect(pickedScratchFolder(root, `${root}/`)).toBeNull();
  });

  it("returns a folder the user picked", () => {
    expect(pickedScratchFolder("/Users/me/code/app", root)).toBe("/Users/me/code/app");
    expect(pickedScratchFolder("/Users/me/.t3/scratch-other", root)).toBe(
      "/Users/me/.t3/scratch-other",
    );
  });

  it("compares Windows paths by separator-insensitive prefix", () => {
    expect(
      pickedScratchFolder("C:\\Users\\me\\.t3\\scratch\\a", "C:\\Users\\me\\.t3\\scratch"),
    ).toBe(null);
  });

  it("returns null without a workspace path", () => {
    expect(pickedScratchFolder(null, root)).toBeNull();
  });
});
