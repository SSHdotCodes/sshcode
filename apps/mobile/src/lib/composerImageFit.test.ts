import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const native = vi.hoisted(() => ({
  save: vi.fn(),
  release: vi.fn(),
  resize: vi.fn(),
  deleteFile: vi.fn(),
}));

vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg", PNG: "png" },
  ImageManipulator: {
    manipulate(source: string | { width: number; height: number }) {
      let size = typeof source === "string" ? { width: 4000, height: 2000 } : source;
      const context = {
        resize(next: { width: number; height: number }) {
          native.resize(next);
          size = next;
          return context;
        },
        async renderAsync() {
          return { ...size, saveAsync: native.save, release: native.release };
        },
      };
      return context;
    },
  },
}));

vi.mock("expo-file-system", () => ({
  File: class {
    exists = true;
    constructor(readonly uri: string) {}
    delete() {
      native.deleteFile(this.uri);
    }
  },
}));

import { renderPhoto } from "./composerImageFit";

// Every four base64 characters encode three bytes; the contents need no decoding here.
const oversized = "AAAA".repeat(Math.ceil((PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1) / 3));

describe("renderPhoto", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    native.save.mockReset();
    native.save.mockResolvedValue({ base64: "YWJj", uri: "file:///cache/final.png" });
  });

  it("shrinks a resampled PNG again when its encoded bytes exceed the limit", async () => {
    native.save.mockResolvedValueOnce({ base64: oversized, uri: "file:///cache/too-large.png" });

    const result = await renderPhoto("file:///photos/source.png", "png");

    expect(native.resize.mock.calls).toEqual([
      [{ width: 2000, height: 1000 }],
      [{ width: 1799, height: 899 }],
    ]);
    expect(native.save).toHaveBeenCalledTimes(2);
    expect(native.save).toHaveBeenLastCalledWith({ format: "png", compress: 0.85, base64: true });
    expect(result).toEqual({
      base64: "YWJj",
      uri: "file:///cache/final.png",
      size: { width: 1799, height: 899 },
      originalSize: { width: 4000, height: 2000 },
    });
    expect(native.deleteFile).toHaveBeenCalledExactlyOnceWith("file:///cache/too-large.png");
    expect(native.release).toHaveBeenCalledTimes(3);
  });

  it("keeps a JPEG that fits without a second encode", async () => {
    const result = await renderPhoto("file:///photos/source.heic");

    expect(native.save).toHaveBeenCalledExactlyOnceWith({
      format: "jpeg",
      compress: 0.85,
      base64: true,
    });
    expect(result.size).toEqual({ width: 2000, height: 1000 });
    expect(result.originalSize).toEqual({ width: 4000, height: 2000 });
    expect(native.deleteFile).not.toHaveBeenCalled();
    expect(native.release).toHaveBeenCalledTimes(2);
  });

  it("bounds retries when the native encoder keeps returning oversized bytes", async () => {
    native.save.mockResolvedValue({ base64: oversized, uri: "file:///cache/still-too-large.png" });

    await renderPhoto("file:///photos/source.png", "png");

    expect(native.save).toHaveBeenCalledTimes(4);
    expect(native.deleteFile).toHaveBeenCalledTimes(3);
    expect(native.release).toHaveBeenCalledTimes(5);
  });

  it("releases the rendered image if encoding produces no bytes", async () => {
    native.save.mockResolvedValue({ uri: "file:///cache/empty.png" });

    await expect(renderPhoto("file:///photos/source.png", "png")).rejects.toThrow("has no bytes");
    expect(native.release).toHaveBeenCalledTimes(2);
  });
});
