import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { DraftComposerImageAttachment } from "./composerImages";
import { mediaActionByteSource, type MediaActionsSource } from "./mediaActionsSource";

const environmentId = EnvironmentId.make("environment-1");
const original = {
  name: "full.png",
  mimeType: "image/png" as const,
  sizeBytes: 8,
  width: 4032,
  height: 3024,
};

describe("mediaActionByteSource", () => {
  it("keeps sources without an original unchanged", () => {
    const source: MediaActionsSource = {
      uri: "https://cdn.test/image.png",
      name: "image.png",
      mimeType: "image/png",
    };
    expect(mediaActionByteSource(source)).toBe(source);
  });

  it("targets the original sidecar for remote save and share", () => {
    const source: MediaActionsSource = {
      environmentId,
      resource: { _tag: "attachment", attachmentId: "upload", fileName: "sent.png" },
      name: "sent.png",
      mimeType: "image/png",
      original,
    };
    expect(mediaActionByteSource(source)).toMatchObject({
      name: "full.png",
      mimeType: "image/png",
      resource: {
        _tag: "attachment",
        attachmentId: "upload",
        fileName: "full.png",
        original: true,
      },
    });
  });

  it("shares the owned original file for a local draft", () => {
    const attachment = {
      id: "draft-1",
      type: "image",
      name: "sent.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUri: "file:///documents/sent.png",
      fileUri: "file:///documents/sent.png",
      originalFileUri: "file:///documents/full.png",
      original,
    } satisfies DraftComposerImageAttachment;
    const source: MediaActionsSource = {
      attachment,
      name: attachment.name,
      mimeType: attachment.mimeType,
      original,
    };
    expect(mediaActionByteSource(source)).toMatchObject({
      name: "full.png",
      attachment: {
        fileUri: "file:///documents/full.png",
        name: "full.png",
        sizeBytes: 8,
      },
    });
  });
});
