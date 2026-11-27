import { AtomRegistry } from "effect/reactivity";
import * as AsyncResult from "effect/reactivity/AsyncResult";
import { afterAll, afterEach, describe, expect, it, vi } from "vite-plus/test";

import { serverDownloadReady, serverReleaseAssetsAtom } from "./serverRelease";

const version = "0.2.0";

// FetchHttpClient reads globalThis.fetch once and keeps it, so every test shares this mock.
const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

async function settledCheck() {
  const atom = serverReleaseAssetsAtom(version);
  const registry = AtomRegistry.make();
  const unmount = registry.mount(atom);
  try {
    await vi.waitFor(() => {
      const result = registry.get(atom);
      expect(AsyncResult.isInitial(result) || result.waiting).toBe(false);
    });
    return registry.get(atom);
  } finally {
    unmount();
    registry.dispose();
  }
}

describe("serverReleaseAssetsAtom", () => {
  afterEach(() => {
    fetchMock.mockReset();
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("asks this repository's GitHub releases, not npm, without tracing headers", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        tag_name: `v${version}`,
        assets: [{ name: "t3-0.2.0-linux-x64.tar.gz" }, { name: "SHA256SUMS" }],
      }),
    );

    const result = await settledCheck();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = new Request(fetchMock.mock.calls[0]?.[0] ?? "", fetchMock.mock.calls[0]?.[1]);
    expect(request.url).toBe(
      `https://api.github.com/repos/SSHdotCodes/sshcode/releases/tags/v${version}`,
    );
    expect(request.headers.get("traceparent")).toBeNull();
    expect(request.headers.get("b3")).toBeNull();
    expect([...AsyncResult.getOrElse(result, () => new Set<string>())]).toEqual([
      "t3-0.2.0-linux-x64.tar.gz",
      "SHA256SUMS",
    ]);
  });

  it("reports a missing or unpublished release as having no downloads", async () => {
    fetchMock.mockImplementation(async () => new Response(null, { status: 404 }));

    const result = await settledCheck();

    expect(AsyncResult.isSuccess(result)).toBe(true);
    expect(AsyncResult.getOrElse(result, () => null)?.size).toBe(0);
  });

  it("reports a release without server archives, such as a desktop-only one, as having none", async () => {
    fetchMock.mockImplementation(async () =>
      Response.json({
        tag_name: `v${version}`,
        assets: [{ name: "SSHCode-0.2.0-arm64.dmg" }, { name: "SSHCode-0.2.0-arm64.dmg.sha256" }],
      }),
    );

    const result = await settledCheck();

    expect(AsyncResult.isSuccess(result)).toBe(true);
    expect(AsyncResult.getOrElse(result, () => null)?.size).toBe(0);
  });

  it("leaves a failed first check unknown", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await settledCheck();

    expect(AsyncResult.isFailure(result)).toBe(true);
    expect(AsyncResult.getOrElse(result, () => null)).toBeNull();
  });
});

describe("serverDownloadReady", () => {
  const linux = { os: "linux", arch: "x64" } as const;
  const partial = new Set(["SHA256SUMS", "t3-0.2.0-darwin-arm64.tar.gz"]);

  it("needs the server's own platform archive beside the checksum file", () => {
    expect(serverDownloadReady(partial, version, { os: "darwin", arch: "arm64" })).toBe(true);
    // A release missing this platform's archive would fail in the installer.
    expect(serverDownloadReady(partial, version, linux)).toBe(false);
    expect(serverDownloadReady(new Set(["t3-0.2.0-linux-x64.tar.gz"]), version, linux)).toBe(false);
    expect(
      serverDownloadReady(new Set(["SHA256SUMS", "t3-0.2.0-win32-x64.zip"]), version, {
        os: "windows",
        arch: "x64",
      }),
    ).toBe(true);
  });

  it("stays unknown while the release or the platform is unknown", () => {
    expect(serverDownloadReady(null, version, linux)).toBeNull();
    expect(serverDownloadReady(partial, version, undefined)).toBeNull();
    expect(serverDownloadReady(partial, version, { os: "unknown", arch: "x64" })).toBeNull();
    expect(serverDownloadReady(partial, version, { os: "linux", arch: "other" })).toBeNull();
  });
});
