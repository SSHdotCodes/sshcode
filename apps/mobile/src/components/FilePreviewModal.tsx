import { useNavigation } from "@react-navigation/native";
import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useState,
  useSyncExternalStore,
  useMemo,
} from "react";
import { Alert, Keyboard } from "react-native";

import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";
import { useRefreshAssetUrl } from "../state/assets";
import {
  filePreviewGallery,
  filePreviewKey,
  filePreviewName,
  filePreviewResolutionWindow,
  isSvgPreview,
} from "../lib/filePreviewGallery";
import { FilePreviewGallery } from "./FilePreviewGallery";
import { FILE_PREVIEW_RESOLVES_LAZILY, FilePreview } from "./FilePreview";
import type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewSource,
} from "./FilePreviewModal.types";

export type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewSource,
} from "./FilePreviewModal.types";

function PreviewItemResolver(props: {
  readonly source: FilePreviewItem;
  readonly onResolved: (source: ResolvedFilePreviewSource) => void;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
  /** Set for gallery neighbours: their failure marks the page instead of closing the viewer. */
  readonly onUnavailable?: () => void;
}) {
  const { source } = props;
  const environmentId = "environmentId" in source ? source.environmentId : null;
  const refreshAssetUrl = useRefreshAssetUrl(
    environmentId,
    "resource" in source ? source.resource : null,
  );
  // Resolve once per presentation; background URL refreshes must not reopen the native viewer.
  const [uri, setUri] = useState<string | null>("uri" in source ? source.uri : null);
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onResolutionError = useEffectEvent((error: unknown, fallbackMessage: string) => {
    if (props.onUnavailable) return props.onUnavailable();
    if (props.onOpenError) props.onOpenError(error);
    else Alert.alert("Could not open preview", fallbackMessage);
    onRequestClose();
  });
  useEffect(() => Keyboard.dismiss(), []);
  useEffect(() => {
    if (environmentId === null || uri !== null) return;
    let cancelled = false;
    // A cached URL may have expired while the app was suspended. Await reauthorization
    // before handing a URL to Quick Look or ACTION_VIEW, which retain that URL.
    void refreshAssetUrl()
      .then((url) => {
        if (cancelled) return;
        if (!url) throw new Error("Reconnect to this environment and try again.");
        setUri(url + (source.srcFragment ?? ""));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        onResolutionError(
          error,
          "Reconnect to this environment and try again. The file may have been moved or deleted.",
        );
      });
    return () => {
      cancelled = true;
    };
  }, [environmentId, uri, refreshAssetUrl, source.srcFragment]);
  useEffect(() => {
    if (!("attachment" in source)) return;
    const controller = new AbortController();
    let release: (() => void) | undefined;
    void loadLocalAttachmentPreview(source.attachment, controller.signal)
      .then((file) => {
        if (!file) return;
        if (controller.signal.aborted) {
          file.dispose();
          return;
        }
        release = file.dispose;
        setUri(file.uri);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        onResolutionError(error, "Attach the file again and retry.");
      });
    return () => {
      controller.abort();
      release?.();
    };
  }, [source]);

  const onResolved = useEffectEvent(props.onResolved);
  useEffect(() => {
    if (uri !== null) onResolved({ ...source, name: filePreviewName(source), uri });
  }, [uri, source]);
  return null;
}

function ResolvedFilePreview(props: {
  readonly source: FilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
  readonly onRequestOlder?: (() => Promise<unknown>) | undefined;
  readonly historyStatus?: string | null | undefined;
}) {
  // Only the explicit chat collection grows while open. Other preview groups remain frozen.
  const collectItems = (source: FilePreviewSource) =>
    isSvgPreview(source)
      ? [source]
      : filePreviewGallery(source, []).filter((item) => item === source || !isSvgPreview(item));
  const [fixedItems] = useState(() => collectItems(props.source));
  const items = useMemo(
    () => (props.source.occurrenceId ? collectItems(props.source) : fixedItems),
    [props.source, fixedItems],
  );
  const selectedKey = filePreviewKey(props.source);
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => filePreviewKey(item) === selectedKey),
  );
  // A thread-wide gallery can hold many images: resolve the visible one and its
  // neighbours, then widen as the viewer pages. Resolved items stay mounted because
  // their resolvers own local preview files. Quick Look galleries need every file first.
  const [requestedKeys, setRequestedKeys] = useState(
    () =>
      new Set(
        (FILE_PREVIEW_RESOLVES_LAZILY
          ? filePreviewResolutionWindow(selectedIndex, items.length).map((index) => items[index]!)
          : items
        ).map(filePreviewKey),
      ),
  );
  const onIndexChange = useCallback(
    (index: number) => {
      setRequestedKeys((current) => {
        const window = filePreviewResolutionWindow(index, items.length).map((position) =>
          filePreviewKey(items[position]!),
        );
        return window.every((key) => current.has(key)) ? current : new Set([...current, ...window]);
      });
    },
    [items],
  );
  const [resolved, setResolved] = useState<Record<string, ResolvedFilePreviewSource>>({});
  const onResolved = useCallback((item: ResolvedFilePreviewSource, key: string) => {
    setResolved((current) => ({ ...current, [key]: item }));
  }, []);
  const [unavailableKeys, setUnavailableKeys] = useState<ReadonlySet<string>>(() => new Set());
  const onUnavailable = useCallback((key: string) => {
    setUnavailableKeys((current) => (current.has(key) ? current : new Set([...current, key])));
  }, []);
  const selected = resolved[selectedKey];
  const gallery = useMemo(
    () =>
      items.map((item) => {
        const key = filePreviewKey(item);
        const value = resolved[key];
        if (value) return value;
        const { gallery: _gallery, ...metadata } = item as FilePreviewSource;
        return {
          ...metadata,
          name: filePreviewName(item),
          uri: "",
          ...(unavailableKeys.has(key) ? { unavailable: true } : {}),
        };
      }),
    [items, resolved, unavailableKeys],
  );
  return (
    <>
      {items.map((item) => {
        const key = filePreviewKey(item);
        return requestedKeys.has(key) ? (
          <PreviewItemResolver
            key={key}
            source={item}
            onResolved={(value) => onResolved(value, key)}
            onRequestClose={props.onRequestClose}
            onOpenError={props.onOpenError}
            {...(key === selectedKey ? {} : { onUnavailable: () => onUnavailable(key) })}
          />
        ) : null;
      })}
      {selected &&
      (FILE_PREVIEW_RESOLVES_LAZILY ||
        gallery.every((item) => item.uri !== "" || "unavailable" in item)) ? (
        <FilePreview
          source={{ ...selected, gallery, galleryIndex: selectedIndex }}
          onIndexChange={onIndexChange}
          onRequestOlder={props.onRequestOlder}
          historyStatus={props.historyStatus}
          onRequestClose={props.onRequestClose}
          onOpenError={props.onOpenError}
        />
      ) : null}
    </>
  );
}

export function FilePreviewModal(props: {
  readonly source: FilePreviewSource | null;
  readonly onRequestClose: () => void;
  readonly onRequestOlder?: (() => Promise<unknown>) | undefined;
  readonly historyStatus?: string | null | undefined;
  /** Replaces the default alert when the platform cannot open the document. */
  readonly onOpenError?: (error: unknown) => void;
}) {
  const group = useContext(FilePreviewGallery);
  const source = useMemo(
    () =>
      props.source === null
        ? null
        : {
            ...props.source,
            gallery: filePreviewGallery(props.source, group),
          },
    [props.source, group],
  );
  const navigation = useNavigation();
  const subscribeToFocus = useCallback(
    (listener: () => void) => {
      const offFocus = navigation.addListener("focus", listener);
      const offBlur = navigation.addListener("blur", listener);
      return () => {
        offFocus();
        offBlur();
      };
    },
    [navigation],
  );
  // The v5 card host sits inside a legacy presentation envelope whose focus context
  // can describe a different route. The preview belongs to this navigation route.
  const isFocused = useSyncExternalStore(
    subscribeToFocus,
    navigation.isFocused,
    navigation.isFocused,
  );
  const hasSource = props.source !== null;
  const onRequestClose = useEffectEvent(props.onRequestClose);
  useEffect(() => {
    if (!isFocused && hasSource) onRequestClose();
  }, [isFocused, hasSource]);

  if (!source || !isFocused) return null;
  return (
    <ResolvedFilePreview
      key={filePreviewKey(source)}
      source={source}
      onRequestClose={props.onRequestClose}
      onRequestOlder={props.onRequestOlder}
      historyStatus={props.historyStatus}
      {...(props.onOpenError ? { onOpenError: props.onOpenError } : {})}
    />
  );
}
