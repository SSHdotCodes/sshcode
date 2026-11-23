import { requireNativeModule } from "expo";
import { Platform } from "react-native";

interface PhotoLibraryModule {
  readonly saveImageToPhotos?: (fileUri: string) => Promise<void>;
  readonly saveVideoToPhotos?: (fileUri: string) => Promise<void>;
}

let photoLibraryModule: PhotoLibraryModule | null | undefined;

function nativePhotoLibrary(): PhotoLibraryModule | null {
  if (photoLibraryModule === undefined) {
    try {
      photoLibraryModule = requireNativeModule<PhotoLibraryModule>("T3NativeControls");
    } catch {
      photoLibraryModule = null;
    }
  }
  return photoLibraryModule;
}

/**
 * Whether this binary can add images to Photos directly. Dev clients built before the
 * native method existed lack it; callers fall back to the share sheet's "Save Image".
 */
export function canSaveImagesToPhotos(): boolean {
  return Platform.OS === "ios" && typeof nativePhotoLibrary()?.saveImageToPhotos === "function";
}

/** The user declined (or restricted) adding to Photos; only Settings can change that. */
export class PhotoLibraryPermissionError extends Error {
  override readonly name = "PhotoLibraryPermissionError";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code: unknown }).code)
    : undefined;
}

/** Adds a local image file to the photo library, asking for add-only access first. */
export async function saveImageFileToPhotos(fileUri: string): Promise<void> {
  const save = nativePhotoLibrary()?.saveImageToPhotos;
  if (typeof save !== "function") {
    throw new Error("Saving to Photos is unavailable in this build of the app.");
  }
  try {
    await save(fileUri);
  } catch (error) {
    switch (errorCode(error)) {
      case "ERR_PHOTOS_PERMISSION":
        throw new PhotoLibraryPermissionError("SSHCode is not allowed to add images to Photos.", {
          cause: error,
        });
      case "ERR_PHOTOS_FORMAT":
        throw new Error("Photos cannot store this image format. Use Share instead.", {
          cause: error,
        });
      default:
        throw new Error("Photos could not save this image. Try again.", { cause: error });
    }
  }
}

/** Whether this binary can add videos to Photos directly; older builds lack the method. */
export function canSaveVideosToPhotos(): boolean {
  return Platform.OS === "ios" && typeof nativePhotoLibrary()?.saveVideoToPhotos === "function";
}

/** Adds a local video file to the photo library, asking for add-only access first. */
export async function saveVideoFileToPhotos(fileUri: string): Promise<void> {
  const save = nativePhotoLibrary()?.saveVideoToPhotos;
  if (typeof save !== "function") {
    throw new Error("Saving videos to Photos is unavailable in this build of the app.");
  }
  try {
    await save(fileUri);
  } catch (error) {
    switch (errorCode(error)) {
      case "ERR_PHOTOS_PERMISSION":
        throw new PhotoLibraryPermissionError("SSHCode is not allowed to add videos to Photos.", {
          cause: error,
        });
      case "ERR_PHOTOS_FORMAT":
        throw new Error("Photos cannot store this video format. Use Share instead.", {
          cause: error,
        });
      default: {
        // Keeps PhotoKit's reason (domain and code) so a failure can be traced.
        const reason = error instanceof Error && error.message ? ` ${error.message}` : "";
        throw new Error(`Photos could not save this video.${reason}`, { cause: error });
      }
    }
  }
}
