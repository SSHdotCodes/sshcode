import { describe, expect, it } from "vite-plus/test";

import { faceFromPick, titlePictures } from "./boxFaces.ts";

describe("box faces", () => {
  it("offers every topic's pictures and reads a reply's pick back", () => {
    const pictures = titlePictures();
    expect(pictures.length).toBe(28);
    expect(pictures[0]?.pictures[0]?.id).toBe("app");
    expect(faceFromPick("mobile")).toBe("topic-mobile");
    expect(faceFromPick(" topic-cleanup ")).toBe("topic-cleanup");
    expect(faceFromPick("unknown-2")).toBeNull();
    expect(faceFromPick("mobile-99")).toBeNull();
    expect(faceFromPick("")).toBeNull();
  });
});
