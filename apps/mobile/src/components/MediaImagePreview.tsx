import { imageAttachmentOriginalCaption } from "@t3tools/client-runtime/image-attachment-size";
import { imageMimeType } from "@t3tools/shared/image";
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  FlatList,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  View,
  useWindowDimensions,
  type ScrollViewInstance,
} from "react-native";
import ImageViewing from "react-native-image-viewing";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import type { MediaActionsSource } from "../lib/mediaActionsSource";
import { useMediaActions, type MobileMediaActionId } from "../state/mediaActions";
import { AppText } from "./AppText";
import { SymbolView, type AppSymbolName } from "./AppSymbol";
import type { ResolvedFilePreviewSource } from "./FilePreviewModal.types";
import { MediaActionsMenu } from "./MediaActionsMenu";
import { MediaSourceCaption } from "./MediaSourceCaption";

import { ImageMarkupEditor } from "./ImageMarkupEditor";
import { MediaVideoPlayer } from "./MediaVideoPlayer";

type GalleryItem = NonNullable<ResolvedFilePreviewSource["gallery"]>[number];

// A transparent pixel holds a page whose URL is still being authorized.
const PENDING_IMAGE_URI =
  "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

/** Actions shown as toolbar buttons; the rest stay in the header menu. */
const TOOLBAR_ACTIONS: ReadonlySet<MobileMediaActionId> = new Set([
  "save",
  "save-to-photos",
  "copy-image",
]);

const SHARE_SYMBOL: AppSymbolName =
  Platform.OS === "ios" ? { ios: "square.and.arrow.up", android: "public" } : "tray.and.arrow.up";
const SAVE_SYMBOL: AppSymbolName = { ios: "square.and.arrow.down", android: "public" };

/** Composer drafts and tool images carry no authored source; act on the resolved file. */
function viewerActionsSource(item: GalleryItem | undefined): MediaActionsSource | undefined {
  if (item?.actionsSource) return item.actionsSource;
  if (!item?.uri) return undefined;
  const name = item.name ?? "Image";
  return {
    uri: item.uri,
    name,
    mimeType: item.mimeType ?? imageMimeType({ name, mimeType: "" }) ?? "image/*",
  };
}

interface ImageViewerState {
  readonly onMarkup: () => void;
  readonly index: number;
  readonly historyStatus?: string | null | undefined;
  readonly markupAvailable: boolean;
  readonly items: readonly GalleryItem[];
  readonly media: ReturnType<typeof useMediaActions>;
  readonly onRequestClose: () => void;
}

const ImageViewerContext = createContext<ImageViewerState | null>(null);

function ImageViewerHeader(props: { readonly imageIndex: number }) {
  const viewer = useContext(ImageViewerContext)!;
  const insets = useSafeAreaInsets();
  const item = viewer.items[props.imageIndex];
  const originalCaption = imageAttachmentOriginalCaption(item?.actionsSource?.original ?? {});
  const menuActions = viewer.media.actions.filter(({ id }) => !TOOLBAR_ACTIONS.has(id));
  const position =
    viewer.items.length > 1 ? `${props.imageIndex + 1} of ${viewer.items.length}` : null;
  return (
    <View className="bg-black/60" style={{ paddingTop: insets.top }}>
      <View className="min-h-12 flex-row items-center gap-1 px-1.5">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close image"
          onPress={viewer.onRequestClose}
          hitSlop={4}
          className="min-h-11 min-w-11 items-center justify-center rounded-full active:bg-white/15"
        >
          <SymbolView name="xmark" size={18} tintColor="#ffffff" type="monochrome" />
        </Pressable>
        <View className="min-w-0 flex-1 items-center">
          <AppText className="font-t3-medium text-sm text-white" numberOfLines={1}>
            {item?.name ?? "Image"}
          </AppText>
          {originalCaption ? (
            <AppText className="text-center text-2xs text-white/65" numberOfLines={2}>
              {originalCaption}
            </AppText>
          ) : null}
          {position || item?.unavailable ? (
            <AppText className="text-xs tabular-nums text-white/70" numberOfLines={1}>
              {[position, item?.unavailable ? "Unavailable" : null].filter(Boolean).join(" · ")}
            </AppText>
          ) : null}
        </View>
        {menuActions.length > 0 ? (
          <MediaActionsMenu media={{ ...viewer.media, actions: menuActions }} inModal />
        ) : (
          <View className="min-w-11" />
        )}
      </View>
      <MediaSourceCaption source={viewer.media.title} />
      {viewer.historyStatus ? (
        <AppText accessibilityRole="text" className="px-4 pb-1 text-center text-xs text-white/70">
          {viewer.historyStatus}
        </AppText>
      ) : null}
    </View>
  );
}

function ImageViewerToolbarButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly disabled?: boolean | undefined;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled ?? false }}
      disabled={props.disabled}
      onPress={props.onPress}
      className="min-h-12 min-w-20 items-center justify-center gap-1 rounded-xl px-3 py-1.5 active:bg-white/15 disabled:opacity-40"
    >
      <SymbolView name={props.icon} size={21} tintColor="#ffffff" type="monochrome" />
      <AppText className="text-xs text-white">{props.label}</AppText>
    </Pressable>
  );
}

function ImageViewerToolbar() {
  const viewer = useContext(ImageViewerContext)!;
  const insets = useSafeAreaInsets();
  const { media } = viewer;
  const action = (id: MobileMediaActionId) => media.actions.find((entry) => entry.id === id);
  const share = action("save");
  const save = action("save-to-photos");
  const copy = action("copy-image");
  const showInChat = viewer.items[viewer.index]?.onShowInChat;
  if (!share && !save && !copy && !viewer.markupAvailable && !showInChat) return null;
  return (
    <View className="bg-black/60" style={{ paddingBottom: Math.max(insets.bottom, 12) }}>
      <View className="flex-row flex-wrap items-center justify-center gap-1 pt-2">
        {showInChat ? (
          <ImageViewerToolbarButton icon="text.bubble" label="Show in chat" onPress={showInChat} />
        ) : null}
        {viewer.markupAvailable && (
          <ImageViewerToolbarButton icon="pencil" label="Markup" onPress={viewer.onMarkup} />
        )}
        {share ? (
          <ImageViewerToolbarButton
            icon={SHARE_SYMBOL}
            label={media.busy === "share" ? "Opening…" : "Share"}
            disabled={share.disabled}
            onPress={share.run}
          />
        ) : null}
        {save ? (
          <ImageViewerToolbarButton
            icon={media.feedback === "saved" ? "checkmark" : SAVE_SYMBOL}
            label={
              media.busy === "save-to-photos"
                ? "Saving…"
                : media.feedback === "saved"
                  ? "Saved"
                  : "Save to Photos"
            }
            disabled={save.disabled}
            onPress={save.run}
          />
        ) : null}
        {copy ? (
          <ImageViewerToolbarButton
            icon={media.feedback === "copied" ? "checkmark" : "doc.on.doc"}
            label={
              media.busy === "copy-image"
                ? "Copying…"
                : media.feedback === "copied"
                  ? "Copied"
                  : "Copy"
            }
            disabled={copy.disabled}
            onPress={copy.run}
          />
        ) : null}
      </View>
    </View>
  );
}

/**
 * Full-screen image viewer: swipe between the gallery's images, pinch or double-tap to
 * zoom, swipe down to dismiss, and save, share or copy the image on screen.
 */
export function MediaImagePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
  /** Reports the page on screen so the caller can resolve its neighbours. */
  readonly onIndexChange?: (index: number) => void;
  readonly onRequestOlder?: (() => Promise<unknown>) | undefined;
  readonly historyStatus?: string | null | undefined;
}) {
  const items = props.source.gallery ?? [props.source];
  // The viewer remounts its modal whenever `imageIndex` changes, so it only ever
  // receives the opening position; paging is tracked separately.
  const [initialIndex] = useState(() => {
    const index =
      props.source.galleryIndex ?? items.findIndex(({ uri }) => uri === props.source.uri);
    return Math.min(Math.max(0, index), items.length - 1);
  });
  const [fallbackIndex, setFallbackIndex] = useState(initialIndex);
  const [activeOccurrence, setActiveOccurrence] = useState(
    () => items[initialIndex]?.occurrenceId ?? null,
  );
  const occurrenceIndex =
    activeOccurrence === null
      ? -1
      : items.findIndex((item) => item.occurrenceId === activeOccurrence);
  const index = occurrenceIndex >= 0 ? occurrenceIndex : fallbackIndex;
  const setIndex = (next: number) => {
    setFallbackIndex(next);
    setActiveOccurrence(items[next]?.occurrenceId ?? null);
    props.onIndexChange?.(next);
  };
  useEffect(() => {
    props.onIndexChange?.(index);
  }, [index, props.onIndexChange]);
  useEffect(() => {
    if (index === 0 && props.onRequestOlder) void props.onRequestOlder();
  }, [index, props.onRequestOlder]);
  const [openingIndex, setOpeningIndex] = useState(initialIndex);
  const [markup, setMarkup] = useState<GalleryItem | null>(null);
  const media = useMediaActions(viewerActionsSource(items[index]), props.onRequestClose);
  const images = useMemo(
    () => items.map(({ uri }) => ({ uri: uri || PENDING_IMAGE_URI })),
    [items],
  );
  const { onRequestClose } = props;
  const viewer = useMemo(
    () => ({
      items,
      index,
      historyStatus: props.historyStatus,
      media,
      onRequestClose,
      markupAvailable:
        items[index]?.kind === "image" &&
        !!items[index]?.uri &&
        !(items[index] && "unavailable" in items[index] && items[index].unavailable) &&
        media.actions.some((action) => action.id === "save" && !action.disabled),
      onMarkup: () => {
        const item = items[index];
        if (item?.uri) setMarkup(item);
      },
    }),
    [items, index, media, onRequestClose, props.historyStatus],
  );
  if (markup)
    return (
      <ImageMarkupEditor
        source={markup}
        onClose={onRequestClose}
        onCancel={() => {
          setOpeningIndex(index);
          setMarkup(null);
        }}
      />
    );
  if (items.some((item) => item.kind === "video" || item.occurrenceId !== undefined)) {
    return (
      <ImageViewerContext value={viewer}>
        <MixedMediaPager
          items={items}
          initialIndex={index}
          index={index}
          onIndexChange={(next) => {
            setIndex(next);
          }}
          onRequestClose={onRequestClose}
        />
      </ImageViewerContext>
    );
  }
  return (
    <ImageViewerContext value={viewer}>
      <StatusBar barStyle="light-content" animated />
      <ImageViewing
        images={images}
        keyExtractor={(image, position) =>
          `${position}:${typeof image === "number" ? image : image.uri}`
        }
        imageIndex={openingIndex}
        onImageIndexChange={(next) => {
          setIndex(next);
        }}
        visible
        presentationStyle="fullScreen"
        onRequestClose={props.onRequestClose}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
        HeaderComponent={ImageViewerHeader}
        FooterComponent={ImageViewerToolbar}
      />
    </ImageViewerContext>
  );
}

function MixedMediaPager(props: {
  readonly items: readonly GalleryItem[];
  readonly initialIndex: number;
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onRequestClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const list = useRef<FlatList<GalleryItem>>(null);
  const first = props.items[0]?.occurrenceId;
  const previousFirst = useRef(first);
  useLayoutEffect(() => {
    if (first === previousFirst.current) return;
    previousFirst.current = first;
    const frame = requestAnimationFrame(() =>
      list.current?.scrollToIndex({ index: props.index, animated: false }),
    );
    return () => cancelAnimationFrame(frame);
  }, [first, props.index]);
  return (
    <Modal visible presentationStyle="fullScreen" onRequestClose={props.onRequestClose}>
      <View style={{ flex: 1, backgroundColor: "black" }}>
        <StatusBar barStyle="light-content" animated />
        <FlatList
          ref={list}
          horizontal
          pagingEnabled
          data={props.items}
          initialScrollIndex={props.initialIndex}
          getItemLayout={(_, index) => ({ length: width, offset: width * index, index })}
          keyExtractor={(item, index) => item.occurrenceId ?? `${index}:${item.uri}`}
          showsHorizontalScrollIndicator={false}
          onMomentumScrollEnd={(event) =>
            props.onIndexChange(
              Math.max(
                0,
                Math.min(
                  props.items.length - 1,
                  Math.round(event.nativeEvent.contentOffset.x / width),
                ),
              ),
            )
          }
          renderItem={({ item, index }) => (
            <View style={{ width, height, justifyContent: "center" }}>
              {item.kind === "video" ? (
                index === props.index ? (
                  <MediaVideoPlayer
                    uri={item.uri || null}
                    name={item.name ?? "Video"}
                    thumbnailKey={item.occurrenceId ?? item.uri}
                    unavailable={item.unavailable}
                    actionsSource={item.actionsSource}
                    expanded
                    startWithPoster
                  />
                ) : null
              ) : (
                <MixedImagePage item={item} width={width} height={height} />
              )}
            </View>
          )}
        />
        <View style={{ position: "absolute", top: 0, left: 0, right: 0 }}>
          <ImageViewerHeader imageIndex={props.index} />
        </View>
        <View style={{ position: "absolute", bottom: 0, left: 0, right: 0 }}>
          <ImageViewerToolbar />
        </View>
      </View>
    </Modal>
  );
}

function MixedImagePage(props: {
  readonly item: GalleryItem;
  readonly width: number;
  readonly height: number;
}) {
  const scroll = useRef<ScrollViewInstance>(null);
  const lastTap = useRef<{ time: number; x: number; y: number } | null>(null);
  const zoomed = useRef(false);
  return (
    <ScrollView
      ref={scroll}
      contentContainerStyle={{ flexGrow: 1, justifyContent: "center" }}
      maximumZoomScale={4}
      minimumZoomScale={1}
      centerContent
      onTouchEnd={(event) => {
        if (Platform.OS !== "ios") return;
        const { locationX: x, locationY: y } = event.nativeEvent;
        const previous = lastTap.current;
        const time = event.timeStamp;
        lastTap.current = { time, x, y };
        if (
          !previous ||
          time - previous.time > 300 ||
          Math.hypot(x - previous.x, y - previous.y) > 32
        )
          return;
        lastTap.current = null;
        zoomed.current = !zoomed.current;
        scroll.current?.scrollResponderZoomTo(
          zoomed.current
            ? {
                x: Math.max(0, x - props.width / 4),
                y: Math.max(0, y - props.height / 4),
                width: props.width / 2,
                height: props.height / 2,
                animated: true,
              }
            : { x: 0, y: 0, width: props.width, height: props.height, animated: true },
        );
      }}
    >
      {props.item.uri ? (
        <Image
          source={{ uri: props.item.uri }}
          resizeMode="contain"
          style={{ width: props.width, height: props.height }}
        />
      ) : (
        <AppText className="text-center text-white">
          {props.item.unavailable ? "Image unavailable" : "Loading…"}
        </AppText>
      )}
    </ScrollView>
  );
}
