import { turnItemOutputImages } from "@t3tools/client-runtime/work-log/item-detail";
import { resolveViewedImageAsset } from "@t3tools/client-runtime/work-log/presentation";
import type { AssetResource, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import { useCallback, useEffect, useEffectEvent, useState } from "react";

import type { FilePreviewSource } from "../../components/FilePreviewModal";
import { resolveMarkdownMediaPreview } from "../../lib/markdownMedia";
import { type ThreadFeedActivity, workEntryRowLabel } from "../../lib/threadActivity";
import { useTurnItemDetail } from "../../state/queries";
import {
  ThreadImageStrip,
  type ThreadImageStripItem,
  WORK_IMAGE_STRIP_HEIGHT,
} from "./ThreadImageStrip";
import { workGroupImageSources } from "./workLogImages";

type ToolOutputImageResource = Extract<AssetResource, { readonly _tag: "tool-output-image" }>;

interface ToolOutputImageEntry {
  readonly resource: ToolOutputImageResource;
  readonly mimeType: string;
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** Learns how many images one tool call returned. Its detail is the same query the expanded row reads. */
function ToolOutputImageProbe(props: {
  readonly environmentId: EnvironmentId;
  readonly activity: ThreadFeedActivity;
  readonly onImages: (activityId: string, images: ReadonlyArray<ToolOutputImageEntry>) => void;
}) {
  const detail = useTurnItemDetail({
    environmentId: props.environmentId,
    row: props.activity.projectedItem,
  });
  const item = detail.data?.item ?? null;
  const settled = detail.data !== null || detail.error !== null;
  const onImages = useEffectEvent(props.onImages);
  useEffect(() => {
    if (!settled) return;
    const mimeTypes =
      item?.type === "dynamic_tool"
        ? toolOutputImages(item.output).map((image) => image.mimeType)
        : [];
    onImages(
      props.activity.id,
      item
        ? turnItemOutputImages(item).map((resource, index) => ({
            resource,
            mimeType: mimeTypes[index] ?? "image/png",
          }))
        : [],
    );
  }, [item, settled, props.activity.id]);
  return null;
}

/**
 * Pictures a work group's tool calls produced, shown under its collapsed row as they
 * arrive. Viewed image files need no fetch; likely image tools load their detail once.
 */
export function ThreadWorkImageStrip(props: {
  readonly activities: ReadonlyArray<ThreadFeedActivity>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null | undefined;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const sources = workGroupImageSources(props.activities);
  const [outputs, setOutputs] = useState<
    Readonly<Record<string, ReadonlyArray<ToolOutputImageEntry>>>
  >({});
  const onImages = useCallback(
    (activityId: string, images: ReadonlyArray<ToolOutputImageEntry>) =>
      setOutputs((current) => ({ ...current, [activityId]: images })),
    [],
  );
  if (sources.length === 0) return null;

  const items = sources.flatMap((source): ThreadImageStripItem[] => {
    const { activity } = source;
    const label = workEntryRowLabel(activity.workEntry);
    if (source.kind === "viewed") {
      const viewed = resolveViewedImageAsset(source.path, {
        threadId: props.threadId,
        workspaceRoot: props.workspaceRoot,
      });
      if (!viewed) return [];
      const actionsSource = resolveMarkdownMediaPreview(source.path, {
        environmentId: props.environmentId,
        threadId: props.threadId,
        workspaceRoot: props.workspaceRoot,
        imageEmbed: true,
      })?.source.actionsSource;
      return [
        {
          key: `viewed:${activity.id}`,
          name: viewed.alt || label,
          preview: {
            kind: "image",
            name: viewed.alt || label,
            environmentId: props.environmentId,
            resource: viewed.resource,
            srcFragment: viewed.srcFragment,
          },
          actionsSource:
            actionsSource && "resource" in actionsSource
              ? { ...actionsSource, resource: viewed.resource }
              : undefined,
        },
      ];
    }
    const images = outputs[activity.id];
    if (images === undefined) return [{ key: `pending:${activity.id}`, pending: true }];
    return images.map(({ resource, mimeType }, index) => {
      const name = images.length > 1 ? `${label} (${index + 1})` : label;
      return {
        key: `output:${activity.id}:${resource.index}`,
        name,
        preview: { kind: "image", name, environmentId: props.environmentId, resource },
        actionsSource: {
          environmentId: props.environmentId,
          threadId: resource.threadId,
          resource,
          name: `tool-image-${index + 1}.${IMAGE_EXTENSIONS[mimeType] ?? "png"}`,
          mimeType,
        },
      };
    });
  });

  return (
    <>
      {sources.map((source) =>
        source.kind === "tool-output" ? (
          <ToolOutputImageProbe
            key={source.activity.id}
            environmentId={props.environmentId}
            activity={source.activity}
            onImages={onImages}
          />
        ) : null,
      )}
      {items.length > 0 ? (
        <ThreadImageStrip
          items={items}
          height={WORK_IMAGE_STRIP_HEIGHT}
          onPressPreview={props.onPressPreview}
          ownGallery
          className="mb-1.5 ml-8 mt-1"
        />
      ) : null}
    </>
  );
}
