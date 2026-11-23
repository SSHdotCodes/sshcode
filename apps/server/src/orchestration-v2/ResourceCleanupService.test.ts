// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";

const layerTest = ResourceCleanupService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      Layer.succeed(TerminalManager.TerminalManager, {
        close: () => Effect.void,
      } as unknown as TerminalManager.TerminalManager["Service"]),
      Layer.succeed(PreviewManager.PreviewManager, {
        close: () => Effect.void,
      } as unknown as PreviewManager.PreviewManager["Service"]),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-resource-cleanup-" }),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe("ResourceCleanupService", () => {
  it.effect("removes an attachment's original sidecar during thread cleanup", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
      const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001";
      const sentPath = NodePath.join(config.attachmentsDir, `${attachmentId}.png`);
      const originalPath = NodePath.join(config.attachmentsDir, `${attachmentId}.original.png`);
      const otherPath = NodePath.join(
        config.attachmentsDir,
        "thread-2-00000000-0000-4000-8000-000000000002.png",
      );
      NodeFS.writeFileSync(sentPath, "sent");
      NodeFS.writeFileSync(originalPath, "original");
      NodeFS.writeFileSync(otherPath, "other");

      yield* cleanup.cleanupAttachments([attachmentId]);

      expect(NodeFS.existsSync(sentPath)).toBe(false);
      expect(NodeFS.existsSync(originalPath)).toBe(false);
      expect(NodeFS.existsSync(otherPath)).toBe(true);
    }).pipe(Effect.provide(layerTest)),
  );
});
