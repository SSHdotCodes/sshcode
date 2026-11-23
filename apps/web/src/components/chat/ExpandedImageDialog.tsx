import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type KeyboardEvent,
} from "react";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  CopyIcon,
  DownloadIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { Image as ImageGlyph, Text as TextGlyph } from "lucide";
import { Button } from "../ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import type { ExpandedImageItem, ExpandedImagePreview } from "./ExpandedImagePreview";
import { resolveExternalWebLinkHost } from "./externalLinkContextMenu";
import { useAssetUrlRefresh, useAssetUrlState } from "../../assets/assetUrls";
import { OpenMediaLink } from "../media/OpenMediaLink";
import { MediaActionButtons, MediaActions, type MediaActionSource } from "../media/MediaActions";
import { MediaVideoPlayer } from "../media/MediaVideoPlayer";
import { useDesktopMedia } from "../media/useDesktopMedia";
import { isContextMenuOpen } from "../../contextMenuFallback";
import {
  SnapShotAccessibilityData,
  SnapShotContentsButton,
  snapShotAccessibilityDetails,
} from "./SnapShotAttachmentDetails";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ZoomableImage, type ZoomableImageHandle } from "./ZoomableImage";
import { composerFloatingLayerProps } from "./composerEventScope";
import { imageAttachmentOriginalCaption } from "@t3tools/client-runtime/image-attachment-size";

import { ImageMarkupEditor } from "./ImageMarkupEditor";

interface ExpandedImageDialogProps {
  preview: ExpandedImagePreview;
  onClose: () => void;
  onRequestOlder?: (() => Promise<string | null>) | undefined;
  historyStatus?: string | null | undefined;
}

const EXPANDED_MEDIA_STATE_CLASS_NAME =
  "flex aspect-auto h-48 min-h-0 w-[min(var(--media-width),32rem)] flex-col items-center justify-center gap-3 rounded-lg border border-border/70 bg-black p-6 text-center text-sm text-white shadow-2xl";

function ExpandedMediaFailure({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className={EXPANDED_MEDIA_STATE_CLASS_NAME}>
      {children}
    </div>
  );
}

function ExpandedVideo({ item }: { readonly item: ExpandedImageItem }) {
  const asset = item.actionsSource?.asset;
  const assetUrl = useAssetUrlState(asset?.environmentId ?? null, asset?.resource ?? null);
  const refreshAssetUrl = useAssetUrlRefresh(asset?.environmentId ?? null, asset?.resource ?? null);
  const src = asset
    ? assetUrl._tag === "Success"
      ? assetUrl.url + (item.srcFragment ?? "")
      : null
    : item.src;
  return (
    <MediaVideoPlayer
      src={src}
      label={item.name}
      sourceFailed={assetUrl._tag === "Failure"}
      originalUrl={item.originalUrl}
      preload="metadata"
      autoPlay={item.autoPlay ?? true}
      className="block max-h-[var(--media-height)] max-w-[var(--media-width)] text-center"
      videoClassName="aspect-auto max-h-[var(--media-height)] w-auto max-w-[var(--media-width)] rounded-lg border border-border/70 shadow-2xl"
      stateClassName={EXPANDED_MEDIA_STATE_CLASS_NAME}
      onRetry={asset ? refreshAssetUrl : undefined}
    />
  );
}

export const ExpandedImageDialog = memo(function ExpandedImageDialog({
  preview,
  onClose,
  onRequestOlder,
  historyStatus,
}: ExpandedImageDialogProps) {
  const [markup, setMarkup] = useState(false);
  const [imageOffset, setImageOffset] = useState(0);
  const [activeOccurrenceId, setActiveOccurrenceId] = useState(
    () => preview.images[preview.index]?.occurrenceId ?? null,
  );
  const [failedImageSrc, setFailedImageSrc] = useState<string | null>(null);
  const [accessibilityDetailsSrc, setAccessibilityDetailsSrc] = useState<string | null>(null);
  const zoomableImageRef = useRef<ZoomableImageHandle>(null);
  const [returnFocusTarget] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  // The offset accumulates without bound, so wrap it into range in both directions:
  // JavaScript `%` keeps the sign of the dividend, and a negative index blanks the dialog.
  const imageCount = preview.images.length;
  const occurrenceIndex =
    activeOccurrenceId === null
      ? -1
      : preview.images.findIndex((entry) => entry.occurrenceId === activeOccurrenceId);
  const index =
    occurrenceIndex >= 0
      ? occurrenceIndex
      : imageCount > 0
        ? (((preview.index + imageOffset) % imageCount) + imageCount) % imageCount
        : 0;
  const selectedItem = preview.images[index];
  const imageAsset =
    selectedItem?.type === "video" ? undefined : selectedItem?.actionsSource?.asset;
  const imageUrl = useAssetUrlState(
    imageAsset?.environmentId ?? null,
    imageAsset?.resource ?? null,
  );
  const item =
    selectedItem && selectedItem.src === null && imageUrl._tag === "Success"
      ? { ...selectedItem, src: imageUrl.url + (selectedItem.srcFragment ?? "") }
      : selectedItem;
  const source: MediaActionSource = item?.actionsSource ?? {
    kind: item?.type === "video" ? "video" : "image",
    name: item?.name ?? "Media",
    src: item?.src ?? null,
  };
  const openFile = source.onOpenFile;
  const actionsSource: MediaActionSource = openFile
    ? {
        ...source,
        onOpenFile: () => {
          openFile();
          onClose();
        },
      }
    : source;

  const desktopMedia = useDesktopMedia(actionsSource);

  const navigateImage = useCallback(
    (direction: -1 | 1) => {
      if (direction === -1 && index === 0 && onRequestOlder) {
        void onRequestOlder().then((id) => {
          if (id) setActiveOccurrenceId(id);
        });
        return;
      }
      const next = preview.images[(index + direction + imageCount) % imageCount];
      if (activeOccurrenceId !== null && next?.occurrenceId)
        setActiveOccurrenceId(next.occurrenceId);
      else setImageOffset((current) => current + direction);
    },
    [index, onRequestOlder, preview.images, imageCount, activeOccurrenceId],
  );

  // The element that opened the preview gets focus back on close. Without
  // this a close button click leaves focus on the unmounted dialog, and the
  // composer that owned the opener reads that as a blur and rests.
  const openerRef = useRef<Element | null>(null);
  useEffect(() => {
    openerRef.current = document.activeElement;
    return () => {
      const opener = openerRef.current;
      if (opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      markup ||
      event.defaultPrevented ||
      isContextMenuOpen() ||
      event.target instanceof HTMLVideoElement
    )
      return;
    if (zoomableImageRef.current?.pan(event.key)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (preview.images.length <= 1 && !onRequestOlder) return;
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      event.stopPropagation();
      navigateImage(-1);
      return;
    }
    if (event.key !== "ArrowRight") return;
    event.preventDefault();
    event.stopPropagation();
    navigateImage(1);
  };

  useEffect(() => {
    const onEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || isContextMenuOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      if (markup) setMarkup(false);
      else onClose();
    };
    window.addEventListener("keydown", onEscape, { capture: true });
    return () => window.removeEventListener("keydown", onEscape, { capture: true });
  }, [onClose, markup]);

  if (!item) return null;
  const mediaLabel = item.type === "video" ? "video" : "image";
  const originalCaption = imageAttachmentOriginalCaption(actionsSource.original ?? {});
  const openOriginalLink =
    item.originalUrl && resolveExternalWebLinkHost(item.originalUrl) !== null ? (
      <OpenMediaLink originalUrl={item.originalUrl} />
    ) : null;
  const accessibilityDetails = item.source ? snapShotAccessibilityDetails(item.source) : undefined;
  const showingAccessibilityDetails =
    Boolean(accessibilityDetails) && accessibilityDetailsSrc === item.src;
  const contentsLabel = showingAccessibilityDetails
    ? "Show screenshot"
    : accessibilityDetails?.format === "json"
      ? "Show accessibility JSON"
      : "Show extracted text";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup
        {...composerFloatingLayerProps}
        variant="media"
        showCloseButton={false}
        bottomStickOnMobile={false}
        className="row-start-1 h-full max-h-[92vh] w-[92vw] max-w-[92vw] items-center justify-center overflow-visible [--media-width:92vw] [--media-height:min(86vh,calc(100vh-160px))] sm:[--media-width:calc(92vw-96px)]"
        onKeyDown={onKeyDown}
        initialFocus={closeButtonRef}
        finalFocus={() => returnFocusTarget}
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <DialogTitle className="sr-only">Expanded {mediaLabel} preview</DialogTitle>
        {/* The stage keeps a fixed size, so the close button stays put whatever the media or caption. */}
        <Button
          type="button"
          ref={closeButtonRef}
          size="icon-sm"
          variant="media-close"
          className="absolute right-0 top-0 z-20"
          onClick={onClose}
          aria-label={`Close ${mediaLabel} preview`}
        >
          <XIcon />
        </Button>
        {!markup && (preview.images.length > 1 || onRequestOlder) && (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="left-0 top-auto bottom-0 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Previous media"
            onClick={() => navigateImage(-1)}
          >
            <ChevronLeftIcon className="size-5" />
          </Button>
        )}
        {markup ? (
          <ImageMarkupEditor
            item={item}
            source={actionsSource}
            onCancel={() => setMarkup(false)}
            onClose={onClose}
          />
        ) : (
          <MediaActions source={actionsSource}>
            <div className="relative isolate z-10 flex max-h-full max-w-[var(--media-width)] flex-col items-center">
              {item.type === "video" ? (
                <ExpandedVideo key={index} item={item} />
              ) : showingAccessibilityDetails ? (
                accessibilityDetails ? (
                  <SnapShotAccessibilityData
                    details={accessibilityDetails}
                    className="h-[min(var(--media-height),40rem)] w-[min(var(--media-width),42rem)] transition-opacity duration-140 ease-out starting:opacity-0 rounded-lg border border-border/70 bg-background p-4 text-xs leading-5 shadow-2xl motion-reduce:transition-none"
                  />
                ) : null
              ) : item.src === null && imageAsset && imageUrl._tag !== "Failure" ? (
                <div className={EXPANDED_MEDIA_STATE_CLASS_NAME}>Loading image…</div>
              ) : item.src === null || failedImageSrc === item.src ? (
                <ExpandedMediaFailure>
                  <p>
                    {openOriginalLink
                      ? "This image could not be loaded."
                      : "Image unavailable. The file may have been moved or deleted."}
                  </p>
                  {openOriginalLink}
                </ExpandedMediaFailure>
              ) : (
                <div
                  draggable={desktopMedia.enabled}
                  onDragStart={desktopMedia.onDragStart}
                  onMouseEnter={() => {
                    if (desktopMedia.enabled) void desktopMedia.prepare();
                  }}
                  onMouseLeave={desktopMedia.cancelPreparation}
                >
                  <ZoomableImage
                    ref={zoomableImageRef}
                    key={`${index}:${item.src}`}
                    src={item.src}
                    name={item.name}
                    onError={() => setFailedImageSrc(item.src)}
                  />
                </div>
              )}
              <div className="mt-2 flex max-w-[var(--media-width)] items-center justify-center gap-1.5 text-xs text-white/80 max-sm:px-10">
                <span className="truncate" aria-live="polite" aria-atomic="true">
                  {item.name}
                  {preview.images.length > 1 ? ` (${index + 1}/${preview.images.length})` : ""}
                </span>
                {accessibilityDetails && item.source ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          aria-label={contentsLabel}
                          aria-pressed={showingAccessibilityDetails}
                          onClick={() =>
                            setAccessibilityDetailsSrc(
                              showingAccessibilityDetails ? null : item.src,
                            )
                          }
                          size="icon-micro"
                          variant="overlay"
                        />
                      }
                    >
                      <MorphIcon
                        className="size-3"
                        aria-hidden="true"
                        icon={showingAccessibilityDetails ? ImageGlyph : TextGlyph}
                      />
                    </TooltipTrigger>
                    <TooltipPopup side="top">{contentsLabel}</TooltipPopup>
                  </Tooltip>
                ) : item.source ? (
                  <SnapShotContentsButton source={item.source} side="top" />
                ) : null}
                {item.type !== "video" && item.src && failedImageSrc !== item.src && (
                  <Button
                    size="icon-micro"
                    variant="overlay"
                    aria-label="Mark up image"
                    title="Mark up image"
                    onClick={() => setMarkup(true)}
                  >
                    <PencilIcon className="size-3" />
                  </Button>
                )}
                {item.onShowInChat ? (
                  <Button
                    size="sm"
                    variant="overlay"
                    onClick={() => {
                      item.onShowInChat?.();
                      onClose();
                    }}
                  >
                    Show in chat
                  </Button>
                ) : null}
                {historyStatus ? <span role="status">{historyStatus}</span> : null}
                {desktopMedia.status === "loading" ? (
                  <span>Preparing…</span>
                ) : desktopMedia.error ? (
                  <span role="status">{desktopMedia.error}</span>
                ) : null}
                <MediaActionButtons
                  key={index}
                  source={actionsSource}
                  renderButton={({ action, label, disabled, onClick }) => (
                    <Tooltip key={action}>
                      <TooltipTrigger
                        render={
                          <Button
                            aria-label={label}
                            disabled={disabled}
                            onClick={onClick}
                            size="icon-micro"
                            variant="overlay"
                          />
                        }
                      >
                        {action === "save" ? (
                          <DownloadIcon className="size-3" aria-hidden="true" />
                        ) : (
                          <CopyIcon className="size-3" aria-hidden="true" />
                        )}
                      </TooltipTrigger>
                      <TooltipPopup side="top">{label}</TooltipPopup>
                    </Tooltip>
                  )}
                />
              </div>
              {originalCaption ? (
                <p className="mt-1 max-w-[var(--media-width)] text-center text-xs text-white/65">
                  {originalCaption}
                </p>
              ) : null}
            </div>
          </MediaActions>
        )}
        {!markup && preview.images.length > 1 && (
          <Button
            type="button"
            size="icon"
            variant="media-navigation"
            className="right-0 top-auto bottom-0 translate-y-0 sm:top-1/2 sm:bottom-auto sm:-translate-y-1/2"
            aria-label="Next media"
            onClick={() => navigateImage(1)}
          >
            <ChevronRightIcon className="size-5" />
          </Button>
        )}
      </DialogPopup>
    </Dialog>
  );
});
