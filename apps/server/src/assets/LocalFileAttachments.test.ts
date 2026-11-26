import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as LocalFiles from "./LocalFileAttachments.ts";

const layer = LocalFiles.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-local-files-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(layer)("LocalFileAttachments", (it) => {
  it.effect("copies files from both allowed roots into the recipient's store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const workspaceRoot = yield* fs.makeTempDirectoryScoped();
      const image = path.join(workspaceRoot, "photo.jpg");
      const audio = path.join(attachmentsDir, "source.M4A");
      yield* fs.writeFileString(image, "pixels");
      yield* fs.writeFileString(audio, "recording");
      const result = yield* (yield* LocalFiles.LocalFileAttachments).copyToThread({
        paths: ["photo.jpg", audio],
        workspaceRoot,
        threadId: ThreadId.make("receiver"),
      });
      expect(result.attachments).toMatchObject([
        { type: "image", mimeType: "image/jpeg", name: "photo.jpg", sizeBytes: 6 },
        { type: "file", mimeType: "audio/mp4", name: "source.M4A", sizeBytes: 9 },
      ]);
      yield* fs.remove(audio);
      yield* fs.remove(image);
      const files = result.attachments.map((attachment) => {
        expect(attachment.id).toMatch(/^receiver-/);
        return resolveAttachmentPath({ attachmentsDir, attachment })!;
      });
      expect(yield* Effect.forEach(files, (file) => fs.readFileString(file))).toEqual([
        "pixels",
        "recording",
      ]);
      yield* result.discard;
      expect(yield* Effect.forEach(files, (file) => fs.exists(file))).toEqual([false, false]);
    }),
  );

  it.effect("rejects escapes, directories and oversized files, rolling back preceding copies", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const root = yield* fs.makeTempDirectoryScoped();
      const workspaceRoot = path.join(root, "work");
      const outside = path.join(root, "work-sibling");
      yield* fs.makeDirectory(workspaceRoot);
      yield* fs.makeDirectory(outside);
      yield* fs.writeFileString(path.join(outside, "clip.mp4"), "outside");
      yield* fs.writeFileString(path.join(workspaceRoot, "ok.wav"), "ok");
      const badPaths = [
        outside,
        "../work-sibling/clip.mp4",
        ".",
        "missing",
        "large.mp4",
        "large.png",
        "empty",
      ];
      if ((yield* HostProcess.Platform) !== "win32") {
        yield* fs.symlink(outside, path.join(workspaceRoot, "link"));
        yield* fs.link(path.join(outside, "clip.mp4"), path.join(workspaceRoot, "hardlink"));
        badPaths.push("link/clip.mp4", "hardlink");
      }
      for (const [name, size] of [
        ["large.mp4", PROVIDER_SEND_TURN_MAX_FILE_BYTES],
        ["large.png", PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1],
        ["empty", 0],
      ] as const) {
        const file = path.join(workspaceRoot, name);
        yield* fs.writeFileString(file, "");
        yield* fs.truncate(file, size);
      }
      const before = yield* fs.readDirectory(attachmentsDir);
      const files = yield* LocalFiles.LocalFileAttachments;
      for (const file of badPaths) {
        const error = yield* files
          .copyToThread({
            paths: ["ok.wav", file],
            workspaceRoot,
            threadId: ThreadId.make("receiver"),
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("AttachmentClaimError");
        expect(yield* fs.readDirectory(attachmentsDir)).toEqual(before);
      }
    }),
  );
});
