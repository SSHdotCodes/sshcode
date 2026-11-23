import { DESKTOP_MEDIA_MAX_BYTES } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { readBoundedDesktopMedia } from "./useDesktopMedia";

afterEach(() => vi.unstubAllGlobals());

describe("desktop media download", () => {
  it("reads the original bytes in order", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/png" } }),
      ),
    );
    expect([
      ...(await readBoundedDesktopMedia(
        "https://example.test/a.png",
        new AbortController().signal,
      )),
    ]).toEqual([1, 2, 3]);
  });
  it("rejects a declared oversized response and an html page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("x", { headers: { "content-length": String(DESKTOP_MEDIA_MAX_BYTES + 1) } }),
      ),
    );
    await expect(
      readBoundedDesktopMedia("https://example.test/a", new AbortController().signal),
    ).rejects.toThrow("too large");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<html>", { headers: { "content-type": "text/html" } })),
    );
    await expect(
      readBoundedDesktopMedia("https://example.test/a", new AbortController().signal),
    ).rejects.toThrow("could not be loaded");
  });
  it("cancels an oversized stream even without a length header", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(DESKTOP_MEDIA_MAX_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    await expect(
      readBoundedDesktopMedia("https://example.test/a", new AbortController().signal),
    ).rejects.toThrow("too large");
    expect(cancel).toHaveBeenCalledOnce();
  });
});
