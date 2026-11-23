import {
  classifyMarkdownImageSource,
  markdownImageSourceFragment,
} from "@t3tools/client-runtime/markdown-images";
import { splitFilePathPosition } from "@t3tools/shared/fileLinks";
import {
  mediaFileReference,
  mediaUrlReference,
  mediaReferenceFileName,
} from "@t3tools/client-runtime/media-reference";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { normalizeNativeMarkdownUrl } from "./markdownLinks";
import { resolveMobileMarkdownMediaSource } from "./markdownMediaSource";

import type { FilePreviewSource } from "../components/FilePreviewModal";
import type { MediaVideoPreviewSource } from "./videoPreviewSource";
import type { MediaActionsSource } from "./mediaActionsSource";

function scopedResource<Resource extends object>(resource: Resource, scope: string | undefined) {
  return scope ? { ...resource, scope } : resource;
}

/** Resolves only explicit media references. Ordinary links keep their existing navigation. */
export function resolveMarkdownMediaPreview(
  href: string,
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId | undefined;
    readonly workspaceRoot: string | null | undefined;
    /** Captured markdown may only open media with a direct URL. */
    readonly captured?: boolean;
    /** Image syntax can target an endpoint without a recognizable extension. */
    readonly imageEmbed?: boolean;
    /** Keys workspace media URLs to one message, so a file rewritten under the
        same name loads fresh in a later message instead of a cached copy. */
    readonly scope?: string | undefined;
  },
):
  | { readonly kind: "image"; readonly source: FilePreviewSource }
  | { readonly kind: "pdf"; readonly source: FilePreviewSource }
  | { readonly kind: "video"; readonly source: MediaVideoPreviewSource }
  | null {
  const classified = classifyMarkdownImageSource(href, input.workspaceRoot);
  if (classified._tag !== "Blocked") {
    const path =
      classified._tag === "Direct" ? classified.uri : splitFilePathPosition(classified.path).path;
    const reference =
      classified._tag === "Direct"
        ? mediaUrlReference(path)
        : mediaFileReference(path, input.workspaceRoot);
    const name = reference && mediaReferenceFileName(reference);
    if (name && /\.pdf$/i.test(name)) {
      const common = { kind: "pdf" as const, name, mimeType: "application/pdf" };
      if (classified._tag === "Direct") {
        const uri = normalizeNativeMarkdownUrl(path);
        return {
          kind: "pdf",
          source: {
            ...common,
            uri,
            actionsSource: {
              ...(reference ? { reference } : {}),
              uri,
              name,
              mimeType: common.mimeType,
            },
          },
        };
      }
      if (input.captured) return null;
      const resource = input.threadId
        ? {
            _tag: "media-file" as const,
            threadId: input.threadId,
            path,
            ...(input.scope ? { scope: input.scope } : {}),
            ...(classified.relative ? { hostOnly: true as const } : {}),
          }
        : input.workspaceRoot
          ? { _tag: "draft-workspace-file" as const, cwd: input.workspaceRoot, path }
          : null;
      if (!resource) return null;
      return {
        kind: "pdf",
        source: {
          ...common,
          environmentId: input.environmentId,
          resource,
          srcFragment: markdownImageSourceFragment(href),
          actionsSource: {
            ...(reference ? { reference } : {}),
            environmentId: input.environmentId,
            threadId: input.threadId,
            resource,
            name,
            mimeType: common.mimeType,
          },
        },
      };
    }
  }
  const media = resolveMobileMarkdownMediaSource(href, input);
  if (media === null || media.access === "unavailable") return null;
  if (input.captured && media.access !== "direct") return null;
  const { kind, name, mimeType, reference, srcFragment } = media;
  const target =
    media.access === "direct"
      ? { uri: normalizeNativeMarkdownUrl(media.uri) }
      : {
          environmentId: input.environmentId,
          resource: scopedResource(media.resource, input.scope),
          ...(srcFragment ? { srcFragment } : {}),
        };
  const actionsSource: MediaActionsSource =
    media.access === "direct"
      ? { reference, uri: media.uri, name, mimeType }
      : {
          reference,
          environmentId: input.environmentId,
          threadId: input.threadId,
          resource: scopedResource(media.resource, input.scope),
          name,
          mimeType,
        };
  return kind === "video"
    ? { kind, source: { type: "media", name, mimeType, ...target, actionsSource } }
    : { kind, source: { kind, name, ...target, actionsSource } };
}
