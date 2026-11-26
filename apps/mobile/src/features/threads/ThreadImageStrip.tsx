import { Image as ExpoImage } from "expo-image";
import { useId, useMemo, useState } from "react";
import { FlatList, Pressable, StyleSheet, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { AppActivityIndicator } from "../../components/AppActivityIndicator";
import { FilePreviewGallery, useFilePreviewGallery } from "../../components/FilePreviewGallery";
import type { FilePreviewItem, FilePreviewSource } from "../../components/FilePreviewModal";
import { MediaActionFeedbackBadge, MediaActionsMenu } from "../../components/MediaActionsMenu";
import { assetImageSource } from "../../lib/assetImageSource";
import type { MediaActionsSource } from "../../lib/mediaActionsSource";
import { useAssetUrlState } from "../../state/assets";
import { useMediaActions } from "../../state/mediaActions";

/** Thumbnail heights. Fixed so a strip never changes its row's height as images load. */
export const MESSAGE_IMAGE_STRIP_HEIGHT = 150;
export const WORK_IMAGE_STRIP_HEIGHT = 120;

const THUMBNAIL_RADIUS = 12;
const THUMBNAIL_GAP = 8;
// Every tile has this one shape, cropped to the middle, so a strip never reflows as
// pictures decode or as new ones arrive while the agent is still reading them.
const TILE_ASPECT_RATIO = 4 / 3;

export type ThreadImageStripItem =
  | {
      readonly key: string;
      readonly name: string;
      readonly preview: FilePreviewItem;
      readonly actionsSource?: MediaActionsSource | undefined;
    }
  /** Reserves a tile while a tool call's images are still being counted. */
  | { readonly key: string; readonly pending: true }
  | { readonly key: string; readonly unavailable: true; readonly name: string };

type LoadedStripItem = Extract<ThreadImageStripItem, { readonly preview: FilePreviewItem }>;

export function stripTileWidth(height: number) {
  return Math.round(height * TILE_ASPECT_RATIO);
}

function ThumbnailPlaceholder(props: { readonly height: number; readonly label?: string }) {
  return (
    <View
      className="items-center justify-center gap-1 border border-border bg-subtle px-2"
      style={{
        width: stripTileWidth(props.height),
        height: props.height,
        borderRadius: THUMBNAIL_RADIUS,
      }}
    >
      <SymbolView
        name="photo"
        size={20}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
      />
      {props.label ? (
        <Text className="text-center text-2xs text-foreground-muted" numberOfLines={2}>
          {props.label}
        </Text>
      ) : null}
    </View>
  );
}

function ThreadImageThumbnail(props: {
  readonly item: LoadedStripItem;
  readonly height: number;
  readonly onPressPreview: (source: FilePreviewSource) => void;
}) {
  const { item } = props;
  const withGallery = useFilePreviewGallery();
  const sourceIdentifier = useId();
  const media = useMediaActions(item.actionsSource);
  const hosted = "resource" in item.preview ? item.preview : null;
  const assetUrl = useAssetUrlState(hosted?.environmentId ?? null, hosted?.resource ?? null);
  const uri =
    "uri" in item.preview
      ? item.preview.uri
      : assetUrl._tag === "Success"
        ? assetUrl.url + (item.preview.srcFragment ?? "")
        : null;
  const [loaded, setLoaded] = useState(false);
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const unavailable =
    (uri !== null && failedUri === uri) || (hosted && assetUrl._tag === "Failure");
  const width = stripTileWidth(props.height);
  if (unavailable) {
    return <ThumbnailPlaceholder height={props.height} label="Image unavailable" />;
  }
  return (
    <MediaActionsMenu media={media}>
      <Pressable
        accessibilityRole="imagebutton"
        accessibilityLabel={item.name}
        accessibilityHint={
          media.actions.length > 0 ? "Touch and hold for media actions" : undefined
        }
        onPress={() =>
          props.onPressPreview(
            // Hosted pictures open from their resource; the viewer mints a fresh URL.
            withGallery({
              ...item.preview,
              name: item.name,
              sourceIdentifier,
              ...(item.actionsSource ? { actionsSource: item.actionsSource } : {}),
            }),
          )
        }
        className="overflow-hidden border border-border bg-subtle active:opacity-80"
        style={{ width, height: props.height, borderRadius: THUMBNAIL_RADIUS }}
      >
        {/* Until the picture has drawn: while its signed URL resolves and while its bytes
            arrive, so a slow link shows it is loading rather than an empty box. */}
        {uri === null || !loaded ? (
          <View style={StyleSheet.absoluteFill} className="items-center justify-center">
            <AppActivityIndicator />
          </View>
        ) : null}
        {uri === null ? null : (
          <ExpoImage
            source={hosted ? assetImageSource(hosted.environmentId, hosted.resource, uri) : { uri }}
            cachePolicy="memory-disk"
            enforceEarlyResizing
            contentFit="cover"
            transition={150}
            accessible={false}
            onLoad={() => setLoaded(true)}
            onError={() => setFailedUri(uri)}
            style={StyleSheet.absoluteFill}
          />
        )}
        <MediaActionFeedbackBadge feedback={media.feedback} />
      </Pressable>
    </MediaActionsMenu>
  );
}

/**
 * A horizontal row of rounded thumbnails for several images. Tapping one opens the
 * viewer on the enclosing gallery, or on the strip's own images with `ownGallery`.
 */
export function ThreadImageStrip(props: {
  readonly items: ReadonlyArray<ThreadImageStripItem>;
  readonly height: number;
  readonly onPressPreview: (source: FilePreviewSource) => void;
  readonly ownGallery?: boolean;
  readonly className?: string;
}) {
  const gallery = useMemo(
    () =>
      props.items.flatMap((item) =>
        "preview" in item
          ? [
              {
                ...item.preview,
                name: item.name,
                ...(item.actionsSource ? { actionsSource: item.actionsSource } : {}),
              },
            ]
          : [],
      ),
    [props.items],
  );
  const tileWidth = stripTileWidth(props.height);
  const strip = (
    <FlatList
      horizontal
      nestedScrollEnabled
      showsHorizontalScrollIndicator={false}
      className={props.className}
      style={{ flexGrow: 0 }}
      contentContainerStyle={{ gap: THUMBNAIL_GAP, height: props.height }}
      data={props.items}
      keyExtractor={(item) => item.key}
      getItemLayout={(_data, index) => ({
        length: tileWidth,
        offset: index * (tileWidth + THUMBNAIL_GAP),
        index,
      })}
      initialNumToRender={4}
      windowSize={5}
      renderItem={({ item }) =>
        "preview" in item ? (
          <ThreadImageThumbnail
            item={item}
            height={props.height}
            onPressPreview={props.onPressPreview}
          />
        ) : (
          <ThumbnailPlaceholder
            height={props.height}
            {...("unavailable" in item ? { label: "Image unavailable" } : {})}
          />
        )
      }
    />
  );
  return props.ownGallery ? (
    <FilePreviewGallery value={gallery}>{strip}</FilePreviewGallery>
  ) : (
    strip
  );
}
