import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import type { ImagePickerAsset } from "expo-image-picker";

const mocks = vi.hoisted(() => ({
  documentUri: "file:///documents",
  pickFile: vi.fn(),
  pickMedia: vi.fn(),
  cameraPermission: vi.fn(),
  takePhoto: vi.fn(),
  copy: vi.fn(),
  delete: vi.fn(),
  open: vi.fn(),
  size: vi.fn(),
  readBase64: vi.fn(),
  manipulate: vi.fn(),
  release: vi.fn(),
  nativeControls: vi.fn(),
  exportVideo: vi.fn(),
}));

vi.mock("expo-file-system", () => {
  class Directory {
    readonly uri: string;

    constructor(root: string | { readonly uri: string }, name: string) {
      this.uri = `${typeof root === "string" ? root : root.uri}/${name}`;
    }

    create(): void {}
  }

  class File {
    readonly uri: string;

    constructor(source: string | Directory, name?: string) {
      this.uri = source instanceof Directory ? `${source.uri}/${name}` : source;
    }

    get exists(): boolean {
      return true;
    }

    get size(): number | null {
      return mocks.size(this.uri) ?? null;
    }

    get name(): string {
      return this.uri.split("/").at(-1) ?? "";
    }

    get type(): string {
      return "video/quicktime";
    }

    create(): void {}

    open(mode: string) {
      return mocks.open(this.uri, mode);
    }

    async copy(destination: File): Promise<void> {
      mocks.copy(this.uri, destination.uri);
    }

    async base64(): Promise<string> {
      return mocks.readBase64(this.uri);
    }

    delete(): void {
      mocks.delete(this.uri);
    }
  }

  return {
    Directory,
    File,
    FileMode: { ReadOnly: "r", WriteOnly: "w" },
    Paths: {
      cache: { uri: "file:///cache" },
      get document() {
        return { uri: mocks.documentUri };
      },
    },
  };
});

vi.mock("expo", () => ({ requireOptionalNativeModule: mocks.nativeControls }));
vi.mock("expo-image-picker", () => ({
  launchImageLibraryAsync: mocks.pickMedia,
  requestCameraPermissionsAsync: mocks.cameraPermission,
  launchCameraAsync: mocks.takePhoto,
  UIImagePickerPreferredAssetRepresentationMode: { Current: "current" },
}));
vi.mock("expo-document-picker", () => ({ getDocumentAsync: mocks.pickFile }));
vi.mock("expo-image-manipulator", () => ({
  SaveFormat: { JPEG: "jpeg", PNG: "png", WEBP: "webp" },
  ImageManipulator: { manipulate: mocks.manipulate },
}));
vi.mock("./uuid", () => ({ uuidv4: () => "attachment-id" }));

import {
  persistComposerAttachmentFile,
  pickComposerFiles,
  pickComposerImages,
  pickComposerMedia,
  removePersistedComposerAttachmentFile,
} from "./composerImages";
import { isForegroundHandoffActive } from "./foreground-handoff";
import { retainComposerAttachmentFile } from "./composerAttachmentFiles";

describe("composer file attachments", () => {
  beforeEach(() => {
    mocks.documentUri = "file:///documents";
    mocks.pickFile.mockReset();
    mocks.pickMedia.mockReset();
    mocks.cameraPermission.mockReset();
    mocks.takePhoto.mockReset();
    mocks.copy.mockReset();
    mocks.delete.mockReset();
    mocks.open.mockReset();
    mocks.size.mockReset();
    mocks.readBase64.mockReset();
    mocks.nativeControls.mockReset();
    mocks.exportVideo.mockReset();
    mocks.size.mockImplementation((uri: string) => (uri.startsWith("content:") ? null : 42));
  });

  describe("camera attachments", () => {
    it("requests permission and retains a captured photo through the normal attachment pipeline", async () => {
      mocks.cameraPermission.mockResolvedValue({ granted: true });
      mocks.takePhoto.mockResolvedValue({
        canceled: false,
        assets: [
          {
            uri: "file:///camera/photo.jpg",
            type: "image",
            mimeType: "image/jpeg",
            width: 800,
            height: 600,
          },
        ],
      });
      mocks.readBase64.mockResolvedValue("/9j/2Q==");
      const result = await pickComposerMedia({ existingCount: 0, source: "camera" });
      expect(result.error).toBeNull();
      expect(result.attachments).toHaveLength(1);
      expect(result.attachments[0]).toMatchObject({ type: "image", mimeType: "image/jpeg" });
      expect(mocks.cameraPermission).toHaveBeenCalledOnce();
      expect(mocks.takePhoto).toHaveBeenCalledWith({
        mediaTypes: ["images"],
        base64: false,
        quality: 1,
      });
      expect(mocks.pickMedia).not.toHaveBeenCalled();
      expect(isForegroundHandoffActive()).toBe(false);
    });

    it("explains denied permission and ends the foreground handoff", async () => {
      mocks.cameraPermission.mockResolvedValue({ granted: false, canAskAgain: false });
      const result = await pickComposerMedia({ existingCount: 0, source: "camera" });
      expect(result.attachments).toEqual([]);
      expect(result.error).toContain("Settings");
      expect(mocks.takePhoto).not.toHaveBeenCalled();
      expect(isForegroundHandoffActive()).toBe(false);
    });

    it("treats camera cancellation as a quiet return to the draft", async () => {
      mocks.cameraPermission.mockResolvedValue({ granted: true });
      mocks.takePhoto.mockResolvedValue({ canceled: true, assets: null });
      expect(await pickComposerMedia({ existingCount: 0, source: "camera" })).toEqual({
        attachments: [],
        error: null,
      });
      expect(isForegroundHandoffActive()).toBe(false);
    });

    it("returns a camera failure without leaving a handoff active", async () => {
      mocks.cameraPermission.mockRejectedValue(new Error("Camera is unavailable"));
      expect(await pickComposerMedia({ existingCount: 0, source: "camera" })).toEqual({
        attachments: [],
        error: "Camera is unavailable",
      });
      expect(isForegroundHandoffActive()).toBe(false);
    });
  });

  describe("photo library image conversion", () => {
    const rendered = { uri: "file:///cache/ImageManipulator/photo.jpg", base64: "/9j/2Q==" };
    const photo: ImagePickerAsset = {
      uri: "file:///picker/photo.heic",
      type: "image",
      fileName: "photo.HEIC",
      mimeType: "image/heic",
      fileSize: 4 * 1024 * 1024,
      width: 4032,
      height: 3024,
    };
    /**
     * Stands in for the native manipulator: `size` is what decoding the source yields,
     * `resizes` records every requested resize, and `saved` is what saving returns.
     */
    const native = {
      size: { width: 1, height: 1 },
      resizes: [] as Array<{ width?: number | null; height?: number | null }>,
      saved: rendered as { uri: string; base64?: string },
    };

    beforeEach(() => {
      native.size = { width: 1, height: 1 };
      native.resizes = [];
      native.saved = rendered;
      mocks.manipulate.mockReset();
      mocks.release.mockReset();
      mocks.manipulate.mockImplementation(() => {
        const context = {
          resize(size: { width?: number | null; height?: number | null }) {
            native.resizes.push(size);
            return context;
          },
          renderAsync: async () => ({
            ...native.size,
            release: mocks.release,
            saveAsync: async () => native.saved,
          }),
        };
        return context;
      });
    });

    it.each(["image/heic", "image/heif", undefined])(
      "renders a %s photo to JPEG natively, previews the rendered file and keeps a known original",
      async (mimeType) => {
        mocks.pickMedia.mockResolvedValue({
          canceled: false,
          assets: [{ ...photo, mimeType }],
        });

        const result = await pickComposerMedia({ existingCount: 0, maxVideoBytes: 1024 });

        expect(mocks.pickMedia).toHaveBeenCalledWith(
          expect.objectContaining({ base64: false, preferredAssetRepresentationMode: "current" }),
        );
        expect(mocks.manipulate).toHaveBeenCalledWith(photo.uri);
        expect(mocks.readBase64).not.toHaveBeenCalled();
        expect(result).toEqual({
          attachments: [
            {
              id: "attachment-id",
              type: "image",
              name: "photo.jpg",
              mimeType: "image/jpeg",
              sizeBytes: 4,
              dataUrl: `data:image/jpeg;base64,${rendered.base64}`,
              previewUri: rendered.uri,
              // Camera HEIC keeps its full-size original for Save; an unknown type cannot.
              ...(mimeType
                ? {
                    original: { name: "photo.HEIC", mimeType, sizeBytes: 42, width: 1, height: 1 },
                    originalFileUri:
                      "file:///documents/t3-composer-attachments/attachment-id-photo.HEIC",
                    sentSize: { width: 1, height: 1 },
                  }
                : {}),
            },
          ],
          error: null,
        });
      },
    );

    it.each([
      { size: { width: 4032, height: 3024 }, resizes: [{ width: 2000, height: 1500 }] },
      { size: { width: 3024, height: 4032 }, resizes: [{ width: 1500, height: 2000 }] },
      { size: { width: 2000, height: 1500 }, resizes: [] },
    ])("bounds a $size.width x $size.height photo to a 2000 px longest edge", async (input) => {
      native.size = input.size;
      mocks.pickMedia.mockResolvedValue({ canceled: false, assets: [photo] });

      await pickComposerImages({ existingCount: 0 });

      expect(native.resizes).toEqual(input.resizes);
      // Every decoded bitmap is released, including the full-size one a resize replaces.
      expect(mocks.release).toHaveBeenCalledTimes(input.resizes.length + 1);
    });

    it.each([
      { extension: "png", mimeType: "image/png", base64: "iVBORw0KGgo=" },
      { extension: "gif", mimeType: "image/gif", base64: "R0lGODlh" },
      { extension: "webp", mimeType: "image/webp", base64: "UklGRgQAAABXRUJQ" },
    ])("keeps original $extension bytes from the picker file", async (original) => {
      const name = `photo.${original.extension}`;
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [{ ...photo, fileName: name, mimeType: original.mimeType }],
      });
      mocks.readBase64.mockResolvedValue(original.base64);

      const result = await pickComposerImages({ existingCount: 0 });

      expect(mocks.manipulate).not.toHaveBeenCalled();
      expect(mocks.readBase64).toHaveBeenCalledWith(photo.uri);
      expect(result.error).toBeNull();
      expect(result.images).toEqual([
        expect.objectContaining({
          name,
          mimeType: original.mimeType,
          dataUrl: `data:${original.mimeType};base64,${original.base64}`,
          sizeBytes: Buffer.from(original.base64, "base64").byteLength,
          previewUri: photo.uri,
        }),
      ]);
    });

    it("renders a supported original that exceeds the image limit instead of rejecting it", async () => {
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [{ ...photo, fileName: "photo.jpg", mimeType: "image/jpeg" }],
      });
      mocks.size.mockReturnValue(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);

      const result = await pickComposerImages({ existingCount: 0 });

      expect(mocks.manipulate).toHaveBeenCalledWith(photo.uri);
      expect(result.error).toBeNull();
      expect(result.images).toEqual([
        expect.objectContaining({ name: "photo.jpg", mimeType: "image/jpeg", sizeBytes: 4 }),
      ]);
    });

    it("measures the picker file instead of trusting the reported size", async () => {
      // A content stream can deliver more bytes than the picker advertises; a supported
      // original only skips rendering when the file itself measures within the limit.
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [{ ...photo, fileName: "photo.png", mimeType: "image/png", fileSize: 42 }],
      });
      mocks.size.mockReturnValue(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES + 1);

      const result = await pickComposerImages({ existingCount: 0 });

      expect(mocks.readBase64).not.toHaveBeenCalled();
      expect(mocks.manipulate).toHaveBeenCalledWith(photo.uri);
      expect(result.images).toEqual([expect.objectContaining({ mimeType: "image/jpeg" })]);
    });

    it("renders a supported original whose size cannot be measured", async () => {
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [
          { ...photo, uri: "content://media/1", fileName: "photo.png", mimeType: "image/png" },
        ],
      });

      const result = await pickComposerImages({ existingCount: 0 });

      expect(mocks.readBase64).not.toHaveBeenCalled();
      expect(mocks.manipulate).toHaveBeenCalledWith("content://media/1");
      expect(result.images).toEqual([expect.objectContaining({ mimeType: "image/jpeg" })]);
    });

    it("checks the rendered JPEG against the image limit", async () => {
      native.saved = {
        uri: rendered.uri,
        base64:
          rendered.base64.slice(0, 4) +
          "A".repeat(Math.ceil(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 3) * 4),
      };
      mocks.pickMedia.mockResolvedValue({ canceled: false, assets: [photo] });

      await expect(pickComposerImages({ existingCount: 0 })).resolves.toEqual({
        images: [],
        error: "'photo.HEIC' exceeds the 10 MB attachment limit.",
      });
    });

    it("retains a rendered photo when another original cannot be read", async () => {
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [{ ...photo, fileName: "missing.gif", mimeType: "image/gif" }, photo],
      });
      mocks.readBase64.mockRejectedValue(new Error("missing file"));

      const result = await pickComposerImages({ existingCount: 0 });

      expect(result.images).toEqual([expect.objectContaining({ name: "photo.jpg" })]);
      expect(result.error).toBe("Failed to read 'missing.gif'.");
    });

    it("reports a photo the native renderer cannot decode", async () => {
      mocks.manipulate.mockImplementation(() => ({
        resize: () => {
          throw new Error("unreachable");
        },
        renderAsync: () => Promise.reject(new Error("corrupt")),
      }));
      mocks.pickMedia.mockResolvedValue({ canceled: false, assets: [photo] });

      await expect(pickComposerImages({ existingCount: 0 })).resolves.toEqual({
        images: [],
        error: "Failed to read 'photo.HEIC'.",
      });
    });
  });

  describe("photo library videos", () => {
    const image: ImagePickerAsset = {
      uri: "file:///picker/photo.png",
      type: "image",
      fileName: "photo.png",
      mimeType: "image/png",
      fileSize: 3,
      width: 1,
      height: 1,
    };

    beforeEach(() => {
      mocks.readBase64.mockResolvedValue("YWJj");
    });
    const video: ImagePickerAsset = {
      uri: "file:///picker/clip.mov",
      type: "video",
      fileName: "clip.mov",
      mimeType: "video/quicktime",
      fileSize: 20 * 1024 * 1024,
      base64: null,
      width: 1920,
      height: 1080,
    };

    it("retains mixed photos and videos, keeping video bytes in durable file storage", async () => {
      mocks.pickMedia.mockResolvedValue({ canceled: false, assets: [image, video] });
      mocks.size.mockImplementation((uri: string) =>
        uri.endsWith("clip.mov") ? video.fileSize : 3,
      );

      const result = await pickComposerMedia({ existingCount: 0, maxVideoBytes: 50 * 1024 * 1024 });

      expect(mocks.pickMedia).toHaveBeenCalledWith(
        expect.objectContaining({
          mediaTypes: ["images", "videos"],
          preferredAssetRepresentationMode: "current",
          shouldDownloadFromNetwork: true,
        }),
      );
      expect(result).toEqual({
        attachments: [
          expect.objectContaining({ type: "image", dataUrl: "data:image/png;base64,YWJj" }),
          {
            id: "attachment-id",
            type: "file",
            name: "clip.mov",
            mimeType: "video/quicktime",
            sizeBytes: video.fileSize,
            fileUri: "file:///documents/t3-composer-attachments/attachment-id-clip.mov",
          },
        ],
        error: null,
      });
      expect(mocks.copy).toHaveBeenCalledWith(
        video.uri,
        "file:///documents/t3-composer-attachments/attachment-id-clip.mov",
      );
      expect(mocks.delete).not.toHaveBeenCalled();
    });

    it("keeps image-only destinations on the image picker path", async () => {
      mocks.pickMedia.mockResolvedValue({ canceled: false, assets: [image] });

      const result = await pickComposerImages({ existingCount: 0 });

      expect(mocks.pickMedia).toHaveBeenCalledWith(
        expect.objectContaining({ mediaTypes: ["images"] }),
      );
      expect(mocks.pickMedia.mock.calls[0]?.[0]).not.toHaveProperty(
        "preferredAssetRepresentationMode",
      );
      expect(result.images).toEqual([
        expect.objectContaining({ type: "image", name: "photo.png" }),
      ]);
      expect(result.error).toBeNull();
      expect(mocks.copy).not.toHaveBeenCalled();
    });

    it("does not persist videos when the destination lacks file support", async () => {
      mocks.pickMedia.mockResolvedValue({ canceled: false, assets: [video, image] });

      const result = await pickComposerMedia({ existingCount: 0 });

      expect(result.attachments).toEqual([expect.objectContaining({ type: "image" })]);
      expect(result.error).toBe("Video attachments are unavailable here.");
      expect(mocks.copy).not.toHaveBeenCalled();
    });

    it("uses local video metadata when the picker omits its name, MIME type, or size", async () => {
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [{ ...video, fileName: null, mimeType: undefined, fileSize: undefined }],
      });

      const result = await pickComposerMedia({ existingCount: 0, maxVideoBytes: 1024 });

      expect(result.error).toBeNull();
      expect(result.attachments).toEqual([
        expect.objectContaining({
          type: "file",
          name: "clip.mov",
          mimeType: "video/quicktime",
          sizeBytes: 42,
        }),
      ]);
    });

    it("keeps a video at the upload limit even when the picker reports larger metadata", async () => {
      const limit = 50 * 1024 * 1024;
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [{ ...video, fileSize: 63 * 1024 * 1024 }],
      });
      mocks.size.mockReturnValue(limit);

      await expect(pickComposerMedia({ existingCount: 0, maxVideoBytes: limit })).resolves.toEqual({
        attachments: [expect.objectContaining({ name: video.fileName, sizeBytes: limit })],
        error: null,
      });
      expect(mocks.nativeControls).not.toHaveBeenCalled();
    });

    it.each([
      {
        reason: "actual size exceeds the server limit",
        reported: 42,
        stored: 2 * 1024 * 1024,
        limit: 1024 * 1024,
        error: "'clip.mov' is 2 MB; the limit is 1 MB.",
      },
      {
        reason: "stored copy is empty",
        reported: 42,
        stored: 0,
        limit: 1024 * 1024,
        error: "'clip.mov' is empty or could not be read.",
      },
      {
        reason: "server advertises more than the contract limit",
        reported: 42,
        stored: 63 * 1024 * 1024,
        limit: 80 * 1024 * 1024,
        error: "'clip.mov' is 63 MB; the limit is 50 MB.",
      },
    ])(
      "rejects a video when $reason while retaining the selected photo",
      async ({ reported, stored, limit, error }) => {
        mocks.pickMedia.mockResolvedValue({
          canceled: false,
          assets: [{ ...video, fileSize: reported }, image],
        });
        mocks.size.mockImplementation((uri: string) => (uri.endsWith("clip.mov") ? stored : 3));

        const result = await pickComposerMedia({ existingCount: 0, maxVideoBytes: limit });

        expect(result).toEqual({
          attachments: [expect.objectContaining({ type: "image" })],
          error,
        });
        if (stored === 0) {
          expect(mocks.delete).toHaveBeenCalledWith(
            "file:///documents/t3-composer-attachments/attachment-id-clip.mov",
          );
        }
      },
    );

    it("applies the remaining attachment slots to photos and videos together", async () => {
      mocks.pickMedia.mockResolvedValue({ canceled: false, assets: [image, video] });

      const result = await pickComposerMedia({
        existingCount: 99,
        maxVideoBytes: 50 * 1024 * 1024,
      });

      expect(result.attachments).toEqual([expect.objectContaining({ type: "image" })]);
      expect(result.error).toBe("You can attach up to 100 attachments per message.");
      expect(mocks.pickMedia).toHaveBeenCalledWith(expect.objectContaining({ selectionLimit: 1 }));
      expect(mocks.copy).not.toHaveBeenCalled();
    });

    it("reports a native video retrieval error and ends the foreground handoff", async () => {
      mocks.pickMedia.mockRejectedValue(new Error("Could not download video from iCloud."));

      await expect(pickComposerMedia({ existingCount: 0, maxVideoBytes: 1024 })).resolves.toEqual({
        attachments: [],
        error: "Could not download video from iCloud.",
      });
      expect(isForegroundHandoffActive()).toBe(false);
    });
  });

  describe("oversized videos", () => {
    const mb = 1024 * 1024;
    const sourceUri = "file:///cache/ImagePicker/recording.mov";
    const durableUri = "file:///documents/t3-composer-attachments/attachment-id-recording.mp4";
    const hevcUri = "file:///cache/t3-composer-video-exports/hevc.mp4";
    const h264Uri = "file:///cache/t3-composer-video-exports/720.mp4";
    const lowUri = "file:///cache/t3-composer-video-exports/480.mp4";
    const maxVideoBytes = PROVIDER_SEND_TURN_MAX_FILE_BYTES;

    beforeEach(() => {
      mocks.pickMedia.mockResolvedValue({
        canceled: false,
        assets: [{ uri: sourceUri, type: "video", fileName: "recording.mov", fileSize: 5 }],
      });
      mocks.nativeControls.mockReturnValue({ exportAttachmentVideo: mocks.exportVideo });
      mocks.size.mockImplementation((uri) => (uri.endsWith(".mov") ? 200 : 25) * mb);
    });

    it("tries HEVC, then H.264 at 720p and 480p, keeping only the file that fits", async () => {
      const onCompressing = vi.fn();
      mocks.exportVideo.mockImplementation(async (_uri, preset) => {
        expect(onCompressing).toHaveBeenCalledExactlyOnceWith("recording.mov");
        expect(isForegroundHandoffActive()).toBe(true);
        if (preset === "hevc1080") return { uri: hevcUri, sizeBytes: 80 * mb, durationSeconds: 90 };
        expect(mocks.delete).toHaveBeenCalledWith(hevcUri);
        if (preset === "h264720") throw new Error("Unsupported preset");
        return { uri: lowUri, sizeBytes: 25 * mb, durationSeconds: 90 };
      });

      const result = await pickComposerMedia({ existingCount: 0, maxVideoBytes, onCompressing });

      expect(mocks.exportVideo.mock.calls).toEqual([
        [sourceUri, "hevc1080"],
        [sourceUri, "h264720"],
        [sourceUri, "h264480"],
      ]);
      expect(mocks.delete.mock.calls).toEqual([[hevcUri], [lowUri], [sourceUri]]);
      expect(mocks.copy).toHaveBeenCalledExactlyOnceWith(lowUri, durableUri);
      expect(result).toEqual({
        attachments: [
          expect.objectContaining({
            name: "recording.mp4",
            mimeType: "video/mp4",
            sizeBytes: 25 * mb,
            fileUri: durableUri,
          }),
        ],
        error: null,
      });
      expect(isForegroundHandoffActive()).toBe(false);
      await removePersistedComposerAttachmentFile(durableUri);
      expect(mocks.delete).toHaveBeenLastCalledWith(durableUri);
    });

    it("reports the measured source size and estimates a fitting duration from the exports", async () => {
      mocks.exportVideo
        .mockResolvedValueOnce({ uri: hevcUri, sizeBytes: 150 * mb, durationSeconds: 240 })
        .mockResolvedValueOnce({ uri: h264Uri, sizeBytes: 120 * mb, durationSeconds: 240 })
        .mockResolvedValueOnce({ uri: lowUri, sizeBytes: 100 * mb, durationSeconds: 240 });

      await expect(pickComposerMedia({ existingCount: 0, maxVideoBytes })).resolves.toEqual({
        attachments: [],
        error: "'recording.mov' is 200 MB; the limit is 50 MB. Keep it under about 2 minutes.",
      });
      expect(mocks.copy).not.toHaveBeenCalled();
      expect(mocks.delete.mock.calls).toEqual([[hevcUri], [h264Uri], [lowUri], [sourceUri]]);
      expect(isForegroundHandoffActive()).toBe(false);
    });

    it("cleans up the export even if the draft copy fails", async () => {
      mocks.exportVideo.mockResolvedValueOnce({
        uri: hevcUri,
        sizeBytes: 25 * mb,
        durationSeconds: 90,
      });
      mocks.copy.mockImplementationOnce(() => {
        throw new Error("Out of space");
      });

      await expect(pickComposerMedia({ existingCount: 0, maxVideoBytes })).resolves.toEqual({
        attachments: [],
        error: "Out of space",
      });
      expect(mocks.delete.mock.calls).toEqual([[durableUri], [hevcUri], [sourceUri]]);
      expect(isForegroundHandoffActive()).toBe(false);
    });

    it("handles a video opened through Files without touching a sender-owned source", async () => {
      const documentUri = "file:///sender/Documents/recording.mov";
      mocks.pickFile.mockResolvedValue({
        canceled: false,
        assets: [{ uri: documentUri, name: "recording.mov" }],
      });
      mocks.exportVideo.mockResolvedValueOnce({
        uri: hevcUri,
        sizeBytes: 25 * mb,
        durationSeconds: 90,
      });

      const result = await pickComposerFiles({ existingCount: 0, maxBytes: maxVideoBytes });

      expect(result.files).toEqual([
        expect.objectContaining({ name: "recording.mp4", fileUri: durableUri }),
      ]);
      expect(result.error).toBeNull();
      expect(mocks.exportVideo).toHaveBeenCalledExactlyOnceWith(documentUri, "hevc1080");
      expect(mocks.delete.mock.calls).toEqual([[hevcUri]]);
    });
  });

  it("copies picked files into app-owned storage without loading their contents", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///downloads/report.pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          size: 42,
        },
      ],
    });

    await expect(pickComposerFiles({ existingCount: 0 })).resolves.toEqual({
      files: [
        {
          id: "attachment-id",
          type: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          fileUri: "file:///documents/t3-composer-attachments/attachment-id-report.pdf",
        },
      ],
      error: null,
    });
    expect(mocks.copy).toHaveBeenCalledWith(
      "file:///downloads/report.pdf",
      "file:///documents/t3-composer-attachments/attachment-id-report.pdf",
    );
  });

  it("preserves Android picker metadata instead of using the content URI document id", async () => {
    const uri = "content://com.android.providers.media.documents/document/video%3A18";
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri,
          name: "preview-h264.mp4",
          mimeType: "video/mp4",
          size: 620_992,
          lastModified: 0,
        },
      ],
    });
    mocks.size.mockReturnValue(620_992);

    await expect(pickComposerFiles({ existingCount: 0 })).resolves.toEqual({
      files: [
        {
          id: "attachment-id",
          type: "file",
          name: "preview-h264.mp4",
          mimeType: "video/mp4",
          sizeBytes: 620_992,
          fileUri: "file:///documents/t3-composer-attachments/attachment-id-preview-h264.mp4",
        },
      ],
      error: null,
    });
    expect(mocks.pickFile).toHaveBeenCalledWith({ multiple: true, copyToCacheDirectory: true });
    expect(mocks.copy).toHaveBeenCalledWith(
      uri,
      "file:///documents/t3-composer-attachments/attachment-id-preview-h264.mp4",
    );
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it("persists provider selections that require a readable cache copy", async () => {
    const providerUri = "content://cloud-provider/documents/clip";
    const cachedUri = "file:///cache/DocumentPicker/clip.mp4";
    mocks.pickFile.mockImplementation(async (options) => ({
      canceled: false,
      assets: [
        {
          uri: options.copyToCacheDirectory ? cachedUri : providerUri,
          name: "Cloud recording.mp4",
          mimeType: "video/mp4",
          size: 42,
          lastModified: 0,
        },
      ],
    }));
    mocks.copy.mockImplementation((uri: string) => {
      if (uri === providerUri) throw new Error("The provider URI is not directly readable.");
    });

    const result = await pickComposerFiles({ existingCount: 0 });

    expect(result.error).toBeNull();
    expect(result.files).toEqual([
      expect.objectContaining({
        name: "Cloud recording.mp4",
        fileUri: "file:///documents/t3-composer-attachments/attachment-id-Cloud recording.mp4",
      }),
    ]);
    expect(mocks.copy).toHaveBeenCalledWith(cachedUri, result.files[0]!.fileUri);
  });

  it("ends the foreground handoff when the picker is canceled without copying files", async () => {
    mocks.pickFile.mockImplementation(async () => {
      expect(isForegroundHandoffActive()).toBe(true);
      return { canceled: true, assets: null };
    });

    await expect(pickComposerFiles({ existingCount: 0 })).resolves.toEqual({
      files: [],
      error: null,
    });

    expect(isForegroundHandoffActive()).toBe(false);
    expect(mocks.copy).not.toHaveBeenCalled();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("reports picker failures and releases the foreground handoff", async () => {
    mocks.pickFile.mockRejectedValue(new Error("The document provider is unavailable."));

    await expect(pickComposerFiles({ existingCount: 0 })).resolves.toEqual({
      files: [],
      error: "The document provider is unavailable.",
    });

    expect(isForegroundHandoffActive()).toBe(false);
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("does not open the picker when the draft has no remaining attachment slots", async () => {
    await expect(pickComposerFiles({ existingCount: 100 })).resolves.toEqual({
      files: [],
      error: "You can attach up to 100 files per message.",
    });

    expect(mocks.pickFile).not.toHaveBeenCalled();
    expect(isForegroundHandoffActive()).toBe(false);
  });

  it("falls back to a usable name when the picker reports a blank one", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///downloads/unnamed",
          name: "   ",
          mimeType: "application/pdf",
          size: 42,
        },
      ],
    });

    const result = await pickComposerFiles({ existingCount: 0 });
    expect(result.error).toBeNull();
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.name).toBe("file");
  });

  it("keeps the app-owned copy within the filesystem's filename byte limit", async () => {
    const name = `${"界".repeat(82)}.txt`;
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [{ uri: "file:///downloads/long.txt", name, mimeType: "text/plain", size: 42 }],
    });

    const result = await pickComposerFiles({ existingCount: 0 });

    expect(result.error).toBeNull();
    const file = result.files[0];
    expect(file?.name).toBe(name);
    const storedName = file?.fileUri.split("/").at(-1) ?? "";
    expect(storedName).toMatch(/^attachment-id-界+\.txt$/u);
    expect(new TextEncoder().encode(storedName).byteLength).toBeLessThanOrEqual(255);
  });

  it("rejects files that exceed the environment's advertised upload limit", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///downloads/archive.zip",
          name: "archive.zip",
          mimeType: "application/zip",
          size: 2 * 1024 * 1024,
        },
      ],
    });

    await expect(pickComposerFiles({ existingCount: 0, maxBytes: 1024 * 1024 })).resolves.toEqual({
      files: [],
      error: "'archive.zip' exceeds the 1 MB attachment limit.",
    });
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("never accepts files above the 50 MB contract limit", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///downloads/archive.zip",
          name: "archive.zip",
          mimeType: "application/zip",
          size: 51 * 1024 * 1024,
        },
      ],
    });

    await expect(
      pickComposerFiles({ existingCount: 0, maxBytes: 80 * 1024 * 1024 }),
    ).resolves.toEqual({
      files: [],
      error: "'archive.zip' exceeds the 50 MB attachment limit.",
    });
  });

  it("rejects a file that grew after the picker reported its size", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///downloads/archive.zip",
          name: "archive.zip",
          mimeType: "application/zip",
          size: 42,
        },
      ],
    });
    mocks.size.mockReturnValue(2 * 1024 * 1024);

    await expect(pickComposerFiles({ existingCount: 0, maxBytes: 1024 * 1024 })).resolves.toEqual({
      files: [],
      error: "'archive.zip' exceeds the 1 MB attachment limit.",
    });
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("stops copying an unknown-size content URI when it exceeds the attachment limit", async () => {
    const maxBytes = 1024 * 1024;
    let remainingBytes = maxBytes + 1;
    const source = {
      readBytes: vi.fn((length: number) => {
        const size = Math.min(length, remainingBytes);
        remainingBytes -= size;
        return new Uint8Array(size);
      }),
      close: vi.fn(),
    };
    const destination = { writeBytes: vi.fn(), close: vi.fn() };
    mocks.open.mockImplementation((uri: string) =>
      uri.startsWith("content:") ? source : destination,
    );

    await expect(
      persistComposerAttachmentFile("content://shared/large", "large.bin", maxBytes),
    ).rejects.toThrow("'large.bin' exceeds the 1 MB attachment limit.");

    expect(source.close).toHaveBeenCalledOnce();
    expect(destination.close).toHaveBeenCalledOnce();
    expect(mocks.delete).toHaveBeenCalledWith(
      "file:///documents/t3-composer-attachments/attachment-id-large.bin",
    );
    expect(mocks.copy).not.toHaveBeenCalled();
  });

  it("rejects a copy that delivered more bytes than the source reported", async () => {
    const maxBytes = 1024 * 1024;
    // An Android content: stream can report a small size and still deliver
    // more bytes; the persisted copy is what must satisfy the limit.
    mocks.size.mockImplementation((uri: string) =>
      uri.startsWith("content:") ? 42 : 2 * 1024 * 1024,
    );

    await expect(
      persistComposerAttachmentFile("content://shared/liar", "liar.bin", maxBytes),
    ).rejects.toThrow("'liar.bin' exceeds the 1 MB attachment limit.");

    expect(mocks.copy).toHaveBeenCalledOnce();
    expect(mocks.delete).toHaveBeenCalledWith(
      "file:///documents/t3-composer-attachments/attachment-id-liar.bin",
    );
  });

  it("reports an empty file without calling it oversized", async () => {
    mocks.size.mockReturnValue(0);
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///downloads/empty.txt",
          name: "empty.txt",
          mimeType: "text/plain",
          size: 0,
        },
      ],
    });

    await expect(pickComposerFiles({ existingCount: 0 })).resolves.toEqual({
      files: [],
      error: "'empty.txt' is empty or could not be read.",
    });
  });

  it.each([0, undefined])("copies an Android SAF file when the picker size is %s", async (size) => {
    const reader = {
      readBytes: vi
        .fn()
        .mockReturnValueOnce(new Uint8Array(42))
        .mockReturnValueOnce(new Uint8Array()),
      close: vi.fn(),
    };
    const writer = { writeBytes: vi.fn(), close: vi.fn() };
    mocks.size.mockImplementation((uri: string) => (uri.startsWith("content:") ? 0 : 42));
    mocks.open.mockImplementation((uri: string) => (uri.startsWith("content:") ? reader : writer));
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "content://shared/report",
          name: "report.pdf",
          mimeType: "application/pdf",
          size,
        },
      ],
    });

    await expect(pickComposerFiles({ existingCount: 0 })).resolves.toEqual({
      files: [
        {
          id: "attachment-id",
          type: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 42,
          fileUri: "file:///documents/t3-composer-attachments/attachment-id-report.pdf",
        },
      ],
      error: null,
    });
  });

  it("uses the remaining slot for the first valid file after an oversized selection", async () => {
    mocks.pickFile.mockResolvedValue({
      canceled: false,
      assets: [
        {
          uri: "file:///downloads/huge.zip",
          name: "huge.zip",
          mimeType: "application/zip",
          size: 2 * 1024 * 1024,
        },
        {
          uri: "file:///downloads/report.pdf",
          name: "report.pdf",
          mimeType: "application/pdf",
          size: 42,
        },
      ],
    });

    const result = await pickComposerFiles({ existingCount: 99, maxBytes: 1024 * 1024 });

    expect(result.files.map((file) => file.name)).toEqual(["report.pdf"]);
  });

  it("removes the partial destination file when a copy fails midway", async () => {
    mocks.copy.mockImplementation(() => {
      throw new Error("disk full");
    });

    await expect(
      persistComposerAttachmentFile("file:///downloads/report.pdf", "report.pdf"),
    ).rejects.toThrow("disk full");

    expect(mocks.delete).toHaveBeenCalledWith(
      "file:///documents/t3-composer-attachments/attachment-id-report.pdf",
    );
  });

  it("deletes app-owned attachments without touching user-owned files", async () => {
    await removePersistedComposerAttachmentFile(
      "file:///documents/t3-composer-attachments/report.pdf",
    );
    await removePersistedComposerAttachmentFile("file:///downloads/report.pdf");

    expect(mocks.delete).toHaveBeenCalledOnce();
    expect(mocks.delete).toHaveBeenCalledWith(
      "file:///documents/t3-composer-attachments/report.pdf",
    );
  });

  it("removes a restored attachment from the current iOS document container", async () => {
    const fileName = "33333333-3333-4333-8333-333333333333-report%20%23.pdf";
    const oldUri = `file:///private/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/${fileName}`;
    mocks.documentUri =
      "file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents";

    await removePersistedComposerAttachmentFile(oldUri);
    await removePersistedComposerAttachmentFile(
      `file:///var/mobile/Containers/Shared/FileProvider/other/Documents/t3-composer-attachments/${fileName}`,
    );
    await removePersistedComposerAttachmentFile(
      `${mocks.documentUri}/t3-composer-attachments/..%2F..%2Fsender.pdf`,
    );

    expect(mocks.delete.mock.calls).toEqual([
      [`${mocks.documentUri}/t3-composer-attachments/${fileName}`],
    ]);
  });

  it("rechecks preview ownership after loading the native filesystem", async () => {
    const fileName = "33333333-3333-4333-8333-333333333333-recording.mp4";
    const oldUri = `file:///private/var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/${fileName}`;
    mocks.documentUri =
      "file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents";
    const currentUri = `${mocks.documentUri}/t3-composer-attachments/${fileName}`;

    const deleting = removePersistedComposerAttachmentFile(oldUri);
    const release = retainComposerAttachmentFile(currentUri, () => {});
    try {
      await deleting;
      expect(mocks.delete).not.toHaveBeenCalled();
    } finally {
      release();
    }

    await removePersistedComposerAttachmentFile(oldUri);
    expect(mocks.delete.mock.calls).toEqual([[currentUri]]);
  });

  it("copies an open-in-place source from its actual container without rebasing it", async () => {
    const sourceUri =
      "file:///var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/33333333-3333-4333-8333-333333333333-report.pdf";
    mocks.documentUri =
      "file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents";

    await persistComposerAttachmentFile(sourceUri, "report.pdf");

    expect(mocks.copy).toHaveBeenCalledWith(
      sourceUri,
      `${mocks.documentUri}/t3-composer-attachments/attachment-id-report.pdf`,
    );
    expect(mocks.delete).not.toHaveBeenCalled();
  });
});
