import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  threadMediaOriginalResource,
  type ThreadMediaItem,
} from "@t3tools/client-runtime/thread-media";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { FilmIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useDesktopMedia } from "../media/useDesktopMedia";
import { useAssetUrlState } from "../../assets/assetUrls";
import { threadMediaPageCommand } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { buildThreadMediaPreview } from "./ExpandedImagePreview";
import { ExpandedImageDialog } from "./ExpandedImageDialog";

function Tile(props: { item: ThreadMediaItem; environmentId: EnvironmentId; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const target = props.item.target;
  const actionSource = useMemo(() => {
    const originalResource = threadMediaOriginalResource(props.item);
    return {
      kind: props.item.kind,
      name: props.item.name,
      src: target.type === "url" ? target.url : null,
      ...(target.type === "asset"
        ? { asset: { environmentId: props.environmentId, resource: target.resource } }
        : {}),
      ...(props.item.original && originalResource
        ? {
            original: {
              ...props.item.original,
              src: null,
              asset: { environmentId: props.environmentId, resource: originalResource },
              ...(props.item.sentSize ? { sentSize: props.item.sentSize } : {}),
            },
          }
        : {}),
    };
  }, [props.item, target, props.environmentId]);
  const desktop = useDesktopMedia(actionSource, props.item.mimeType);
  const asset = useAssetUrlState(
    visible && target.type === "asset" ? props.environmentId : null,
    visible && target.type === "asset" ? target.resource : null,
  );
  const src = !visible
    ? null
    : target.type === "url"
      ? target.url
      : asset._tag === "Success"
        ? asset.url + (target.srcFragment ?? "")
        : null;
  return (
    <button
      ref={ref}
      type="button"
      onClick={props.onOpen}
      draggable={desktop.enabled}
      onDragStart={desktop.onDragStart}
      onMouseEnter={() => {
        if (desktop.enabled) void desktop.prepare();
      }}
      onFocus={() => {
        if (desktop.enabled) void desktop.prepare();
      }}
      onMouseLeave={desktop.cancelPreparation}
      onBlur={desktop.cancelPreparation}
      onKeyDown={desktop.onKeyDown}
      aria-label={
        desktop.enabled
          ? `Open ${props.item.name}; drag out or press Space for Quick Look`
          : `Open ${props.item.name}`
      }
      className="relative aspect-square overflow-hidden rounded-lg bg-muted focus-visible:outline-2 focus-visible:outline-ring"
    >
      {src && !props.item.unavailable && !failed ? (
        props.item.kind === "video" ? (
          <video
            src={src}
            muted
            playsInline
            preload="metadata"
            onError={() => setFailed(true)}
            className="size-full object-cover"
          />
        ) : (
          <img
            src={src}
            alt=""
            loading="lazy"
            onError={() => setFailed(true)}
            className="size-full object-cover"
          />
        )
      ) : null}
      {desktop.status === "loading" ? (
        <span className="absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-xs text-white">
          Preparing…
        </span>
      ) : null}
      {desktop.error ? (
        <span className="absolute bottom-0 left-0 right-0 bg-black/75 p-2 text-xs text-white">
          {desktop.error}
        </span>
      ) : null}
      {props.item.kind === "video" ? (
        <FilmIcon aria-hidden className="absolute bottom-2 right-2 size-5 text-white drop-shadow" />
      ) : null}
      {!src || props.item.unavailable || failed ? (
        <span className="absolute inset-0 grid place-items-center p-2 text-xs text-muted-foreground">
          {failed || props.item.unavailable ? "Media unavailable" : props.item.name}
        </span>
      ) : null}
    </button>
  );
}

export function ThreadMediaGallery(props: {
  readonly items: readonly ThreadMediaItem[];
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly historyCursor: string | null;
  readonly initialItems?: readonly ThreadMediaItem[];
  readonly initialPartial?: boolean;
  readonly onClose: () => void;
  readonly onShowInChat: (item: ThreadMediaItem) => void;
}) {
  const loadPage = useAtomCommand(threadMediaPageCommand, { reportFailure: false });
  const [cursor, setCursor] = useState(props.historyCursor);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [older, setOlder] = useState<readonly ThreadMediaItem[]>(props.initialItems ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState(props.initialPartial ?? false);
  const busy = useRef(false);
  const grid = useRef<HTMLDivElement>(null);
  const scrollAnchor = useRef<{ height: number; top: number } | null>(null);
  const userScrolled = useRef(false);
  const items = useMemo(() => {
    const loaded = new Set(props.items.map((item) => item.id));
    return [...older.filter((item) => !loaded.has(item.id)), ...props.items];
  }, [older, props.items]);
  const loadEarlier = async () => {
    if (!cursor || busy.current) return null;
    busy.current = true;
    setLoading(true);
    setError(null);
    let nextCursor: string | null = cursor;
    while (nextCursor) {
      const result = await loadPage({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, cursor: nextCursor },
      });
      if (result._tag === "Failure") {
        busy.current = false;
        setLoading(false);
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
        return null;
      }
      if (result.value.partial) setPartial(true);
      nextCursor = result.value.nextCursor;
      setCursor(nextCursor);
      if (result.value.items.length) {
        if (grid.current)
          scrollAnchor.current = { height: grid.current.scrollHeight, top: grid.current.scrollTop };
        setOlder((current) => [...result.value.items, ...current]);
        busy.current = false;
        setLoading(false);
        return result.value.items.at(-1)?.id ?? null;
      }
    }
    busy.current = false;
    setLoading(false);
    return null;
  };
  useLayoutEffect(() => {
    if (grid.current && scrollAnchor.current) {
      grid.current.scrollTop =
        scrollAnchor.current.top + grid.current.scrollHeight - scrollAnchor.current.height;
      scrollAnchor.current = null;
    }
  }, [older]);
  useEffect(() => {
    if (grid.current) grid.current.scrollTop = grid.current.scrollHeight;
  }, []);
  const selectedIndex =
    selectedId === null ? -1 : items.findIndex((item) => item.id === selectedId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="flex max-h-[85vh] w-[min(90vw,56rem)] flex-col">
        <DialogHeader>
          <DialogTitle>Media</DialogTitle>
        </DialogHeader>
        <div
          ref={grid}
          className="min-h-0 overflow-y-auto px-6 pb-6"
          onWheel={(event) => {
            userScrolled.current = true;
            if (event.deltaY < 0 && event.currentTarget.scrollTop < 64) {
              userScrolled.current = false;
              void loadEarlier();
            }
          }}
          onTouchStart={() => {
            userScrolled.current = true;
          }}
          onScroll={(event) => {
            if (userScrolled.current && event.currentTarget.scrollTop < 64) {
              userScrolled.current = false;
              void loadEarlier();
            }
          }}
        >
          {cursor ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadEarlier()}
              className="w-full p-3 text-sm text-muted-foreground"
            >
              {loading ? "Loading…" : (error ?? "Load earlier media")}
            </button>
          ) : null}
          {partial ? (
            <p className="p-2 text-center text-sm text-muted-foreground">
              Some older media is unavailable in this gallery.
            </p>
          ) : null}
          {items.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              No media in the loaded history.
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {items.map((item, index) => (
              <Tile
                key={item.id}
                item={item}
                environmentId={props.environmentId}
                onOpen={() => setSelectedId(items[index]?.id ?? null)}
              />
            ))}
          </div>
        </div>
      </DialogPopup>
      {selectedIndex >= 0 ? (
        <ExpandedImageDialog
          preview={buildThreadMediaPreview(
            items,
            props.environmentId,
            selectedIndex,
            props.onShowInChat,
          )}
          onClose={() => setSelectedId(null)}
          onRequestOlder={cursor ? loadEarlier : undefined}
          historyStatus={
            loading
              ? "Loading earlier media…"
              : (error ?? (partial ? "Some older media is unavailable." : null))
          }
        />
      ) : null}
    </Dialog>
  );
}
