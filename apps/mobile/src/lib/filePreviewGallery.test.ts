import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { FilePreviewItem } from "../components/FilePreviewModal.types";
import {
  filePreviewGallery,
  filePreviewKey,
  filePreviewName,
  filePreviewResolutionWindow,
  isSvgPreview,
} from "./filePreviewGallery";

const first: FilePreviewItem = { kind: "image", uri: "https://example.com/first.png" };
const second: FilePreviewItem = { kind: "image", uri: "https://example.com/second.png" };

describe("image preview groups", () => {
  it("preserves ordering, removes duplicates and retains the tapped transition source", () => {
    const selected = { ...second, sourceIdentifier: "thumbnail-2" };
    expect(filePreviewGallery(selected, [first, second, first])).toEqual([first, selected]);
  });

  it("preserves repeated occurrences and videos in an explicit chat gallery", () => {
    const firstOccurrence = { ...first, occurrenceId: "item-1" };
    const repeated = { ...first, occurrenceId: "item-2" };
    const video: FilePreviewItem = {
      kind: "video",
      uri: "https://example.com/clip.mp4",
      occurrenceId: "item-3",
    };
    const selected = { ...video, gallery: [firstOccurrence, video, repeated] };
    expect(filePreviewGallery(selected, [])).toEqual([firstOccurrence, selected, repeated]);
    expect(filePreviewKey(firstOccurrence)).not.toBe(filePreviewKey(repeated));
    expect(filePreviewGallery(video, [firstOccurrence])).toEqual([video]);
  });

  it("keeps documents out of image groups and preserves a standalone image", () => {
    const document: FilePreviewItem = { kind: "pdf", uri: "file:///report.pdf" };
    expect(filePreviewGallery(first, [document])).toEqual([first]);
    expect(filePreviewGallery(document, [first, second])).toEqual([document]);
  });

  it("matches remote originals despite metadata and property order differences", () => {
    const environmentId = EnvironmentId.make("test");
    const a: FilePreviewItem = {
      kind: "image",
      environmentId,
      resource: { _tag: "attachment", attachmentId: "a", fileName: "old.png" },
    };
    const b: FilePreviewItem = {
      kind: "image",
      environmentId,
      resource: {
        attachmentId: "a",
        _tag: "attachment",
        fileName: "new.png",
        mimeType: "image/png",
      },
    };
    expect(filePreviewKey(a)).toBe(filePreviewKey(b));
    expect(filePreviewGallery(b, [a])).toEqual([b]);
  });

  it("uses actual filenames instead of captions with punctuation and paths", () => {
    expect(
      filePreviewName({ ...first, name: 'main: "New thread in..." shows pingdotgg/t3code' }),
    ).toBe("first.png");
    expect(
      filePreviewName({
        kind: "image",
        uri: "https://example.com/image",
        name: "test: before... / after",
      }),
    ).toBe("test_ before___ _ after");
    expect(
      filePreviewName({ kind: "document", uri: "file:///tmp/report.docx", name: "report.docx" }),
    ).toBe("report.docx");
  });
});

describe("in-app image viewer support", () => {
  it("recognizes SVG by type, name, path or data URI", () => {
    const environmentId = EnvironmentId.make("test");
    expect(isSvgPreview({ kind: "image", uri: "https://cdn.test/logo.svg?v=2" })).toBe(true);
    expect(isSvgPreview({ kind: "image", uri: "data:image/svg+xml,%3Csvg/%3E" })).toBe(true);
    expect(
      isSvgPreview({
        kind: "image",
        environmentId,
        resource: {
          _tag: "media-file",
          threadId: ThreadId.make("thread"),
          path: "/repo/diagram.svg",
        },
      }),
    ).toBe(true);
    expect(isSvgPreview({ ...first, mimeType: "image/svg+xml" })).toBe(true);
    expect(isSvgPreview(first)).toBe(false);
    expect(isSvgPreview({ kind: "image", uri: "https://cdn.test/render?format=svgz" })).toBe(false);
  });

  it("resolves the page on screen and its neighbours within the gallery", () => {
    expect(filePreviewResolutionWindow(0, 1)).toEqual([0]);
    expect(filePreviewResolutionWindow(0, 10)).toEqual([0, 1, 2]);
    expect(filePreviewResolutionWindow(5, 10)).toEqual([3, 4, 5, 6, 7]);
    expect(filePreviewResolutionWindow(9, 10)).toEqual([7, 8, 9]);
  });
});
