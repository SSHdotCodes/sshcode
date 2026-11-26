import {
  ChatAttachmentId,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type ThreadId,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Mime from "effect/http/Mime";

import {
  attachmentFileExtension,
  createAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import {
  AttachmentClaimError,
  releaseClaimedAttachments,
} from "../orchestration-v2/AttachmentClaims.ts";
import { openMediaFile, streamMediaFile } from "./MediaFile.ts";

export class LocalFileAttachments extends Context.Service<
  LocalFileAttachments,
  {
    readonly copyToThread: (input: {
      readonly workspaceRoot: string;
      readonly threadId: ThreadId;
      /** Workflow retries can supply files from the original accepted turn. */
      readonly paths: ReadonlyArray<string | ChatAttachment>;
    }) => Effect.Effect<
      {
        readonly attachments: ReadonlyArray<ChatAttachment>;
        readonly discard: Effect.Effect<void>;
      },
      AttachmentClaimError
    >;
  }
>()("t3/assets/LocalFileAttachments") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const unreadable = () =>
    new AttachmentClaimError({
      message: "Attach a regular file inside your workspace or the attachments directory.",
    });
  const contains = (root: string, candidate: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative !== "" &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
  };
  const copyToThread: LocalFileAttachments["Service"]["copyToThread"] = Effect.fn(
    "LocalFileAttachments.copyToThread",
  )(function* (input) {
    if (input.paths.length > PROVIDER_SEND_TURN_MAX_ATTACHMENTS)
      return yield* new AttachmentClaimError({ message: "Too many attachment paths." });
    const store = yield* fs.realPath(attachmentsDir).pipe(Effect.mapError(unreadable));
    const workspace = yield* fs.realPath(input.workspaceRoot).pipe(Effect.option);
    const canonicalRoots = Option.isSome(workspace) ? [workspace.value, store] : [store];
    const requestedRoots = [input.workspaceRoot, attachmentsDir, ...canonicalRoots];
    const copies: string[] = [];
    const discard = releaseClaimedAttachments(copies).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
    );
    let total = 0;
    const attachments = yield* Effect.forEach(input.paths, (requested) =>
      Effect.scoped(
        Effect.gen(function* () {
          const requestedPath =
            typeof requested === "string"
              ? path.resolve(input.workspaceRoot, expandHomePath(requested, home))
              : resolveAttachmentPath({ attachmentsDir: store, attachment: requested });
          if (!requestedPath || !requestedRoots.some((root) => contains(root, requestedPath)))
            return yield* unreadable();
          const source = yield* fs.realPath(requestedPath).pipe(Effect.mapError(unreadable));
          if (!canonicalRoots.some((root) => contains(root, source))) return yield* unreadable();
          const file = yield* openMediaFile(source).pipe(Effect.mapError(unreadable));
          if (!file || file.info.nlink !== 1n || file.info.size < 1n) return yield* unreadable();
          const name =
            typeof requested === "string" ? path.basename(requestedPath) : requested.name;
          const extension = attachmentFileExtension(name);
          const mimeType =
            hostPreviewMimeTypeFromExtension(extension) ??
            Option.getOrElse(Mime.getType(name), () => "application/octet-stream");
          const image = isProviderSendTurnSupportedImageMimeType(mimeType);
          const sizeBytes = Number(file.info.size);
          total += sizeBytes;
          if (
            (image && sizeBytes > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) ||
            total > PROVIDER_SEND_TURN_MAX_FILE_BYTES
          )
            return yield* new AttachmentClaimError({
              message: "Local attachments allow 10 MiB per image and 50 MiB total.",
            });
          const id = createAttachmentId(input.threadId, extension);
          if (!id)
            return yield* new AttachmentClaimError({
              message: "Invalid attachment destination thread.",
            });
          const attachment: ChatAttachment = {
            id: ChatAttachmentId.make(id),
            type: image ? "image" : "file",
            name,
            mimeType,
            sizeBytes,
          };
          const destination = resolveAttachmentPath({ attachmentsDir: store, attachment });
          const bytes = streamMediaFile(file, 0n, file.info.size);
          if (!destination || !bytes) return yield* unreadable();
          const copyError = () =>
            new AttachmentClaimError({ message: "Could not copy the local attachment." });
          const output = yield* fs
            .open(destination, { flag: "wx", mode: 0o600 })
            .pipe(Effect.mapError(copyError));
          copies.push(destination);
          yield* Stream.runForEach(bytes, (chunk) => output.writeAll(chunk)).pipe(
            Effect.mapError(copyError),
          );
          const stored = yield* output.stat.pipe(Effect.mapError(copyError));
          if (stored.size !== file.info.size)
            return yield* new AttachmentClaimError({
              message: "Attachment changed while it was being copied.",
            });
          return attachment;
        }),
      ),
    ).pipe(Effect.onError(() => discard));
    return { attachments, discard };
  });
  return LocalFileAttachments.of({ copyToThread });
});

export const layer = Layer.effect(LocalFileAttachments, make);
