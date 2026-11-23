import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import {
  ChatAttachment,
  ChatImageAttachment,
  getProviderAttachmentLimitError,
  IMAGE_ATTACHMENT_ORIGINAL_MAX_BYTES,
  isProviderSendTurnSupportedImageMimeType,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  SnapShotAccessibility,
} from "./chatAttachment.ts";

const decodeAttachment = Schema.decodeUnknownEffect(ChatAttachment);
const decodeImage = Schema.decodeUnknownEffect(ChatImageAttachment);
const decodeSnapShotAccessibility = Schema.decodeUnknownEffect(SnapShotAccessibility);

// Attachments ride on persisted events and thread streams with no client
// version negotiation. A type this build does not know must decode instead of
// failing the whole message.
it.effect("tolerates attachment types from newer builds", () =>
  Effect.gen(function* () {
    const attachment = yield* decodeAttachment({
      type: "somethingnew",
      id: "thread-1-00000000-0000-4000-8000-000000000003-glb",
      name: "scene.glb",
      mimeType: "model/gltf-binary",
      sizeBytes: 12,
    });
    assert.strictEqual(attachment.type, "somethingnew");
  }),
);

// The tolerant member must not catch malformed known attachments: a file over
// the size cap or an image with a bad mime has to fail its own schema, not
// slide through the open one with those constraints unchecked.
it.effect("rejects malformed known attachment types instead of tolerating them", () =>
  Effect.gen(function* () {
    const base = {
      id: "thread-1-00000000-0000-4000-8000-000000000003-pdf",
      name: "report.pdf",
      mimeType: "application/pdf",
    };
    const oversizedFile = yield* Effect.exit(
      decodeAttachment({ ...base, type: "file", sizeBytes: PROVIDER_SEND_TURN_MAX_FILE_BYTES + 1 }),
    );
    assert.strictEqual(Exit.isFailure(oversizedFile), true);
    const badMimeImage = yield* Effect.exit(
      decodeAttachment({ ...base, type: "image", mimeType: "application/pdf", sizeBytes: 12 }),
    );
    assert.strictEqual(Exit.isFailure(badMimeImage), true);
  }),
);

it.effect("rejects accessibility trees above the serialized payload limit", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeSnapShotAccessibility({
        format: "element-tree",
        coordinateSpace: "captured-image",
        imageSize: { width: 800, height: 600 },
        truncated: false,
        root: {
          role: "window",
          bounds: { x: 0, y: 0, width: 800, height: 600 },
          children: Array.from({ length: 10 }, () => ({
            role: "text",
            value: "x".repeat(8_000),
            bounds: null,
            children: [],
          })),
        },
      }),
    );

    assert.strictEqual(Exit.isFailure(result), true);
  }),
);

it("isProviderSendTurnSupportedImageMimeType accepts raster formats and rejects svg", () => {
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/png"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("IMAGE/JPEG"), true);
  assert.strictEqual(isProviderSendTurnSupportedImageMimeType("image/svg+xml"), false);
});

const legacyImage = {
  type: "image",
  id: "thread-1-00000000-0000-4000-8000-000000000004",
  name: "photo.png",
  mimeType: "image/png",
  sizeBytes: 12,
};
const original = {
  name: "photo.png",
  mimeType: "image/png",
  sizeBytes: 4_000_000,
  width: 4032,
  height: 3024,
};

it.effect("decodes images saved before originals existed", () =>
  Effect.gen(function* () {
    const attachment = yield* decodeAttachment(legacyImage);
    assert.strictEqual(attachment.type, "image");
    assert.isUndefined("original" in attachment ? attachment.original : undefined);
    assert.isUndefined("sentSize" in attachment ? attachment.sentSize : undefined);
  }),
);

it.effect("round-trips an original reference without changing the sent copy", () =>
  Effect.gen(function* () {
    const attachment = yield* decodeImage({
      ...legacyImage,
      original,
      sentSize: { width: 2000, height: 1500 },
    });
    assert.deepStrictEqual(attachment.original, original);
    assert.strictEqual(attachment.sizeBytes, legacyImage.sizeBytes);
    assert.strictEqual(getProviderAttachmentLimitError([attachment]), undefined);
  }),
);

it.effect("keeps a HEIC camera original", () =>
  Effect.gen(function* () {
    const heic = { ...original, name: "IMG_0001.HEIC", mimeType: "image/heic" };
    const attachment = yield* decodeImage({ ...legacyImage, original: heic });
    assert.deepStrictEqual(attachment.original, heic);
  }),
);

it.effect("rejects originals above the storage cap", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeImage({
        ...legacyImage,
        original: { ...original, sizeBytes: IMAGE_ATTACHMENT_ORIGINAL_MAX_BYTES + 1 },
      }),
    );
    assert.strictEqual(Exit.isFailure(result), true);
  }),
);
