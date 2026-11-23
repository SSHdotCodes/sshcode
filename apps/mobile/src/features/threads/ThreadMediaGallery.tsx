import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ThreadMediaItem } from "@t3tools/client-runtime/thread-media";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Image } from "expo-image";
import { useCallback, useMemo, useRef, useState } from "react";
import { FlatList, Modal, Pressable, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText } from "../../components/AppText";
import {
  FilePreviewModal,
  type FilePreviewItem,
  type FilePreviewSource,
} from "../../components/FilePreviewModal";
import { SymbolView } from "../../components/AppSymbol";
import { VideoThumbnailImage } from "../../components/VideoThumbnailImage";
import { useAssetUrl } from "../../state/assets";
import { threadMediaPageCommand } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

function sourceFor(
  item: ThreadMediaItem,
  environmentId: EnvironmentId,
  onShowInChat: (item: ThreadMediaItem) => void,
): FilePreviewItem {
  const common = {
    kind: item.kind,
    name: item.name,
    mimeType: item.mimeType,
    occurrenceId: item.id,
    onShowInChat: () => onShowInChat(item),
  };
  if (item.target.type === "url")
    return {
      ...common,
      uri: item.target.url,
      actionsSource: { uri: item.target.url, name: item.name, mimeType: item.mimeType },
    };
  const resource = item.target.resource;
  return {
    ...common,
    environmentId,
    resource,
    ...(item.target.srcFragment ? { srcFragment: item.target.srcFragment } : {}),
    actionsSource: {
      environmentId,
      resource,
      name: item.name,
      mimeType: item.mimeType,
      ...(item.original ? { original: { ...item.original, sentSize: item.sentSize } } : {}),
    },
  };
}

function Tile(props: {
  item: ThreadMediaItem;
  environmentId: EnvironmentId;
  size: number;
  onPress: () => void;
}) {
  const target = props.item.target;
  const asset = useAssetUrl(
    target.type === "asset" ? props.environmentId : null,
    target.type === "asset" ? target.resource : null,
  );
  const uri =
    target.type === "url" ? target.url : asset ? asset + (target.srcFragment ?? "") : null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${props.item.name}`}
      onPress={props.onPress}
      style={{
        width: props.size,
        height: props.size,
        margin: 2,
        backgroundColor: "#252525",
        overflow: "hidden",
        borderRadius: 8,
      }}
    >
      {uri && !props.item.unavailable ? (
        props.item.kind === "video" ? (
          <VideoThumbnailImage cacheKey={props.item.id} source={uri} />
        ) : (
          <Image source={{ uri }} style={{ width: "100%", height: "100%" }} contentFit="cover" />
        )
      ) : (
        <AppText className="p-2 text-xs text-white">
          {props.item.unavailable ? "Unavailable" : props.item.name}
        </AppText>
      )}
      {props.item.kind === "video" ? (
        <View className="absolute bottom-2 right-2">
          <SymbolView name="play" size={18} tintColor="#fff" type="monochrome" />
        </View>
      ) : null}
    </Pressable>
  );
}

export function ThreadMediaGallery(props: {
  items: readonly ThreadMediaItem[];
  environmentId: EnvironmentId;
  threadId: ThreadId;
  historyCursor: string | null;
  initialItems?: readonly ThreadMediaItem[];
  initialPartial?: boolean;
  onClose: () => void;
  onShowInChat: (item: ThreadMediaItem) => void;
}) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const [cursor, setCursor] = useState(props.historyCursor);
  const [older, setOlder] = useState<readonly ThreadMediaItem[]>(props.initialItems ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(props.initialPartial ?? false);
  const busy = useRef(false);
  const userScrolled = useRef(false);
  const list = useRef<FlatList<ThreadMediaItem>>(null);
  const positioned = useRef(false);
  const loadPage = useAtomCommand(threadMediaPageCommand, { reportFailure: false });
  const mediaItems = useMemo(() => {
    const loaded = new Set(props.items.map((item) => item.id));
    return [...older.filter((item) => !loaded.has(item.id)), ...props.items];
  }, [older, props.items]);
  const loadEarlier = useCallback(async () => {
    if (!cursor || busy.current) return;
    busy.current = true;
    setLoading(true);
    setError(null);
    const result = await loadPage({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, cursor },
    });
    busy.current = false;
    setLoading(false);
    if (result._tag === "Failure") {
      const cause = squashAtomCommandFailure(result);
      setError(
        typeof cause === "object" &&
          cause !== null &&
          "_tag" in cause &&
          cause._tag === "RemoteEnvironmentAuthUndeclaredStatusError" &&
          "status" in cause &&
          cause.status === 404
          ? "Older media needs a server update."
          : "Could not load earlier media. Try again.",
      );
      return;
    }
    if (result.value.partial) setPartial(true);
    setOlder((current) => [...result.value.items, ...current]);
    setCursor(result.value.nextCursor);
  }, [cursor, loadPage, props.environmentId, props.threadId]);
  const items = useMemo(
    () =>
      mediaItems.map((item) =>
        sourceFor(item, props.environmentId, (selected) => {
          setPreview(null);
          props.onShowInChat(selected);
        }),
      ),
    [mediaItems, props.environmentId, props.onShowInChat],
  );
  const size = Math.max(1, (width - 20) / 3);
  return (
    <Modal
      visible
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={props.onClose}
    >
      <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
        <View className="min-h-14 flex-row items-center px-4">
          <AppText className="flex-1 font-t3-semibold text-lg text-foreground">Media</AppText>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close media"
            onPress={props.onClose}
            className="p-3"
          >
            <SymbolView name="xmark" size={18} type="monochrome" />
          </Pressable>
        </View>
        {partial ? (
          <AppText className="p-2 text-center text-sm text-foreground-muted">
            Some older media is unavailable in this gallery.
          </AppText>
        ) : null}
        <FlatList
          ref={list}
          data={mediaItems}
          numColumns={3}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onContentSizeChange={() => {
            if (!positioned.current && mediaItems.length) {
              positioned.current = true;
              list.current?.scrollToEnd({ animated: false });
            }
          }}
          onScrollBeginDrag={() => {
            userScrolled.current = true;
          }}
          onScroll={(event) => {
            if (userScrolled.current && event.nativeEvent.contentOffset.y < 64) {
              userScrolled.current = false;
              void loadEarlier();
            }
          }}
          scrollEventThrottle={32}
          ListHeaderComponent={
            cursor ? (
              <Pressable
                disabled={loading}
                accessibilityRole="button"
                onPress={() => void loadEarlier()}
                className="items-center p-3"
              >
                <AppText className="text-sm text-foreground-muted">
                  {loading ? "Loading…" : (error ?? "Load earlier media")}
                </AppText>
              </Pressable>
            ) : undefined
          }
          ListEmptyComponent={
            <AppText className="p-4 text-center text-foreground-muted">
              No media in the loaded history.
            </AppText>
          }
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 4, paddingBottom: insets.bottom + 12 }}
          renderItem={({ item, index }) => (
            <Tile
              item={item}
              environmentId={props.environmentId}
              size={size}
              onPress={() => {
                const selected = items[index];
                if (selected) setPreview({ ...selected, gallery: items });
              }}
            />
          )}
        />
        <FilePreviewModal
          source={preview ? { ...preview, gallery: items } : null}
          onRequestClose={() => setPreview(null)}
          onRequestOlder={cursor ? loadEarlier : undefined}
          historyStatus={
            loading
              ? "Loading earlier media…"
              : (error ?? (partial ? "Some older media is unavailable." : null))
          }
        />
      </View>
    </Modal>
  );
}
