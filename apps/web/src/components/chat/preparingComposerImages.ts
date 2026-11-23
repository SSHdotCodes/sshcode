import { create } from "zustand";

export interface PreparingComposerImage {
  readonly id: string;
  readonly name: string;
  /** The uncompressed source, thumbnailed so the placeholder shows the image itself. */
  readonly file: File;
  readonly onFinish: () => void;
}

const NO_PREPARING_IMAGES: ReadonlyArray<PreparingComposerImage> = [];

/**
 * Images accepted into a draft but still being compressed, keyed by attachment target. Large
 * screenshots take a noticeable moment to re-encode, so the strip shows these right away and
 * they hold their attachment slots until the real image joins the draft.
 */
const usePreparingComposerImageStore = create<{
  readonly byTargetKey: Readonly<Record<string, ReadonlyArray<PreparingComposerImage>>>;
}>(() => ({ byTargetKey: {} }));

export function usePreparingComposerImages(targetKey: string) {
  return usePreparingComposerImageStore(
    (state) => state.byTargetKey[targetKey] ?? NO_PREPARING_IMAGES,
  );
}

export function countPreparingComposerImages(targetKey: string): number {
  return usePreparingComposerImageStore.getState().byTargetKey[targetKey]?.length ?? 0;
}

export function addPreparingComposerImages(
  targetKey: string,
  images: ReadonlyArray<PreparingComposerImage>,
): void {
  usePreparingComposerImageStore.setState((state) => ({
    byTargetKey: {
      ...state.byTargetKey,
      [targetKey]: [...(state.byTargetKey[targetKey] ?? NO_PREPARING_IMAGES), ...images],
    },
  }));
}

export function isPreparingComposerImage(targetKey: string, imageId: string): boolean {
  return (
    usePreparingComposerImageStore
      .getState()
      .byTargetKey[targetKey]?.some((image) => image.id === imageId) ?? false
  );
}

/** Returns the ids that were still preparing; any other id was cancelled from the strip. */
export function removePreparingComposerImages(
  targetKey: string,
  imageIds: ReadonlySet<string>,
): ReadonlySet<string> {
  const current =
    usePreparingComposerImageStore.getState().byTargetKey[targetKey] ?? NO_PREPARING_IMAGES;
  const removed = new Set(
    current.filter((image) => imageIds.has(image.id)).map((image) => image.id),
  );
  if (removed.size === 0) return removed;
  for (const image of current) {
    if (removed.has(image.id)) image.onFinish();
  }
  usePreparingComposerImageStore.setState((state) => {
    const remaining = (state.byTargetKey[targetKey] ?? NO_PREPARING_IMAGES).filter(
      (image) => !removed.has(image.id),
    );
    const byTargetKey = { ...state.byTargetKey };
    if (remaining.length > 0) {
      byTargetKey[targetKey] = remaining;
    } else {
      delete byTargetKey[targetKey];
    }
    return { byTargetKey };
  });
  return removed;
}

/** Drops every image still preparing for the target, so its compression result is discarded. */
export function cancelPreparingComposerImages(targetKey: string): void {
  const current = usePreparingComposerImageStore.getState().byTargetKey[targetKey];
  if (!current) return;
  for (const image of current) image.onFinish();
  usePreparingComposerImageStore.setState((state) => {
    const byTargetKey = { ...state.byTargetKey };
    delete byTargetKey[targetKey];
    return { byTargetKey };
  });
}

/** Ignore an image canceled before or during asynchronous preparation. */
export async function prepareImageWhileActive<T>(
  targetKey: string,
  image: PreparingComposerImage,
  prepare: (file: File) => Promise<T>,
): Promise<T | undefined> {
  if (!isPreparingComposerImage(targetKey, image.id)) return undefined;
  const result = await prepare(image.file);
  return isPreparingComposerImage(targetKey, image.id) ? result : undefined;
}
