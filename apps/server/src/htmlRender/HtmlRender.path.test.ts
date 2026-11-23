// @effect-diagnostics nodeBuiltinImport:off -- Sparse files and hard links exercise the descriptor guards.
import * as NodeFSP from "node:fs/promises";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as HtmlRender from "./HtmlRender.ts";

const layer = HtmlRender.layer.pipe(
  Layer.provide(
    Layer.mock(PreviewBrowser.PreviewBrowser)({
      installed: Effect.succeed(Option.none()),
      executable: Effect.fail(
        new PreviewBrowser.PreviewBrowserInstallingError({
          downloadedBytes: 0,
          totalBytes: 1,
          unpacking: false,
        }),
      ),
    }),
  ),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-html-path-" })),
  Layer.provideMerge(NodeServices.layer),
);
const threadId = ThreadId.make("thread-html-path");
const frame = { threadId, title: "Page", height: 240 };

it.effect(
  "snapshots a workspace page and recovers successive path calls in publication order",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const html = yield* HtmlRender.HtmlRender;
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const config = yield* ServerConfig.ServerConfig;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped();
      const page = path.join(workspaceRoot, "page.html");
      const source = { path: page, workspaceRoot, ...frame };
      yield* fs.writeFileString(page, "<!doctype html><p>First</p>");
      const first = yield* html.publish(source);
      yield* fs.writeFileString(page, "<html><p>Second</p></html>");
      const second = yield* html.publish(source);
      const stored = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: first.attachmentId,
      });
      expect(yield* fs.readFileString(stored!)).toContain("<p>First</p>");
      expect(
        yield* sessions.takeHtmlRender(threadId, { ...source, path: page + "x" }),
      ).toBeUndefined();
      expect(
        yield* sessions.takeHtmlRender(threadId, { ...source, html: "<html/>" }),
      ).toBeUndefined();
      expect(yield* sessions.takeHtmlRender(threadId, { ...source, height: "240" })).toEqual(first);
      expect(yield* sessions.takeHtmlRender(threadId, source)).toEqual(second);
      expect(yield* sessions.takeHtmlRender(threadId, source)).toBeUndefined();
      const alias = path.join(workspaceRoot, "linked.html");
      yield* fs.symlink(page, alias);
      const linked = yield* html.publish({ ...source, path: alias });
      expect(yield* sessions.takeHtmlRender(threadId, source)).toBeUndefined();
      expect(yield* sessions.takeHtmlRender(threadId, { ...source, path: alias })).toEqual(linked);
    }).pipe(Effect.provide(layer)),
);

it.effect.each([
  "missing",
  "outside",
  "sibling-prefix",
  "symlink",
  "directory-link",
  "hardlink",
  "directory",
  "extension",
  "content",
  "relative",
  "network",
  "oversized",
] as const)("refuses %s page paths for preview and publish", (kind) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const html = yield* HtmlRender.HtmlRender;
    const directory = yield* fs.makeTempDirectoryScoped();
    const workspaceRoot = path.join(directory, "workspace");
    const outside = path.join(directory, "workspace-other");
    yield* fs.makeDirectory(workspaceRoot);
    yield* fs.makeDirectory(outside);
    const externalPage = path.join(outside, "page.html");
    yield* fs.writeFileString(externalPage, "<html><p>Outside</p></html>");
    let page = path.join(workspaceRoot, "page.html");
    if (kind !== "missing") yield* fs.writeFileString(page, "<html><p>Page</p></html>");
    switch (kind) {
      case "outside":
        page = path.join(workspaceRoot, "..", "workspace-other", "page.html");
        break;
      case "sibling-prefix":
        page = externalPage;
        break;
      case "symlink":
        yield* fs.remove(page);
        yield* fs.symlink(externalPage, page);
        break;
      case "directory-link":
        yield* fs.symlink(outside, path.join(workspaceRoot, "linked"));
        page = path.join(workspaceRoot, "linked", "page.html");
        break;
      case "hardlink":
        yield* fs.remove(page);
        yield* Effect.promise(() => NodeFSP.link(externalPage, page));
        break;
      case "directory":
        yield* fs.remove(page);
        yield* fs.makeDirectory(page);
        break;
      case "extension":
        page = path.join(workspaceRoot, "page.txt");
        yield* fs.writeFileString(page, "<html/>");
        break;
      case "content":
        yield* fs.writeFileString(page, "SECRET=value");
        break;
      case "relative":
        page = "page.html";
        break;
      case "network":
        page = "//server/share/page.html";
        break;
      case "oversized":
        yield* Effect.promise(() => NodeFSP.truncate(page, 25 * 1024 * 1024 + 1));
        break;
    }
    for (const result of [
      yield* html.preview({ path: page, workspaceRoot }).pipe(Effect.flip),
      yield* html.publish({ path: page, workspaceRoot, ...frame }).pipe(Effect.flip),
    ]) {
      expect(result._tag).toBe(
        kind === "oversized" ? "HtmlRenderFileTooLargeError" : "HtmlRenderFileError",
      );
      expect(result.message).toContain(kind === "oversized" ? "at most 25.0 MiB" : "missing or");
    }
  }).pipe(Effect.provide(layer)),
);
