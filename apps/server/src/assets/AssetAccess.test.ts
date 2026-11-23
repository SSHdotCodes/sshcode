// @effect-diagnostics nodeBuiltinImport:off - tests inject swaps at the native open boundary.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeFSP from "node:fs/promises";
import {
  AssetAccessError,
  AssetPreviewTypeValidationError,
  MessageId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import { PROJECT_FAVICON_FALLBACK_MARKER } from "@t3tools/shared/projectFavicon";
import { MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  HttpRouter,
  HttpServerResponse,
} from "effect/http";
import { vi } from "vite-plus/test";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { assetFileResponse, layerAssetRoute, layerBrowserApiCors } from "../http.ts";
import { ASSET_ROUTE_PREFIX, issueAssetUrl, readMcpAppHtml, resolveAsset } from "./AssetAccess.ts";
import * as NativeAppIconResolver from "./NativeAppIconResolver.ts";
import { openMediaFile } from "./MediaFile.ts";
import { keepViewedImageCopy, viewedImageCopyPath } from "./viewedImageCopies.ts";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";
import * as GitHubCredentials from "@t3tools/source-control-github/server/GitHubCredentials";
import { githubMediaResponse } from "./GitHubMediaFetch.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFSP>();
  return { ...actual, open: vi.fn(actual.open), realpath: vi.fn(actual.realpath) };
});

const layerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-asset-access-test-",
});
// A PNG header is enough for the dimension read: signature, then IHDR width and height.
const screenshotPng = new Uint8Array(24);
screenshotPng.set([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
new DataView(screenshotPng.buffer).setUint32(16, 390);
new DataView(screenshotPng.buffer).setUint32(20, 844);
const screenshotItem = {
  id: TurnItemId.make("tool-screenshot"),
  type: "dynamic_tool" as const,
  threadId: ThreadId.make("thread-1"),
  runId: null,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed" as const,
  title: null,
  toolName: "mcp__t3-code__device_screenshot",
  input: { deviceId: "phone" },
  output: {
    content: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from(screenshotPng).toString("base64"),
        },
      },
    ],
  },
  startedAt: DateTime.makeUnsafe("2026-10-05T00:00:00.000Z"),
  completedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-05T00:00:01.000Z"),
};

const embeddedImageItem = {
  ...screenshotItem,
  type: "assistant_message" as const,
  id: TurnItemId.make("inline-message"),
  messageId: MessageId.make("inline-message-id"),
  text: `![external](https://example.test/one.png)\n![inline](data:image/png;base64,${Buffer.from(screenshotPng).toString("base64")})`,
  streaming: false,
};

const oversizedScreenshotItem = {
  ...screenshotItem,
  id: TurnItemId.make("tool-screenshot-oversized"),
  output: {
    content: [
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "A".repeat(14 * 1024 * 1024) },
      },
    ],
  },
};

const layerTest = Layer.mergeAll(
  NodeHttpPlatform.layer,
  Layer.mock(Orchestrator.OrchestratorV2)({
    getTurnItem: ({ itemId }) =>
      Effect.succeed(
        itemId === embeddedImageItem.id
          ? embeddedImageItem
          : itemId === screenshotItem.id
            ? screenshotItem
            : itemId === oversizedScreenshotItem.id
              ? oversizedScreenshotItem
              : null,
      ),
  }),
  layerConfig,
  WorkspacePaths.layer,
  ProjectFaviconResolver.layer.pipe(
    Layer.provide(WorkspacePaths.layer),
    Layer.provide(T3ProjectFileLoader.layer),
  ),
  NativeAppIconResolver.layer.pipe(Layer.provide(layerConfig)),
  ServerSecretStore.layer.pipe(Layer.provide(layerConfig)),
).pipe(Layer.provideMerge(NodeServices.layer));

describe("AssetAccess", () => {
  describe("readMcpAppHtml", () => {
    it.effect("accepts snapshots at the stored HTML byte limit", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const file = path.join(directory, "app.html");
        const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
        yield* fileSystem.writeFile(file, new Uint8Array(limit).fill(120));

        const bytes = yield* readMcpAppHtml(file);
        expect(bytes?.byteLength).toBe(limit);
        expect(bytes?.every((byte) => byte === 120)).toBe(true);
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("rejects snapshots one byte past the limit and much larger files", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const file = path.join(directory, "app.html");
        const limit = MCP_APP_MAX_HTML_BYTES + 128 * 1024;
        for (const size of [limit + 1, limit * 2]) {
          yield* fileSystem.writeFile(file, new Uint8Array(size).fill(120));
          expect(yield* readMcpAppHtml(file)).toBeNull();
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("preserves UTF-8 bytes across stream chunks and accepts empty snapshots", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const file = path.join(directory, "app.html");
        for (const html of ["", "<body>" + "☃".repeat(100_000) + "</body>"]) {
          const expected = new TextEncoder().encode(html);
          yield* fileSystem.writeFile(file, expected);
          const bytes = yield* readMcpAppHtml(file);
          expect(bytes?.byteLength).toBe(expected.byteLength);
          expect(bytes && new TextDecoder().decode(bytes)).toBe(html);
        }
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    it.effect("preserves filesystem failures instead of reporting oversized HTML", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-mcp-html-" });
        const error = yield* readMcpAppHtml(path.join(directory, "missing.html")).pipe(Effect.flip);
        expect(error._tag).toBe("PlatformError");
        expect(error.reason._tag).toBe("NotFound");
      }).pipe(Effect.provide(NodeServices.layer)),
    );
  });

  it.effect("loads private media immediately after login with the GitHub credential", () => {
    let lookups = 0;
    const authorizations: Array<string | undefined> = [];
    return Effect.gen(function* () {
      const asset = {
        url: "https://raw.githubusercontent.com/owner/repo/main/shot.png",
        cwd: "/repo",
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
      expect((yield* githubMediaResponse(asset, {})).status).toBe(404);
      expect((yield* githubMediaResponse(asset, {})).status).toBe(200);
      expect((yield* githubMediaResponse(asset, {})).status).toBe(200);
      // Caching the token is GitHubCredentials' job; this asks it every time.
      expect(lookups).toBe(3);
      expect(authorizations).toEqual([undefined, "Bearer signed-in", "Bearer signed-in"]);
    }).pipe(
      Effect.provide(
        Layer.mock(GitHubCredentials.GitHubCredentials)({
          get: (host) =>
            ++lookups === 1
              ? Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host }))
              : Effect.succeed({
                  host,
                  token: Redacted.make("signed-in"),
                  source: "gh" as const,
                  fingerprint: "fingerprint",
                }),
        }),
      ),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) => {
          authorizations.push(request.headers.authorization);
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(null, {
                status: request.headers.authorization ? 200 : 404,
                headers: { "content-type": "image/png" },
              }),
            ),
          );
        }),
      ),
      Effect.scoped,
    );
  });

  it.live("serves a safe failure when fetching signed GitHub media fails", () =>
    Effect.gen(function* () {
      const fixture = "temporary-media-query-value";
      const upstream = `https://raw.githubusercontent.com/owner/repo/main/shot.png?token=${fixture}`;
      const redirectFixture = "temporary-redirect-query-value";
      const redirected = `https://objects.githubusercontent.com/shot.png?sig=${redirectFixture}`;
      const { relativeUrl } = yield* issueAssetUrl({
        resource: { _tag: "github-media", cwd: "/repo", url: upstream },
      });
      const messages: string[] = [];
      const urls: string[] = [];
      const services = yield* Effect.context<Layer.Success<typeof layerTest>>();
      const { handler, dispose } = HttpRouter.toWebHandler(
        layerAssetRoute.pipe(
          Layer.provideMerge(Layer.succeedContext(services)),
          Layer.provideMerge(
            Layer.mock(GitHubCredentials.GitHubCredentials)({
              get: (host) => Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host })),
            }),
          ),
          Layer.provideMerge(
            Layer.succeed(
              HttpClient.HttpClient,
              HttpClient.make((request) => {
                urls.push(request.url);
                if (request.url === upstream) {
                  return Effect.succeed(
                    HttpClientResponse.fromWeb(
                      request,
                      new Response(null, {
                        status: 302,
                        headers: { location: redirected },
                      }),
                    ),
                  );
                }
                return Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      cause: new Error(`Fixture transport failure for ${request.url}`),
                    }),
                  }),
                );
              }),
            ),
          ),
          Layer.provideMerge(
            Logger.layer(
              [
                Logger.make(({ message, fiber }) => {
                  messages.push(
                    JSON.stringify([message, fiber.getRef(References.CurrentLogAnnotations)]),
                  );
                }),
              ],
              { mergeWithExisting: false },
            ),
          ),
        ),
      );
      try {
        const response = yield* Effect.promise(() =>
          handler(new Request(new URL(relativeUrl, "http://localhost"))),
        );
        expect(response.status).toBe(502);
        expect(urls).toEqual([upstream, redirected]);
        expect(messages.join("\n")).toContain("Failed to fetch GitHub media.");
        expect(messages.join("\n")).not.toContain(fixture);
        expect(messages.join("\n")).not.toContain(redirectFixture);
        expect(messages.join("\n")).not.toContain(relativeUrl);
      } finally {
        yield* Effect.promise(dispose);
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves an image a tool returned inline from the stored item", () =>
    Effect.gen(function* () {
      const resource = {
        _tag: "tool-output-image" as const,
        threadId: screenshotItem.threadId,
        itemId: screenshotItem.id,
        index: 0,
      };
      const result = yield* issueAssetUrl({ resource });
      expect(result.imageDimensions).toEqual({ width: 390, height: 844 });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      expect(yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1))).toEqual({
        kind: "bytes",
        mimeType: "image/png",
        bytes: Buffer.from(screenshotPng),
      });
      const missing = yield* issueAssetUrl({ resource: { ...resource, index: 1 } }).pipe(
        Effect.flip,
      );
      expect(missing._tag).toBe("AssetWorkspaceAssetNotFoundError");
      // Larger than a provider turn accepts, so it is never decoded.
      const oversized = yield* issueAssetUrl({
        resource: { ...resource, itemId: oversizedScreenshotItem.id },
      }).pipe(Effect.flip);
      expect(oversized._tag).toBe("AssetWorkspaceAssetNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves one inline message image through its signed asset", () =>
    Effect.gen(function* () {
      const resource = {
        _tag: "message-inline-image" as const,
        threadId: embeddedImageItem.threadId,
        itemId: embeddedImageItem.id,
        index: 1,
      };
      const result = yield* issueAssetUrl({ resource });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      expect(yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1))).toEqual({
        kind: "bytes",
        mimeType: "image/png",
        bytes: Buffer.from(screenshotPng),
      });
      const missing = yield* issueAssetUrl({ resource: { ...resource, index: 0 } }).pipe(
        Effect.flip,
      );
      expect(missing._tag).toBe("AssetWorkspaceAssetNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves the copy kept of an image whose file was deleted, in its chat only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-deleted-" });
      const filePath = path.join(outside, "frame.png");
      yield* fs.writeFileString(filePath, "frame");
      const threadId = ThreadId.make("thread-kept-copy");
      expect(
        yield* Effect.promise(() =>
          keepViewedImageCopy({ stateDir: config.stateDir, threadId, filePath, now: 1_000 }),
        ),
      ).toBe(true);
      const resource = { _tag: "media-file", threadId, path: filePath } as const;

      // While the file is there, the chat shows the file itself.
      const live = yield* issueAssetUrl({ resource });
      expect(live.relativeUrl.endsWith("/frame.png")).toBe(true);

      yield* fs.remove(filePath);
      const kept = yield* issueAssetUrl({ resource });
      const suffix = kept.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const resolved = yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
      expect(resolved).toMatchObject({ kind: "file", mimeType: "image/png" });
      expect(suffix.slice(separator + 1)).toBe("frame.png");
      const copyPath = viewedImageCopyPath(config.stateDir, threadId, filePath)!;
      expect(resolved).toMatchObject({ path: yield* fs.realPath(copyPath) });

      const otherChat = yield* issueAssetUrl({
        resource: { ...resource, threadId: ThreadId.make("thread-without-copy") },
      }).pipe(Effect.flip);
      expect(otherChat._tag).toBe("AssetWorkspaceAssetNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves the kept copy of a deleted image a message linked by a relative path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-relative-kept-" });
      const filePath = path.join(root, "frame.png");
      yield* fs.writeFileString(filePath, "frame");
      const threadId = ThreadId.make("thread-relative-kept-copy");
      expect(
        yield* Effect.promise(() =>
          keepViewedImageCopy({ stateDir: config.stateDir, threadId, filePath, now: 1_000 }),
        ),
      ).toBe(true);
      yield* fs.remove(filePath);
      const kept = yield* issueAssetUrl({
        resource: { _tag: "media-file", threadId, path: "frame.png" },
        workspaceRoot: root,
      });
      const suffix = kept.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const resolved = yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
      const copyPath = viewedImageCopyPath(config.stateDir, threadId, filePath)!;
      expect(resolved).toMatchObject({ kind: "file", path: yield* fs.realPath(copyPath) });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues exact URLs for media and browser documents outside the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-root-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-outside-" });
      for (const [name, mimeType] of [
        ["screenshot.png", "image/png"],
        ["recording.mp4", "video/mp4"],
        ["recording.webm", "video/webm"],
        ["report.html", "text/html"],
        ["report.pdf", "application/pdf"],
      ] as const) {
        const filePath = path.join(outside, name);
        yield* fs.writeFileString(filePath, "media");
        const canonicalFile = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        expect(yield* resolveAsset(token, suffix.slice(separator + 1))).toMatchObject({
          kind: "file",
          path: canonicalFile,
          mimeType,
        });
        yield* fs.writeFileString(path.join(outside, "sibling.png"), "private sibling");
        expect(yield* resolveAsset(token, "sibling.png")).toBeNull();
        expect(yield* resolveAsset(token, `../${name}`)).toBeNull();
        expect(yield* resolveAsset(`${token}tampered`, name)).toBeNull();
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("reports pixel dimensions from an image header and nothing for other files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-dimensions-" });
      const png = Uint8Array.from([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0,
        0x06, 0x40, 0, 0, 0x03, 0x84,
      ]);
      yield* fs.writeFile(path.join(root, "shot.png"), png);
      yield* fs.writeFileString(path.join(root, "clip.mp4"), "video");
      yield* fs.writeFileString(path.join(root, "broken.png"), "not a png");
      const issue = (name: string) =>
        issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: name },
          workspaceRoot: root,
        });

      expect((yield* issue("shot.png")).imageDimensions).toEqual({ width: 1600, height: 900 });
      expect((yield* issue("clip.mp4")).imageDimensions).toBeUndefined();
      expect((yield* issue("broken.png")).imageDimensions).toBeUndefined();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("resolves direct relative media paths from the thread workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-relative-" });
      const root = path.join(directory, "workspace");
      yield* fs.makeDirectory(root);
      for (const relativePath of ["screenshot.png", "../recording.mp4"]) {
        const filePath = path.resolve(root, relativePath);
        yield* fs.writeFileString(filePath, "media");
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: relativePath },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)),
        ).toMatchObject({
          kind: "file",
          path: yield* fs.realPath(filePath),
        });
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each([
    {
      name: "a unique nested suffix",
      matches: ["project/renders/preview.png"],
      expected: "project/renders/preview.png",
    },
    {
      name: "an ambiguous suffix",
      matches: ["one/renders/preview.png", "two/renders/preview.png"],
      expected: null,
    },
    {
      name: "no matching suffix",
      matches: ["project/other/preview.png", "project/my-renders/preview.png"],
      expected: null,
    },
    {
      name: "a direct match before nested matches",
      matches: ["renders/preview.png", "project/renders/preview.png"],
      expected: "renders/preview.png",
    },
    {
      name: "depth and excluded folders",
      matches: [
        "one/two/three/renders/preview.png",
        "one/two/three/four/renders/preview.png",
        "node_modules/renders/preview.png",
        ".git/renders/preview.png",
        ".hidden/renders/preview.png",
        "build/renders/preview.png",
        "dist/renders/preview.png",
      ],
      expected: "one/two/three/renders/preview.png",
    },
  ])("resolves a relative image with $name", ({ matches, expected }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-relative-image-" });
      for (const match of matches) {
        const file = path.join(root, match);
        yield* fs.makeDirectory(path.dirname(file), { recursive: true });
        yield* fs.writeFile(file, screenshotPng);
      }
      for (const resource of [
        { path: "renders/preview.png" },
        { path: path.join(root, "renders/preview.png"), hostOnly: true as const },
      ]) {
        const issue = issueAssetUrl({
          resource: { ...resource, _tag: "media-file", threadId: ThreadId.make("thread-1") },
          workspaceRoot: root,
        });
        if (expected === null) {
          expect((yield* Effect.flip(issue))._tag).toBe("AssetWorkspaceAssetNotFoundError");
        } else {
          const { relativeUrl } = yield* issue;
          const [token, name] = relativeUrl.slice(ASSET_ROUTE_PREFIX.length + 1).split("/");
          expect(yield* resolveAsset(token!, name!)).toMatchObject({
            kind: "file",
            path: yield* fs.realPath(path.join(root, expected)),
          });
        }
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects relative image paths that escape through ..", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-image-escape-" });
      const root = path.join(directory, "chat");
      yield* fs.makeDirectory(root);
      yield* fs.writeFile(path.join(directory, "preview.png"), screenshotPng);
      const error = yield* issueAssetUrl({
        resource: {
          _tag: "media-file",
          threadId: ThreadId.make("thread-1"),
          path: "../preview.png",
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error._tag).toBe("AssetWorkspacePathValidationError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("requires a complete search within the entry budget to serve a nested image", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-image-search-limit-" });
      const nested = path.join(root, "nested");
      yield* fs.makeDirectory(nested);
      yield* fs.writeFile(path.join(nested, "preview.png"), screenshotPng);
      yield* Effect.forEach(
        Array.from({ length: 3_000 }, (_, index) => index),
        (index) => fs.writeFileString(path.join(nested, `file-${index}.txt`), ""),
        { concurrency: 8, discard: true },
      );
      const error = yield* issueAssetUrl({
        resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: "preview.png" },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error._tag).toBe("AssetWorkspaceAssetNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "keeps relative images inside the chat through symlinks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-image-symlink-" });
        const root = path.join(directory, "chat");
        const outside = path.join(directory, "outside");
        const nested = path.join(root, "nested");
        yield* fs.makeDirectory(nested, { recursive: true });
        yield* fs.makeDirectory(outside);
        yield* fs.writeFile(path.join(outside, "preview.png"), screenshotPng);
        yield* fs.symlink(outside, path.join(root, "linked"));
        yield* fs.symlink(path.join(outside, "preview.png"), path.join(nested, "preview.png"));
        const issue = (filePath: string) =>
          issueAssetUrl({
            resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
            workspaceRoot: root,
          }).pipe(Effect.flip);
        expect((yield* issue("linked/preview.png"))._tag).toBe("AssetWorkspacePathValidationError");
        expect((yield* issue("preview.png"))._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("resolves home-relative media paths independently of the workspace", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-home-" });
      const home = path.join(directory, "var", "home", "alice");
      const filePath = path.join(home, "Downloads", "repro.mp4");
      yield* fs.makeDirectory(path.dirname(filePath), { recursive: true });
      yield* fs.writeFileString(filePath, "recording bytes");
      const canonicalFile = yield* fs.realPath(filePath);
      yield* Effect.gen(function* () {
        for (const workspaceRoot of [
          path.join(home, "project"),
          path.join(directory, "srv", "project"),
          undefined,
        ]) {
          if (workspaceRoot) yield* fs.makeDirectory(workspaceRoot, { recursive: true });
          for (const requestedPath of ["~/Downloads/repro.mp4", "~\\Downloads/repro.mp4"]) {
            const result = yield* issueAssetUrl({
              resource: {
                _tag: "media-file",
                threadId: ThreadId.make("thread-1"),
                path: requestedPath,
              },
              ...(workspaceRoot ? { workspaceRoot } : {}),
            });
            const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
            const separator = suffix.indexOf("/");
            const asset = yield* resolveAsset(
              suffix.slice(0, separator),
              suffix.slice(separator + 1),
            );
            expect(asset).toMatchObject({
              kind: "file",
              path: canonicalFile,
              mimeType: "video/mp4",
            });
            if (asset?.kind !== "file") throw new Error("Expected a resolved home media file");
            const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset));
            expect(yield* Effect.promise(() => response.text())).toBe("recording bytes");
          }
        }
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, home));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects non-previewable files, disguised targets, and directories",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-validation-" });
        for (const name of ["report.md", "secret.txt", "secret.%70ng", "secret.png#private.txt"]) {
          const filePath = path.join(root, name);
          yield* fs.writeFileString(filePath, "not media");
          const error = yield* issueAssetUrl({
            resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
          }).pipe(Effect.flip);
          expect(error).toBeInstanceOf(AssetPreviewTypeValidationError);
        }
        const disguisedPath = path.join(root, "disguised.png");
        yield* fs.symlink(path.join(root, "secret.txt"), disguisedPath);
        const disguisedError = yield* issueAssetUrl({
          resource: {
            _tag: "media-file",
            threadId: ThreadId.make("thread-1"),
            path: disguisedPath,
          },
        }).pipe(Effect.flip);
        expect(disguisedError).toBeInstanceOf(AssetPreviewTypeValidationError);
        const directoryPath = path.join(root, "directory.png");
        yield* fs.makeDirectory(directoryPath);
        const directoryError = yield* issueAssetUrl({
          resource: {
            _tag: "media-file",
            threadId: ThreadId.make("thread-1"),
            path: directoryPath,
          },
        }).pipe(Effect.flip);
        expect(directoryError._tag).toBe("AssetWorkspaceAssetNotFoundError");
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "binds media URLs to the canonical target and rejects symlink substitution",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-symlink-" });
        const filePath = path.join(root, "actual.svg");
        const aliasPath = path.join(root, "alias.png");
        const replacementPath = path.join(root, "other.svg");
        yield* fs.writeFileString(filePath, "<svg/>");
        yield* fs.writeFileString(replacementPath, "<svg>private</svg>");
        yield* fs.symlink(filePath, aliasPath);
        const canonicalFile = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: aliasPath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const token = suffix.slice(0, separator);
        const name = suffix.slice(separator + 1);
        const expected = { kind: "file", path: canonicalFile, mimeType: "image/svg+xml" };
        expect(yield* resolveAsset(token, name)).toMatchObject(expected);
        yield* fs.remove(aliasPath);
        yield* fs.symlink(replacementPath, aliasPath);
        expect(yield* resolveAsset(token, name)).toMatchObject(expected);
        yield* fs.remove(filePath);
        yield* fs.symlink(replacementPath, filePath);
        expect(yield* resolveAsset(token, name)).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "keeps full and partial responses bound to the file opened during resolution",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-open-file-" });
        const filePath = path.join(root, "recording.mp4");
        const savedPath = path.join(root, "saved.mp4");
        const secretPath = path.join(root, "secret.txt");
        yield* fs.writeFileString(filePath, "0123456789");
        yield* fs.writeFileString(secretPath, "private information");
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        for (const [range, expected, status] of [
          [undefined, "0123456789", 200],
          ["bytes=2-5", "2345", 206],
        ] as const) {
          const asset = yield* resolveAsset(
            suffix.slice(0, separator),
            suffix.slice(separator + 1),
          );
          if (asset?.kind !== "file") throw new Error("Expected a resolved media file");

          yield* fs.rename(filePath, savedPath);
          yield* fs.symlink(secretPath, filePath);
          const response = HttpServerResponse.toWeb(yield* assetFileResponse(asset, range));
          expect(response.status).toBe(status);
          expect(response.headers.get("content-length")).toBe(String(expected.length));
          expect(yield* Effect.promise(() => response.text())).toBe(expected);
          yield* fs.remove(filePath);
          yield* fs.rename(savedPath, filePath);
        }
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects a symlink swapped in after canonical validation but before open",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-open-race-" });
        const filePath = path.join(root, "recording.mp4");
        const secretPath = path.join(root, "secret.txt");
        yield* fs.writeFileString(filePath, "video");
        yield* fs.writeFileString(secretPath, "secret");
        const canonicalPath = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          stat: Effect.fn(function* (requestedPath) {
            const info = yield* fs.stat(requestedPath);
            if (requestedPath === canonicalPath) {
              yield* fs.remove(filePath);
              yield* fs.symlink(secretPath, filePath);
            }
            return info;
          }),
        });
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)).pipe(
            Effect.provideService(FileSystem.FileSystem, swappingFileSystem),
          ),
        ).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "closes a descriptor rejected when its path changes during open",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-open-rejected-" });
        const filePath = path.join(root, "recording.mp4");
        const secretPath = path.join(root, "secret.txt");
        yield* fs.writeFileString(filePath, "video");
        yield* fs.writeFileString(secretPath, "secret");
        const canonicalPath = yield* fs.realPath(filePath);
        const originalOpen = (yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        )).open;
        let opened: NodeFSP.FileHandle | undefined;
        const openSpy = vi.mocked(NodeFSP.open).mockImplementation(async (target, flags, mode) => {
          const handle = await originalOpen(target, flags, mode);
          if (target === canonicalPath) {
            opened = handle;
            await NodeFSP.unlink(filePath);
            await NodeFSP.symlink(secretPath, filePath);
          }
          return handle;
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => openSpy.mockImplementation(originalOpen)),
        );
        expect(yield* openMediaFile(canonicalPath)).toBeNull();
        expect(opened).toBeDefined();
        expect(opened?.fd).toBe(-1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.skipIf(!symlinksSupported)(
    "rejects an ancestor symlink race even when canonical path rechecks would pass",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-parent-race-" });
        const publicDirectory = path.join(root, "public");
        const privateDirectory = path.join(root, "private");
        yield* fs.makeDirectory(publicDirectory);
        yield* fs.makeDirectory(privateDirectory);
        const filePath = path.join(publicDirectory, "recording.mp4");
        yield* fs.writeFileString(filePath, "public video");
        yield* fs.writeFileString(path.join(privateDirectory, "recording.mp4"), "private video");
        const canonicalPath = yield* fs.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: { _tag: "media-file", threadId: ThreadId.make("thread-1"), path: filePath },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        const native = yield* Effect.promise(() =>
          vi.importActual<typeof NodeFSP>("node:fs/promises"),
        );
        const savedDirectory = path.join(root, "saved");
        const realpathSpy = vi.mocked(NodeFSP.realpath).mockImplementationOnce(async () => {
          // A pathname-only guard can see the original parents during realpath,
          // but the private file during both lstat calls and open.
          await native.unlink(publicDirectory);
          await native.rename(savedDirectory, publicDirectory);
          const canonical = await native.realpath(canonicalPath);
          await native.rename(publicDirectory, savedDirectory);
          await native.symlink(privateDirectory, publicDirectory, "junction");
          return canonical;
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => realpathSpy.mockReset().mockImplementation(native.realpath)),
        );
        const swappingFileSystem = FileSystem.FileSystem.of({
          ...fs,
          realPath: Effect.fn(function* (requestedPath) {
            const canonical = yield* fs.realPath(requestedPath);
            if (requestedPath === canonicalPath) {
              yield* fs.rename(publicDirectory, savedDirectory);
              yield* Effect.promise(() =>
                NodeFSP.symlink(privateDirectory, publicDirectory, "junction"),
              );
            }
            return canonical;
          }),
        });
        expect(
          yield* resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1)).pipe(
            Effect.provideService(FileSystem.FileSystem, swappingFileSystem),
          ),
        ).toBeNull();
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps in-place edits readable but requires a new URL after atomic replacement", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-media-replacement-" });
      const filePath = path.join(root, "recording.mp4");
      yield* fs.writeFileString(filePath, "original");
      const input = {
        resource: {
          _tag: "media-file" as const,
          threadId: ThreadId.make("thread-1"),
          path: filePath,
        },
      };
      const original = yield* issueAssetUrl(input);
      const suffix = original.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separator = suffix.indexOf("/");
      const token = suffix.slice(0, separator);
      const name = suffix.slice(separator + 1);
      yield* fs.writeFileString(filePath, "in-place edit");
      const edited = yield* resolveAsset(token, name);
      if (edited?.kind !== "file") throw new Error("Expected the edited media file");
      const editedResponse = HttpServerResponse.toWeb(yield* assetFileResponse(edited));
      expect(yield* Effect.promise(() => editedResponse.text())).toBe("in-place edit");

      const replacement = path.join(root, "replacement.mp4");
      yield* fs.writeFileString(replacement, "replacement");
      yield* fs.rename(replacement, filePath);
      expect(yield* resolveAsset(token, name)).toBeNull();

      const renewed = yield* issueAssetUrl(input);
      const renewedSuffix = renewed.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const renewedSeparator = renewedSuffix.indexOf("/");
      const renewedAsset = yield* resolveAsset(
        renewedSuffix.slice(0, renewedSeparator),
        renewedSuffix.slice(renewedSeparator + 1),
      );
      if (renewedAsset?.kind !== "file") throw new Error("Expected the replacement media file");
      const renewedResponse = HttpServerResponse.toWeb(yield* assetFileResponse(renewedAsset));
      expect(yield* Effect.promise(() => renewedResponse.text())).toBe("replacement");
      yield* fs.remove(filePath);
      expect(
        yield* resolveAsset(
          renewedSuffix.slice(0, renewedSeparator),
          renewedSuffix.slice(renewedSeparator + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues workspace URLs that resolve the entry file and sibling assets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-workspace-",
      });
      const htmlPath = path.join(root, "report.html");
      const cssPath = path.join(root, "report.css");
      yield* fileSystem.writeFileString(htmlPath, '<link rel="stylesheet" href="report.css">');
      yield* fileSystem.writeFileString(cssPath, "body { color: red; }");
      yield* fileSystem.writeFileString(path.join(root, ".env"), "SECRET=value");
      const canonicalHtmlPath = yield* fileSystem.realPath(htmlPath);
      const canonicalCssPath = yield* fileSystem.realPath(cssPath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "report.html")).toEqual({
        kind: "file",
        path: canonicalHtmlPath,
        workspaceHtmlScriptsAllowed: false,
      });
      expect(yield* resolveAsset(token, "report.css")).toEqual({
        kind: "file",
        path: canonicalCssPath,
      });
      expect(yield* resolveAsset(token, "../secret.txt")).toBeNull();
      expect(yield* resolveAsset(token, ".env")).toBeNull();
      expect(yield* resolveAsset(`${token}tampered`, "report.html")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect(
    "serves workspace HTML with scripts disabled unless an authenticated mint allows that file",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-html-policy-" });
        yield* fs.writeFileString(path.join(root, "page.html"), "<script>test()</script>");
        yield* fs.writeFileString(path.join(root, "other.html"), "<script>other()</script>");
        yield* fs.writeFileString(path.join(root, "main.css"), "body { color: red }");
        if (symlinksSupported) {
          yield* Effect.promise(() => NodeFSP.symlink("page.html", path.join(root, "style.css")));
        }
        const resource = {
          _tag: "workspace-file" as const,
          threadId: ThreadId.make("thread-1"),
          path: "page.html",
        };
        const blocked = yield* issueAssetUrl({ resource, workspaceRoot: root });
        const allowed = yield* issueAssetUrl({
          resource: { ...resource, scriptsAllowed: true },
          workspaceRoot: root,
        });
        expect(blocked.relativeUrl).not.toBe(allowed.relativeUrl);
        const services = yield* Layer.build(
          HttpRouter.serve(Layer.merge(layerAssetRoute, layerBrowserApiCors), {
            disableListenLog: true,
          }).pipe(Layer.provideMerge(NodeHttpServer.layerTest)),
        );
        const client = Context.get(services, HttpClient.HttpClient);
        const blockedResponse = yield* client.get(`${blocked.relativeUrl}?scriptsAllowed=true`, {
          headers: { origin: "null" },
        });
        expect(blockedResponse.status).toBe(200);
        expect(blockedResponse.headers["content-security-policy"]).toContain("script-src 'none'");
        expect(blockedResponse.headers["access-control-allow-origin"]).toBe("*");
        const cssResponse = yield* client.get(blocked.relativeUrl.replace("page.html", "main.css"));
        expect(cssResponse.status).toBe(200);
        expect(yield* cssResponse.text).toBe("body { color: red }");
        const allowedResponse = yield* client.get(allowed.relativeUrl);
        expect(allowedResponse.headers["content-security-policy"]).not.toContain(
          "script-src 'none'",
        );
        const otherResponse = yield* client.get(
          allowed.relativeUrl.replace("page.html", "other.html"),
        );
        expect(otherResponse.headers["content-security-policy"]).toContain("script-src 'none'");
        const aliasResponse = yield* client.get(
          allowed.relativeUrl.replace("page.html", "style.css"),
        );
        expect(aliasResponse.headers["content-security-policy"]).toContain("script-src 'none'");
        const blockedToken = blocked.relativeUrl.split("/")[3]!;
        const allowedToken = allowed.relativeUrl.split("/")[3]!;
        const forged = blocked.relativeUrl.replace(
          blockedToken,
          `${allowedToken.split(".")[0]}.${blockedToken.split(".")[1]}`,
        );
        const forgedResponse = yield* client.get(forged);
        expect(forgedResponse.status).toBe(404);
      }).pipe(
        Effect.provide(
          Layer.merge(
            layerTest,
            Layer.mock(GitHubCredentials.GitHubCredentials)({
              get: (host) => Effect.fail(new GitHubCredentials.GitHubNotSignedInError({ host })),
            }),
          ),
        ),
      ),
  );

  for (const extension of ["pdf", "png"]) {
    it.effect.skipIf(!symlinksSupported)(
      `serves a linked ${extension} only while its target is previewable`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.realPath(
            yield* fs.makeTempDirectoryScoped({ prefix: "t3-link-" }),
          );
          yield* fs.writeFileString(path.join(root, "payload.xhtml"), "<html/>");
          yield* fs.writeFileString(path.join(root, `real.${extension}`), "preview contents");
          const link = path.join(root, `report.${extension}`);
          const issue = issueAssetUrl({
            resource: {
              _tag: "workspace-file",
              threadId: ThreadId.make("thread-1"),
              path: `report.${extension}`,
            },
            workspaceRoot: root,
          });
          const resolveIssued = (relativeUrl: string) => {
            const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
            const separator = suffix.indexOf("/");
            return resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
          };

          yield* fs.symlink(path.join(root, "payload.xhtml"), link);
          expect((yield* issue.pipe(Effect.flip))._tag).toBe("AssetPreviewTypeValidationError");

          yield* fs.remove(link);
          yield* fs.symlink(path.join(root, `real.${extension}`), link);
          const issued = yield* issue;
          expect(yield* resolveIssued(issued.relativeUrl)).toMatchObject({
            path: path.join(root, `real.${extension}`),
          });

          yield* fs.remove(link);
          yield* fs.symlink(path.join(root, "payload.xhtml"), link);
          expect(yield* resolveIssued(issued.relativeUrl)).toBeNull();
        }).pipe(Effect.provide(layerTest)),
    );
  }

  it.effect("rejects workspace files outside the authorized root", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-outside-",
      });
      const htmlPath = path.join(outside, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>outside</p>");

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error.message).toBe("Workspace file path must be relative to the project root.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspacePathValidationError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBeInstanceOf(WorkspacePaths.WorkspacePathOutsideRootError);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues draft workspace URLs without a thread", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-draft-",
      });
      const htmlPath = path.join(root, "report.html");
      const cssPath = path.join(root, "report.css");
      yield* fileSystem.writeFileString(htmlPath, '<link rel="stylesheet" href="report.css">');
      yield* fileSystem.writeFileString(cssPath, "body { color: red; }");
      const canonicalHtmlPath = yield* fileSystem.realPath(htmlPath);
      const canonicalCssPath = yield* fileSystem.realPath(cssPath);

      const result = yield* issueAssetUrl({
        resource: { _tag: "draft-workspace-file", cwd: root, path: "report.html" },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "report.html")).toEqual({
        kind: "file",
        path: canonicalHtmlPath,
        workspaceHtmlScriptsAllowed: false,
      });
      expect(yield* resolveAsset(token, "report.css")).toEqual({
        kind: "file",
        path: canonicalCssPath,
      });
      expect(yield* resolveAsset(token, "../secret.txt")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves absolute draft media files exactly, wherever they live", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-draft-root-",
      });
      const outside = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-draft-outside-",
      });
      const clipPath = path.join(outside, "clip.mp4");
      yield* fileSystem.writeFileString(clipPath, "video");
      const canonicalClipPath = yield* fileSystem.realPath(clipPath);

      const result = yield* issueAssetUrl({
        resource: { _tag: "draft-workspace-file", cwd: root, path: clipPath },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "clip.mp4")).toMatchObject({
        kind: "file",
        path: canonicalClipPath,
        mimeType: "video/mp4",
      });
      expect(yield* resolveAsset(token, "other.mp4")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("falls back to the resource cwd for relative draft paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-draft-fallback-",
      });
      const htmlPath = path.join(root, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>draft</p>");
      const canonicalHtmlPath = yield* fileSystem.realPath(htmlPath);

      const result = yield* issueAssetUrl({
        resource: { _tag: "draft-workspace-file", cwd: root, path: "report.html" },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "report.html")).toEqual({
        kind: "file",
        path: canonicalHtmlPath,
        workspaceHtmlScriptsAllowed: false,
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("preserves non-missing canonical path failures when issuing asset URLs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-permission-root-",
      });
      const htmlPath = path.join(root, "report.html");
      yield* fileSystem.writeFileString(htmlPath, "<p>report</p>");
      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "realPath",
        pathOrDescriptor: htmlPath,
      });
      const failingFileSystem = FileSystem.FileSystem.of({
        ...fileSystem,
        realPath: () => Effect.fail(cause),
      });

      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: htmlPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.provideService(FileSystem.FileSystem, failingFileSystem), Effect.flip);

      expect(error.message).toBe("Failed to inspect the workspace asset.");
      expect(error).toMatchObject({
        _tag: "AssetWorkspaceAssetInspectionError",
        resource: {
          _tag: "workspace-file",
          threadId: "thread-1",
          path: htmlPath,
        },
      });
      expect(error.cause).toBe(cause);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues exact workspace URLs for image previews", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-image-workspace-",
      });
      const assetsDirectory = path.join(root, "assets");
      const imagePath = path.join(assetsDirectory, "icon.png");
      const siblingPath = path.join(assetsDirectory, "other.png");
      yield* fileSystem.makeDirectory(assetsDirectory, { recursive: true });
      yield* fileSystem.writeFile(imagePath, new Uint8Array([137, 80, 78, 71]));
      yield* fileSystem.writeFile(siblingPath, new Uint8Array([137, 80, 78, 71]));
      const canonicalImagePath = yield* fileSystem.realPath(imagePath);

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: imagePath,
        },
        workspaceRoot: root,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "icon.png")).toEqual({
        kind: "file",
        path: canonicalImagePath,
      });
      expect(yield* resolveAsset(token, "other.png")).toBeNull();
      expect(yield* resolveAsset(token, "../icon.png")).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("previews workspace files with literal fragment characters in their paths", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-preview-literal-" });
      const directory = path.join(root, "assets#archive");
      yield* fileSystem.makeDirectory(directory);

      for (const name of ["icon#v2.png", "report#draft.pdf"]) {
        const filePath = path.join(directory, name);
        yield* fileSystem.writeFileString(filePath, "preview fixture");
        const canonicalFile = yield* fileSystem.realPath(filePath);
        const result = yield* issueAssetUrl({
          resource: {
            _tag: "workspace-file",
            threadId: ThreadId.make("thread-1"),
            path: filePath,
          },
          workspaceRoot: root,
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const token = suffix.slice(0, suffix.indexOf("/"));

        expect(yield* resolveAsset(token, name)).toEqual({ kind: "file", path: canonicalFile });
        if (name.endsWith(".png")) {
          expect(yield* resolveAsset(token, "other.png")).toBeNull();
        }
      }

      const disguisedPath = path.join(root, "image.png#notes.txt");
      yield* fileSystem.writeFileString(disguisedPath, "not an image");
      const error = yield* issueAssetUrl({
        resource: {
          _tag: "workspace-file",
          threadId: ThreadId.make("thread-1"),
          path: disguisedPath,
        },
        workspaceRoot: root,
      }).pipe(Effect.flip);
      expect(error).toBeInstanceOf(AssetPreviewTypeValidationError);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signs MCP render intent only for inline HTML attachments", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      for (const extension of ["html", "pdf"]) {
        const attachmentId = `thread-1-00000000-0000-4000-8000-000000000031-${extension}`;
        yield* fs.writeFileString(
          path.join(config.attachmentsDir, `${attachmentId}.${extension}`),
          "capture",
        );
        for (const disposition of ["inline", "attachment"] as const) {
          const result = yield* issueAssetUrl({
            resource: {
              _tag: "attachment",
              attachmentId,
              disposition,
              renderIntent: "mcp-app",
            },
          });
          const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
          const separator = suffix.indexOf("/");
          const asset = yield* resolveAsset(
            suffix.slice(0, separator),
            suffix.slice(separator + 1),
          );
          if (asset?.kind !== "file") throw new Error("Expected attachment file");
          expect("renderIntent" in asset ? asset.renderIntent : undefined).toBe(
            extension === "html" && disposition === "inline" ? "mcp-app" : undefined,
          );
          // Changing signed claims cannot opt an ordinary download into rendering.
          const token = suffix.slice(0, separator);
          const [payload, signature] = token.split(".");
          const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
          claims.renderIntent = claims.renderIntent ? undefined : "mcp-app";
          const tampered = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${signature}`;
          expect(yield* resolveAsset(tampered, suffix.slice(separator + 1))).toBeNull();
        }
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues exact attachment capabilities by attachment id", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.png`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

      const result = yield* issueAssetUrl({
        resource: { _tag: "attachment", attachmentId },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");
      const token = suffix.slice(0, separatorIndex);

      expect(yield* resolveAsset(token, "ignored.png")).toEqual({
        kind: "file",
        path: attachmentPath,
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signs original sidecars separately from the sent image", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000009";
      const sentPath = path.join(config.attachmentsDir, `${attachmentId}.png`);
      const originalPath = path.join(config.attachmentsDir, `${attachmentId}.original.png`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(sentPath, new Uint8Array([1]));
      yield* fileSystem.writeFile(originalPath, new Uint8Array([2, 3]));

      const resolve = Effect.fn("test.resolveAttachmentAsset")(function* (original: boolean) {
        const result = yield* issueAssetUrl({
          resource: {
            _tag: "attachment",
            attachmentId,
            fileName: "photo.png",
            mimeType: "image/png",
            ...(original ? { original: true } : {}),
          },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separatorIndex = suffix.indexOf("/");
        return yield* resolveAsset(
          suffix.slice(0, separatorIndex),
          suffix.slice(separatorIndex + 1),
        );
      });

      expect(yield* resolve(false)).toMatchObject({ kind: "file", path: sentPath });
      expect(yield* resolve(true)).toMatchObject({
        kind: "file",
        path: originalPath,
        fileName: "photo.png",
        mimeType: "image/png",
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("signs the same HTML page URL within an expiry window", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001-html";
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(config.attachmentsDir, `${attachmentId}.html`),
        "<p>render</p>",
      );
      const bucketMs = 30 * 60 * 1000;
      const issue = issueAssetUrl({
        resource: { _tag: "attachment", attachmentId, disposition: "inline" },
      });
      yield* TestClock.setTime(bucketMs + 1);
      const first = yield* issue;
      yield* TestClock.adjust("20 minutes");
      const second = yield* issue;
      yield* TestClock.adjust("10 minutes");
      const next = yield* issue;

      expect(second.relativeUrl).toBe(first.relativeUrl);
      expect(first.expiresAt).toBe(4 * bucketMs);
      expect(next.expiresAt).toBe(5 * bucketMs);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves video attachments inline", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001-mp4";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.mp4`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "attachment",
          attachmentId,
          fileName: "demo.mp4",
          mimeType: 'video/mp4; codecs="avc1.42E01E"',
        },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toEqual({
        kind: "file",
        path: attachmentPath,
        fileName: "demo.mp4",
        mimeType: "video/mp4",
      });
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("issues signed native application icon capabilities", () =>
    Effect.gen(function* () {
      const result = yield* issueAssetUrl({
        resource: {
          _tag: "native-app-icon",
          app: { _tag: "app-id", appId: "com.example.Editor" },
        },
      });

      expect(result.relativeUrl).toMatch(
        new RegExp(`^${ASSET_ROUTE_PREFIX}/[^/]+/native-app-icon\\.png$`, "u"),
      );
      expect(result.expiresAt).toBeGreaterThan(0);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves document attachments inline when a viewer requests it", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001-pdf";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.pdf`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "attachment",
          attachmentId,
          fileName: "report.pdf",
          mimeType: "application/pdf",
          disposition: "inline",
        },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toEqual({
        kind: "file",
        path: attachmentPath,
        fileName: "report.pdf",
        mimeType: "application/pdf",
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves audio previews with their stored format and keeps saving explicit", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000003-wav";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.wav`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));
      for (const disposition of ["inline", "attachment"] as const) {
        const result = yield* issueAssetUrl({
          resource: {
            _tag: "attachment",
            attachmentId,
            fileName: "recording.wav",
            mimeType: "application/octet-stream",
            disposition,
          },
        });
        const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separatorIndex = suffix.indexOf("/");
        expect(
          yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
        ).toEqual({
          kind: "file",
          path: attachmentPath,
          fileName: "recording.wav",
          mimeType: disposition === "inline" ? "audio/wav" : "application/octet-stream",
          ...(disposition === "attachment" ? { download: true } : {}),
        });
      }
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps inline requests for other attachment types as downloads", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000002-zip";
      const attachmentPath = path.join(config.attachmentsDir, `${attachmentId}.zip`);
      yield* fileSystem.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3]));

      const result = yield* issueAssetUrl({
        resource: {
          _tag: "attachment",
          attachmentId,
          fileName: "archive.zip",
          mimeType: "text/html",
          disposition: "inline",
        },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toMatchObject({ kind: "file", path: attachmentPath, download: true });
    }).pipe(Effect.provide(layerTest)),
  );
  it.effect("issues project favicon capabilities with a signed fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-",
      });
      const faviconPath = path.join(root, "favicon.svg");
      const initialFavicon = "<svg>a</svg>";
      const updatedFavicon = "<svg>b</svg>";
      expect(updatedFavicon).toHaveLength(initialFavicon.length);
      yield* fileSystem.writeFileString(faviconPath, initialFavicon);
      const canonicalFaviconPath = yield* fileSystem.realPath(faviconPath);

      const faviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(faviconResult.sourcePath).toBe("favicon.svg");
      expect(faviconResult.relativeUrl).toMatch(/\/v[0-9a-f]{64}-favicon\.svg$/);
      expect(
        yield* issueAssetUrl({
          resource: { _tag: "project-favicon", cwd: root },
        }),
      ).toEqual(faviconResult);
      const faviconSuffix = faviconResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const faviconSeparatorIndex = faviconSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          faviconSuffix.slice(0, faviconSeparatorIndex),
          faviconSuffix.slice(faviconSeparatorIndex + 1),
        ),
      ).toEqual({ kind: "file", path: canonicalFaviconPath });

      yield* fileSystem.writeFileString(faviconPath, updatedFavicon);
      const updatedFaviconResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(
        updatedFaviconResult.relativeUrl.slice(updatedFaviconResult.relativeUrl.lastIndexOf("/")),
      ).not.toBe(faviconResult.relativeUrl.slice(faviconResult.relativeUrl.lastIndexOf("/")));

      yield* fileSystem.remove(faviconPath);
      const fallbackResult = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      expect(fallbackResult.relativeUrl.endsWith(`/${PROJECT_FAVICON_FALLBACK_MARKER}`)).toBe(true);
      expect(fallbackResult.sourcePath).toBeUndefined();
      const fallbackSuffix = fallbackResult.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const fallbackSeparatorIndex = fallbackSuffix.indexOf("/");
      expect(
        yield* resolveAsset(
          fallbackSuffix.slice(0, fallbackSeparatorIndex),
          fallbackSuffix.slice(fallbackSeparatorIndex + 1),
        ),
      ).toBeNull();
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues project favicon capabilities for a saved override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-override-",
      });
      yield* fileSystem.makeDirectory(path.join(root, "brand"));
      yield* fileSystem.writeFileString(path.join(root, "brand", "custom.svg"), "<svg />");
      yield* fileSystem.writeFileString(path.join(root, "favicon.svg"), "<svg>auto</svg>");

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
        projectFaviconPath: "brand/custom.svg",
      });

      expect(result.sourcePath).toBe(path.join("brand", "custom.svg"));
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-custom\.svg$/);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("issues an exact capability for a saved favicon outside the workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-workspace-",
      });
      const pictures = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-pictures-",
      });
      const externalPath = path.join(pictures, "custom.png");
      const siblingPath = path.join(pictures, "sibling.png");
      yield* fileSystem.writeFile(externalPath, new Uint8Array([1, 2, 3]));
      yield* fileSystem.writeFile(siblingPath, new Uint8Array([4, 5, 6]));
      const canonicalPath = yield* fileSystem.realPath(externalPath);
      const canonicalSiblingPath = yield* fileSystem.realPath(siblingPath);

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
        projectFaviconPath: externalPath,
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(result.sourcePath).toBe(externalPath);
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-custom\.png$/);
      expect(
        yield* resolveAsset(suffix.slice(0, separatorIndex), suffix.slice(separatorIndex + 1)),
      ).toEqual({ kind: "file", path: canonicalPath });
      const tamperedSuffixResult = yield* resolveAsset(
        suffix.slice(0, separatorIndex),
        "sibling.png",
      );
      expect(tamperedSuffixResult).toEqual({ kind: "file", path: canonicalPath });
      expect(tamperedSuffixResult).not.toEqual({ kind: "file", path: canonicalSiblingPath });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("ignores a client favicon path hint", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-hint-",
      });
      yield* fileSystem.makeDirectory(path.join(root, "brand"));
      yield* fileSystem.writeFileString(path.join(root, "brand", "hint.svg"), "<svg>hint</svg>");
      yield* fileSystem.writeFileString(path.join(root, "brand", "saved.svg"), "<svg>saved</svg>");

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root, path: "brand/hint.svg" },
        projectFaviconPath: "brand/saved.svg",
      });

      expect(result.sourcePath).toBe(path.join("brand", "saved.svg"));
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-saved\.svg$/);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("keeps automatic favicon resolution separate from a saved override", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-automatic-",
      });
      yield* fileSystem.makeDirectory(path.join(root, "brand"));
      yield* fileSystem.writeFileString(path.join(root, "brand", "saved.svg"), "<svg>saved</svg>");
      yield* fileSystem.writeFileString(path.join(root, "favicon.svg"), "<svg>automatic</svg>");

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });

      expect(result.sourcePath).toBe("favicon.svg");
      expect(result.relativeUrl).toMatch(/\/v[0-9a-f]{64}-favicon\.svg$/);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves a native macOS app icon as its embedded PNG", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-icns-",
      });
      const icns = new Uint8Array(8 + 8 + screenshotPng.length);
      icns.set(new TextEncoder().encode("icns"));
      new DataView(icns.buffer).setUint32(4, icns.length);
      icns.set(new TextEncoder().encode("ic07"), 8);
      new DataView(icns.buffer).setUint32(12, 8 + screenshotPng.length);
      icns.set(screenshotPng, 16);
      yield* fileSystem.makeDirectory(path.join(root, "Resources"));
      yield* fileSystem.writeFile(path.join(root, "Resources", "AppIcon.icns"), icns);

      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      });
      const suffix = result.relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
      const separatorIndex = suffix.indexOf("/");

      expect(result.sourcePath).toBe(path.join("Resources", "AppIcon.icns"));
      const asset = yield* resolveAsset(
        suffix.slice(0, separatorIndex),
        suffix.slice(separatorIndex + 1),
      );
      expect(asset?.kind === "bytes" ? asset.mimeType : null).toBe("image/png");
      expect(asset?.kind === "bytes" ? Uint8Array.from(asset.bytes) : null).toEqual(screenshotPng);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("rejects a resolved project favicon with a non-image extension", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-type-",
      });
      yield* fileSystem.writeFileString(path.join(root, "secret.txt"), "not an image");

      const error = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
        projectFaviconPath: "secret.txt",
      }).pipe(Effect.flip);

      expect(error).toBeInstanceOf(AssetPreviewTypeValidationError);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("buckets project favicon expiry after content hashing", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-expiry-",
      });
      yield* fileSystem.writeFileString(path.join(root, "favicon.svg"), "<svg />");

      const bucketMs = 30 * 60 * 1000;
      yield* TestClock.setTime(bucketMs - 1);
      const crossingCrypto = Crypto.make({
        randomBytes: (size) => new Uint8Array(size),
        digest: (algorithm, data) =>
          TestClock.adjust("2 millis").pipe(Effect.andThen(crypto.digest(algorithm, data))),
      });
      const result = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      }).pipe(Effect.provideService(Crypto.Crypto, crossingCrypto));

      expect(result.expiresAt).toBe(3 * bucketMs);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("preserves structured project favicon resolution causes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-asset-favicon-error-",
      });
      const platformCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "stat",
      });
      const resolutionCause = new ProjectFaviconResolver.ProjectFaviconResolutionError({
        operation: "stat-candidate",
        workspaceRoot: root,
        relativePath: "favicon.svg",
        cause: platformCause,
      });
      const resolver = ProjectFaviconResolver.ProjectFaviconResolver.of({
        resolvePath: () => Effect.fail(resolutionCause),
      });

      const error = yield* issueAssetUrl({
        resource: { _tag: "project-favicon", cwd: root },
      }).pipe(
        Effect.provideService(ProjectFaviconResolver.ProjectFaviconResolver, resolver),
        Effect.flip,
      );

      expect(error.message).toBe("Failed to resolve project favicon.");
      expect(error._tag).toBe("AssetProjectFaviconResolutionError");
      expect(error.cause).toBe(resolutionCause);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("serves GitHub-hosted pull request media through the repository's credential", () =>
    Effect.gen(function* () {
      const resolve = (relativeUrl: string) => {
        const suffix = relativeUrl.slice(`${ASSET_ROUTE_PREFIX}/`.length);
        const separator = suffix.indexOf("/");
        return resolveAsset(suffix.slice(0, separator), suffix.slice(separator + 1));
      };
      const issue = (url: string) =>
        issueAssetUrl({ resource: { _tag: "github-media", cwd: "/repo", url } });

      const attachment = yield* issue(
        "https://github.com/user-attachments/assets/1a1842fb-6383-492f-873c-57aa0033fa6c",
      );
      expect(attachment.relativeUrl.endsWith("/1a1842fb-6383-492f-873c-57aa0033fa6c")).toBe(true);
      expect(yield* resolve(attachment.relativeUrl)).toEqual({
        kind: "github-media",
        url: "https://github.com/user-attachments/assets/1a1842fb-6383-492f-873c-57aa0033fa6c",
        cwd: "/repo",
        // The signed URL's own expiry, which is how long a client may keep the bytes.
        expiresAt: attachment.expiresAt,
      });

      // A `blob` link addresses the page; only the raw host answers a credential with bytes.
      const committed = yield* issue("https://github.com/owner/repo/blob/main/docs/shot.png");
      expect(yield* resolve(committed.relativeUrl)).toMatchObject({
        url: "https://raw.githubusercontent.com/owner/repo/main/docs/shot.png",
      });

      // The pre-`user-attachments` form, Git LFS bytes, and a name no `decodeURIComponent`
      // accepts all arrive from real bodies.
      const legacy = yield* issue("https://github.com/owner/repo/assets/45952064/1a1842fb");
      expect(yield* resolve(legacy.relativeUrl)).toMatchObject({
        url: "https://github.com/owner/repo/assets/45952064/1a1842fb",
      });
      const lfs = yield* issue("https://media.githubusercontent.com/media/owner/repo/main/a.mp4");
      expect(yield* resolve(lfs.relativeUrl)).toMatchObject({
        url: "https://media.githubusercontent.com/media/owner/repo/main/a.mp4",
      });
      const awkward = yield* issue("https://raw.githubusercontent.com/o/r/main/100%.png");
      expect(awkward.relativeUrl.endsWith("/100%25.png")).toBe(true);

      for (const url of [
        "https://example.com/shot.png",
        "https://example.com/shot.png?token=private-media-token",
        "http://github.com/user-attachments/assets/1a1842fb",
        "https://github.com/owner/repo/pull/1",
        "https://github.com/owner/repo/blob/main/",
      ]) {
        const error = yield* issue(url).pipe(Effect.flip);
        expect(error._tag).toBe("AssetGitHubMediaUrlValidationError");
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(AssetAccessError))(error);
        expect(encoded).not.toContain(url);
      }
    }).pipe(Effect.provide(layerTest)),
  );
});
