import {
  DESKTOP_MEDIA_MAX_BYTES,
  AuthFilesystemReadScope,
  AuthOrchestrationReadScope,
} from "@t3tools/contracts";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { mediaMimeType } from "@t3tools/shared/filePreview";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  useMemo,
} from "react";
import { mediaActionByteSource, useMediaActions, type MediaActionSource } from "./MediaActions";

/** Read at most the native bridge's limit, even when a server omits Content-Length. */
export async function readBoundedDesktopMedia(
  url: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok || response.headers.get("content-type")?.toLowerCase().startsWith("text/html"))
    throw new Error("Media could not be loaded.");
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > DESKTOP_MEDIA_MAX_BYTES)
    throw new Error("Media is too large to drag or preview.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Media could not be loaded.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > DESKTOP_MEDIA_MAX_BYTES) {
        await reader.cancel();
        throw new Error("Media is too large to drag or preview.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!total) throw new Error("Media is empty.");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

let activePreparations = 0;
const MAX_ACTIVE_PREPARATIONS = 2;

/** Prepare on hover/focus so the native drag can start in the drag gesture. */
export function useDesktopMedia(source: MediaActionSource, mimeType?: string) {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const enabled =
    bridge?.getClientPlatform?.() === "darwin" &&
    !!bridge.prepareDesktopMedia &&
    !!bridge.dragDesktopMedia &&
    !!bridge.previewDesktopMedia;
  const { actionUrl, assertCanReadMedia, canReadMedia } = useMediaActions(source);
  const byteSource = useMemo(() => mediaActionByteSource(source), [source]);
  const byteMimeType = source.original?.mimeType ?? mimeType;
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const token = useRef<{ value: string; expiresAt: number } | null>(null);
  const openPreview = useRef<string | null>(null);
  const generation = useRef(0);
  const pending = useRef<Promise<string | null> | null>(null);
  const controller = useRef<AbortController | null>(null);
  const assertDesktopMediaAccess = useCallback(() => {
    assertCanReadMedia();
    if (!byteSource.asset) return;
    const { environmentId, resource } = byteSource.asset;
    const hostFile =
      resource._tag === "workspace-file" ||
      resource._tag === "media-file" ||
      resource._tag === "draft-workspace-file";
    const scope = hostFile ? AuthFilesystemReadScope : AuthOrchestrationReadScope;
    if (!readPreparedConnection(environmentId) || !readEnvironmentScope(environmentId, scope))
      throw new Error("This connection cannot read media.");
  }, [assertCanReadMedia, byteSource.asset]);
  const sourceKey = JSON.stringify([
    byteSource.name,
    byteSource.kind,
    byteSource.src,
    byteSource.asset?.environmentId,
    byteSource.asset?.resource,
    byteMimeType,
  ]);
  useEffect(() => {
    generation.current += 1;
    token.current = null;
    pending.current = null;
    setStatus("idle");
    setError(null);
    return () => {
      generation.current += 1;
      controller.current?.abort();
      controller.current = null;
      if (openPreview.current)
        void bridge?.closeDesktopMediaPreview?.(openPreview.current).catch(() => undefined);
      openPreview.current = null;
    };
  }, [sourceKey]);
  const prepare = useCallback((): Promise<string | null> => {
    if (!enabled || !canReadMedia || !bridge?.prepareDesktopMedia) return Promise.resolve(null);
    if (token.current && token.current.expiresAt > Date.now())
      return Promise.resolve(token.current.value);
    token.current = null;
    if (pending.current) return pending.current;
    if (activePreparations >= MAX_ACTIVE_PREPARATIONS) {
      setStatus("error");
      setError("Another media item is preparing. Try again.");
      return Promise.resolve(null);
    }
    activePreparations += 1;
    const abort = new AbortController();
    controller.current = abort;
    setStatus("loading");
    setError(null);
    const task = (async () => {
      const url = await actionUrl();
      const bytes = await readBoundedDesktopMedia(url, abort.signal);
      assertDesktopMediaAccess();
      if (abort.signal.aborted) return null;
      const name = byteSource.name || byteSource.kind;
      const type =
        byteMimeType ??
        mediaMimeType(name) ??
        mediaMimeType(url) ??
        (byteSource.kind === "image" ? "image/*" : "video/mp4");
      const prepared = await bridge.prepareDesktopMedia!({ name, mimeType: type, bytes });
      if (abort.signal.aborted) return null;
      token.current = { value: prepared, expiresAt: Date.now() + 9 * 60 * 1000 };
      setStatus("ready");
      return prepared;
    })()
      .catch((cause: unknown) => {
        if (!abort.signal.aborted) {
          setStatus("error");
          setError(cause instanceof Error ? cause.message : "Media could not be prepared.");
        }
        return null;
      })
      .finally(() => {
        activePreparations -= 1;
        if (pending.current === task) pending.current = null;
      });
    pending.current = task;
    return task;
  }, [
    enabled,
    canReadMedia,
    bridge,
    actionUrl,
    assertDesktopMediaAccess,
    byteSource.name,
    byteSource.kind,
    byteMimeType,
  ]);
  const cancelPreparation = useCallback(() => {
    if (!pending.current) return;
    controller.current?.abort();
    controller.current = null;
    pending.current = null;
    setStatus("idle");
  }, []);
  const onDragStart = useCallback(
    (event: DragEvent) => {
      if (!enabled) return;
      event.preventDefault();
      try {
        assertDesktopMediaAccess();
      } catch {
        token.current = null;
        setStatus("error");
        setError("This connection cannot read media.");
        return;
      }
      if (token.current && token.current.expiresAt > Date.now() && bridge?.dragDesktopMedia)
        bridge.dragDesktopMedia(token.current.value);
      else void prepare();
    },
    [enabled, bridge, prepare, assertDesktopMediaAccess],
  );
  const onKeyDown = useCallback(
    (event: KeyboardEvent) => {
      if (
        !enabled ||
        event.key !== " " ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      const requestGeneration = generation.current;
      void prepare().then(async (ready) => {
        if (!ready || !bridge?.previewDesktopMedia) return;
        try {
          assertDesktopMediaAccess();
          if (!(await bridge.previewDesktopMedia(ready)))
            throw new Error("Media preview is no longer available.");
          if (requestGeneration !== generation.current) {
            await bridge.closeDesktopMediaPreview?.(ready);
            return;
          }
          openPreview.current = ready;
        } catch (cause) {
          setStatus("error");
          setError(cause instanceof Error ? cause.message : "Media preview failed.");
        }
      });
    },
    [enabled, bridge, prepare, assertDesktopMediaAccess],
  );
  return { enabled, status, error, prepare, cancelPreparation, onDragStart, onKeyDown };
}
