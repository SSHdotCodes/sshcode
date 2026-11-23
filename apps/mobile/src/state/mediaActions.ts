import { mediaActionByteSource, type MediaActionsSource } from "../lib/mediaActionsSource";
import { useNavigation } from "@react-navigation/native";
import type { MediaActionId } from "@t3tools/client-runtime/media-actions";
import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  sessionGrantsScope,
  type SessionGrantInput,
} from "@t3tools/contracts";
import { normalizeNativeMarkdownUrl } from "../lib/markdownLinks";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Linking, Platform } from "react-native";

import { useRefreshAssetUrl } from "./assets";
import { appAtomRegistry } from "./atom-registry";
import { useEnvironmentQuery } from "./query";
import { environmentSession } from "./session";
import {
  downloadAndShareAttachment,
  shareLocalAttachment,
  withLocalMediaFile,
} from "../lib/attachmentDownload";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { loadLocalAttachmentPreview } from "../lib/localAttachmentPreview";

/** An explicit action may ask the server while its grant is still unresolved. */
function allowsHostMedia(session: SessionGrantInput | null) {
  return session === null || sessionGrantsScope(session, AuthFilesystemReadScope);
}

function canReadHostMedia(environmentId: EnvironmentId | null): boolean {
  if (environmentId === null) return true;
  const result = appAtomRegistry.get(environmentSession.sessionStateAtom(environmentId));
  return result._tag !== "Failure" && allowsHostMedia(Option.getOrNull(AsyncResult.value(result)));
}

export type MobileMediaActionId = MediaActionId | "save-to-photos";
export type MediaActionFeedback = "saved" | "copied";
type MediaFileAction = "share" | "save-to-photos" | "copy-image";

export interface MediaAction {
  readonly id: MobileMediaActionId;
  readonly title: string;
  /** SF Symbol for native menus. */
  readonly icon: string;
  readonly run: () => void;
  readonly disabled?: boolean;
}

const FEEDBACK_DURATION_MS = 1_600;

/** Photos and the clipboard take raster pictures; an SVG stays a file to share. */
function isRasterImageMimeType(mimeType: string): boolean {
  const type = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return type.startsWith("image/") && !type.includes("svg");
}

function showPhotosPermissionAlert() {
  Alert.alert(
    "Allow access to Photos",
    "To save images, let SSHCode add to your photo library in Settings.",
    [
      { text: "Not Now", style: "cancel" },
      { text: "Open Settings", onPress: () => void Linking.openSettings() },
    ],
  );
}

export function useMediaActions(
  inputSource: MediaActionsSource | undefined,
  onOpenFile?: () => void,
) {
  const source = useMemo(() => mediaActionByteSource(inputSource), [inputSource]);
  const navigation = useNavigation();
  const hostEnvironmentId =
    source &&
    "resource" in source &&
    (source.resource._tag === "workspace-file" || source.resource._tag === "media-file")
      ? source.environmentId
      : null;
  const fileSession = useEnvironmentQuery(
    hostEnvironmentId === null ? null : environmentSession.sessionStateAtom(hostEnvironmentId),
  );
  const canReadMedia =
    hostEnvironmentId === null ||
    (fileSession.error === null && fileSession.data !== null && allowsHostMedia(fileSession.data));
  const refresh = useRefreshAssetUrl(
    source && "environmentId" in source ? source.environmentId : null,
    source && "resource" in source ? source.resource : null,
  );
  const controller = useRef<AbortController | null>(null);
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [busy, setBusy] = useState<MediaFileAction | null>(null);
  const [feedback, setFeedback] = useState<MediaActionFeedback | null>(null);
  // Whole percent steps only, so a large download doesn't re-render per chunk.
  const [progress, setProgress] = useState<number | null>(null);
  const reportProgress = (fraction: number) => {
    const percent = Math.floor(fraction * 100);
    setProgress((current) => (current === percent ? current : percent));
  };
  useEffect(
    () => () => {
      controller.current?.abort();
      if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current);
    },
    [],
  );

  const confirm = (kind: MediaActionFeedback) => {
    void import("expo-haptics").then((Haptics) =>
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success),
    );
    if (feedbackTimer.current !== null) clearTimeout(feedbackTimer.current);
    setFeedback(kind);
    feedbackTimer.current = setTimeout(() => {
      feedbackTimer.current = null;
      setFeedback(null);
    }, FEEDBACK_DURATION_MS);
  };

  /** One file action at a time; a revoked host grant stops it before any download. */
  const runFileAction = (
    kind: MediaFileAction,
    failureTitle: string,
    task: (signal: AbortSignal) => Promise<void>,
  ) => {
    if (!source || controller.current || !canReadHostMedia(hostEnvironmentId)) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(kind);
    setProgress(null);
    return task(request.signal)
      .catch((error: unknown) => {
        if (request.signal.aborted) return;
        if (error instanceof Error && error.name === "PhotoLibraryPermissionError") {
          showPhotosPermissionAlert();
          return;
        }
        Alert.alert(failureTitle, error instanceof Error ? error.message : "Try again.");
      })
      .finally(() => {
        if (controller.current === request) {
          controller.current = null;
          if (!request.signal.aborted) {
            setBusy(null);
            setProgress(null);
          }
        }
      });
  };

  /** Runs `use` with a disposable local copy of the media's original bytes. */
  const withSourceFile = async (
    signal: AbortSignal,
    use: (fileUri: string) => Promise<void>,
    onProgress?: (fraction: number) => void,
  ): Promise<void> => {
    if (!source) return;
    if ("attachment" in source) {
      const preview = await loadLocalAttachmentPreview(source.attachment, signal);
      if (!preview) return;
      try {
        await use(preview.uri);
      } finally {
        preview.dispose();
      }
      return;
    }
    const uri = "uri" in source ? normalizeNativeMarkdownUrl(source.uri) : await refresh();
    if (signal.aborted || !canReadHostMedia(hostEnvironmentId)) return;
    if (uri === null) throw new Error("The file could not be loaded. Reconnect and try again.");
    await withLocalMediaFile(
      {
        uri,
        attachment: { name: source.name, mimeType: source.mimeType },
        signal,
        ...(onProgress ? { onProgress } : {}),
      },
      use,
    );
  };

  const share = () =>
    runFileAction("share", "Could not share file", async (signal) => {
      if (!source) return;
      if ("attachment" in source) {
        const preview = await loadLocalAttachmentPreview(source.attachment, signal);
        if (!preview) return;
        try {
          await preview.share(signal, source.sourceIdentifier);
        } finally {
          preview.dispose();
        }
        return;
      }
      const uri = "uri" in source ? normalizeNativeMarkdownUrl(source.uri) : await refresh();
      if (signal.aborted || !canReadHostMedia(hostEnvironmentId)) return;
      if (uri === null) throw new Error("The file could not be loaded. Reconnect and try again.");
      const input = {
        attachment: { name: source.name, mimeType: source.mimeType },
        signal,
        sourceIdentifier: source.sourceIdentifier,
      };
      if (/^(file|content):/i.test(uri)) await shareLocalAttachment({ ...input, uri });
      else await downloadAndShareAttachment({ ...input, url: uri });
    });

  const saveToPhotos = async () => {
    if (!source || controller.current) return;
    const photos = await import("../lib/photoLibrary");
    const isVideo = source.mimeType.toLowerCase().startsWith("video/");
    // A dev client built before the native method existed: its share sheet has "Save Image".
    if (!(isVideo ? photos.canSaveVideosToPhotos() : photos.canSaveImagesToPhotos())) {
      return share();
    }
    return runFileAction(
      "save-to-photos",
      isVideo ? "Could not save video" : "Could not save image",
      async (signal) => {
        let saved = false;
        await withSourceFile(
          signal,
          async (fileUri) => {
            await (isVideo
              ? photos.saveVideoFileToPhotos(fileUri)
              : photos.saveImageFileToPhotos(fileUri));
            saved = true;
          },
          isVideo ? reportProgress : undefined,
        );
        if (saved && !signal.aborted) confirm("saved");
      },
    );
  };

  const copyImage = () =>
    runFileAction("copy-image", "Could not copy image", async (signal) => {
      let copied = false;
      await withSourceFile(signal, async (fileUri) => {
        const [{ File }, Clipboard] = await Promise.all([
          import("expo-file-system"),
          import("expo-clipboard"),
        ]);
        const base64 = await new File(fileUri).base64();
        if (signal.aborted) return;
        await Clipboard.setImageAsync(base64);
        copied = true;
      });
      if (copied && !signal.aborted) confirm("copied");
    });

  const reference = source?.reference;
  const relativePath = reference?.kind === "file" ? reference.relativePath : undefined;
  const threadId = source && "threadId" in source ? source.threadId : undefined;
  const image = source !== undefined && isRasterImageMimeType(source.mimeType);
  const video = source !== undefined && source.mimeType.toLowerCase().startsWith("video/");
  const savesToPhotos = (image || video) && Platform.OS === "ios";
  const fileActionDisabled = busy !== null || !canReadMedia;
  const actions: MediaAction[] = source
    ? [
        ...(savesToPhotos
          ? [
              {
                id: "save-to-photos" as const,
                title: busy === "save-to-photos" ? "Saving…" : "Save to Photos",
                icon: "square.and.arrow.down",
                run: () => void saveToPhotos(),
                disabled: fileActionDisabled,
              },
            ]
          : []),
        ...(image
          ? [
              {
                id: "copy-image" as const,
                title: busy === "copy-image" ? "Copying…" : "Copy image",
                icon: "doc.on.doc",
                run: copyImage,
                disabled: fileActionDisabled,
              },
            ]
          : []),
        {
          id: "save" as const,
          title:
            busy === "share" ? "Opening share sheet…" : savesToPhotos ? "Share…" : "Save or share",
          icon: "square.and.arrow.up",
          run: share,
          disabled: fileActionDisabled,
        },
        ...(reference?.kind === "file"
          ? [
              {
                id: "copy-full-path" as const,
                title: "Copy full path",
                icon: "doc.on.clipboard",
                run: () => copyTextWithHaptic(reference.path),
              },
            ]
          : []),
        ...(relativePath
          ? [
              {
                id: "copy-relative-path" as const,
                title: "Copy relative path",
                icon: "doc.on.clipboard",
                run: () => copyTextWithHaptic(relativePath),
              },
            ]
          : []),
        ...(reference?.kind === "url"
          ? [
              {
                id: "copy-url" as const,
                title: "Copy URL",
                icon: "link",
                run: () => copyTextWithHaptic(reference.url),
              },
            ]
          : []),
        ...(relativePath && "environmentId" in source && threadId !== undefined
          ? [
              {
                id: "open-file" as const,
                title: "Open in file viewer",
                icon: "doc.text",
                disabled: !canReadMedia,
                run: () => {
                  if (!canReadHostMedia(hostEnvironmentId)) return;
                  onOpenFile?.();
                  navigation.navigate("ThreadFile", {
                    environmentId: String(source.environmentId),
                    threadId: String(threadId),
                    path: relativePath.split("/"),
                  });
                },
              },
            ]
          : []),
      ]
    : [];
  return {
    title: reference?.kind === "file" ? reference.path : reference?.url,
    actions,
    sharing: busy === "share",
    busy,
    progress,
    feedback,
    share,
    saveToPhotos,
    copyImage,
  };
}
