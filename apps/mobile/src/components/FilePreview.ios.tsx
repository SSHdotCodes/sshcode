import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId } from "react";
import { Alert, Platform } from "react-native";

import { isSvgPreview } from "../lib/filePreviewGallery";
import type { ResolvedFilePreviewSource } from "./FilePreviewModal.types";
import { MediaImagePreview } from "./MediaImagePreview";

const NativeControls = requireNativeModule<{
  presentFile(
    uri: string,
    name: string,
    sourceIdentifier: string,
    identifier: string,
  ): Promise<void>;
  presentFiles(
    uris: readonly string[],
    names: readonly string[],
    selectedIndex: number,
    identifier: string,
  ): Promise<void>;
  dismissFile(identifier: string): Promise<void>;
}>("T3NativeControls");

/**
 * iPad windows resize and rotate, which the in-app viewer cannot follow: it sizes its
 * pages from the screen when it loads. Quick Look pages iPad galleries instead, so
 * every image must resolve before it opens.
 */
export const FILE_PREVIEW_RESOLVES_LAZILY = !(Platform.OS === "ios" && Platform.isPad);

/** Quick Look owns documents and SVG, with its zooming and source-view transition. */
function NativeFilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
}) {
  const { uri, name, sourceIdentifier, gallery } = props.source;
  const identifier = useId();
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onOpenError = useEffectEvent((error: unknown) => {
    if (props.onOpenError) props.onOpenError(error);
    else Alert.alert("Could not open preview", "The file could not be loaded. Please try again.");
  });

  useEffect(() => {
    let canceled = false;
    const pages = gallery?.filter((item) => item.uri !== "") ?? [];
    const presentation =
      pages.length > 1
        ? NativeControls.presentFiles(
            pages.map((item) => item.uri),
            pages.map((item) => item.name ?? "Preview"),
            Math.max(
              0,
              pages.findIndex((item) => item.uri === uri),
            ),
            identifier,
          )
        : NativeControls.presentFile(uri, name ?? "Preview", sourceIdentifier ?? "", identifier);
    void presentation
      .catch((error: unknown) => {
        if (!canceled) onOpenError(error);
      })
      .finally(() => {
        if (!canceled) onRequestClose();
      });
    return () => {
      canceled = true;
      void NativeControls.dismissFile(identifier).catch(() => undefined);
    };
  }, [uri, name, sourceIdentifier, identifier, gallery]);

  return null;
}

/**
 * iPhone pictures open in the in-app viewer, which pages through the gallery and offers
 * one-tap Save to Photos. Quick Look keeps documents, SVG, and iPad galleries.
 */
export function FilePreview(props: {
  readonly source: ResolvedFilePreviewSource;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
  readonly onIndexChange?: (index: number) => void;
  readonly onRequestOlder?: (() => Promise<unknown>) | undefined;
  readonly historyStatus?: string | null | undefined;
}) {
  if (
    (props.source.kind === "image" || props.source.kind === "video") &&
    FILE_PREVIEW_RESOLVES_LAZILY &&
    !isSvgPreview(props.source)
  ) {
    return <MediaImagePreview {...props} />;
  }
  return <NativeFilePreview {...props} />;
}
