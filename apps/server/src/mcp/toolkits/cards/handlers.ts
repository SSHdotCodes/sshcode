import {
  isProviderSendTurnSupportedImageMimeType,
  OrchestratorMcpFailure,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { validateAndNormalizeCardInput } from "@t3tools/shared/cards";
import { hostPreviewMimeTypeFromExtension } from "@t3tools/shared/filePreview";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Mime from "effect/http/Mime";

import { openMediaFile } from "../../../assets/MediaFile.ts";
import { attachmentFileExtension } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { loadCaller, unavailable } from "../../threadAccess.ts";
import { CardToolkit } from "./tools.ts";

function containsPath(path: Path.Path, root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/** Validates a card image block path with the same containment and image checks as attachments. */
const validateCardImagePath = Effect.fn("CardToolkit.validateCardImagePath")(function* (
  field: string,
  requested: string,
  workspaceRoot: string | undefined,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const home = Option.getOrElse(
    yield* Effect.serviceOption(HostProcess.HomeDirectory),
    () => process.env.HOME ?? "",
  );
  const badPath = (reason: string) =>
    new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `${field}: ${reason}`,
    });

  const store = yield* fs.realPath(attachmentsDir).pipe(Effect.option);
  const workspaceReal =
    workspaceRoot !== undefined
      ? yield* fs.realPath(workspaceRoot).pipe(Effect.option)
      : Option.none();
  const canonicalRoots = [
    ...(Option.isSome(workspaceReal) ? [workspaceReal.value] : []),
    ...(Option.isSome(store) ? [store.value] : []),
  ];
  const requestedRoots = [
    ...(workspaceRoot !== undefined ? [workspaceRoot] : []),
    attachmentsDir,
    ...canonicalRoots,
  ];
  if (requestedRoots.length === 0) {
    return yield* badPath("image must be inside your workspace or the attachments directory.");
  }

  const expanded = home.length > 0 ? expandHomePath(requested, home) : requested;
  const resolved =
    workspaceRoot !== undefined
      ? path.resolve(workspaceRoot, expanded)
      : path.isAbsolute(expanded)
        ? path.normalize(expanded)
        : path.resolve(attachmentsDir, expanded);

  if (!requestedRoots.some((root) => containsPath(path, root, resolved))) {
    return yield* badPath("image must be inside your workspace or the attachments directory.");
  }
  const source = yield* fs
    .realPath(resolved)
    .pipe(Effect.mapError(() => badPath("image file does not exist or cannot be read.")));
  if (!canonicalRoots.some((root) => containsPath(path, root, source))) {
    return yield* badPath("image must be inside your workspace or the attachments directory.");
  }

  yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* openMediaFile(source).pipe(
        Effect.mapError(() => badPath("image file must be a regular readable file.")),
      );
      if (!file || file.info.nlink !== 1n || file.info.size < 1n) {
        return yield* badPath("image file must be a non-empty regular file.");
      }
      const extension = attachmentFileExtension(path.basename(source));
      const mimeType =
        hostPreviewMimeTypeFromExtension(extension) ??
        Option.getOrElse(Mime.getType(source), () => "application/octet-stream");
      if (!isProviderSendTurnSupportedImageMimeType(mimeType)) {
        return yield* badPath("file must be a supported image (png, jpeg, webp, or gif).");
      }
      if (Number(file.info.size) > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
        return yield* badPath("image exceeds the 10 MiB limit.");
      }
    }),
  );
});

const handlers = {
  show_card: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      yield* McpInvocationContext.requireThreadScope(scope, "show_card");
      const validated = validateAndNormalizeCardInput(input);
      if (!validated.ok) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: validated.error,
        });
      }
      const imageBlocks = (validated.card.blocks ?? []).flatMap((block, index) =>
        "image" in block ? [{ index, path: block.image.path }] : [],
      );
      if (imageBlocks.length > 0) {
        const caller = yield* loadCaller();
        let workspaceRoot: string | undefined;
        if (caller.caller !== undefined) {
          const projects = yield* ProjectService.ProjectService;
          const project = yield* projects
            .getById(caller.caller.projectId)
            .pipe(Effect.mapError(unavailable));
          workspaceRoot =
            caller.caller.worktreePath ??
            (Option.isSome(project) ? project.value.workspaceRoot : undefined);
        }
        for (const image of imageBlocks) {
          yield* validateCardImagePath(
            `blocks[${image.index}].image.path`,
            image.path,
            workspaceRoot,
          );
        }
      }
      return { ok: true as const };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof CardToolkit.tools>;

export const layer = McpToolAccess.toLayer(CardToolkit, handlers);
