import { EnvironmentId, ThreadId, type ChatAttachment } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

// Draft attachments pull in Expo's file modules; sent messages are what this covers.
vi.mock("../../lib/composerImageGallery", () => ({ composerImageGallery: () => [] }));

import { filePreviewKey } from "../../lib/filePreviewGallery";
import { messageImageGallery, threadImageGallery } from "./messageImageGallery";

const context = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  workspaceRoot: "/repo",
};

const picture: ChatAttachment = {
  type: "image",
  id: "upload-1",
  name: "photo.png",
  mimeType: "image/png",
  sizeBytes: 10,
};

function keys(
  items: ReturnType<typeof messageImageGallery> | ReturnType<typeof threadImageGallery>,
) {
  return items.map((item) => ("uri" in item ? item.uri : filePreviewKey(item)));
}

describe("messageImageGallery", () => {
  it("retains attachment resources for saving after paging to another image", () => {
    const [image] = messageImageGallery(
      { role: "assistant", text: "", attachments: [picture] },
      context,
    );
    expect(image?.actionsSource).toEqual({
      environmentId: context.environmentId,
      resource: image && "resource" in image ? image.resource : undefined,
      name: picture.name,
      mimeType: picture.mimeType,
    });
  });

  it("orders images the way each bubble shows them", () => {
    const text = "Before ![chart](https://cdn.test/chart.png)";
    const attachmentKey = filePreviewKey({
      kind: "image",
      environmentId: context.environmentId,
      resource: { _tag: "attachment", attachmentId: "upload-1" },
    });
    expect(
      keys(messageImageGallery({ role: "user", text, attachments: [picture] }, context)),
    ).toEqual([attachmentKey, "https://cdn.test/chart.png"]);
    expect(
      keys(messageImageGallery({ role: "assistant", text, attachments: [picture] }, context)),
    ).toEqual(["https://cdn.test/chart.png", attachmentKey]);
  });
});

describe("threadImageGallery", () => {
  const first = {
    type: "message",
    message: { role: "assistant", text: "![one](https://cdn.test/one.png)" },
  };
  const second = {
    type: "message",
    message: {
      role: "assistant",
      text: "![two](https://cdn.test/two.png)\n![three](https://cdn.test/three.png)",
    },
  };

  it("collects every message's images in feed order and skips other rows", () => {
    const gallery = threadImageGallery(
      [first, { type: "work-toggle" }, second, { type: "message", message: { text: "No art" } }],
      context,
    );
    expect(keys(gallery)).toEqual([
      "https://cdn.test/one.png",
      "https://cdn.test/two.png",
      "https://cdn.test/three.png",
    ]);
  });

  it("keeps its identity while streamed text leaves the images unchanged", () => {
    const gallery = threadImageGallery([first, second], context);
    const streamed = {
      type: "message",
      message: { ...second.message, text: `${second.message.text}\n\nMore words` },
    };
    expect(threadImageGallery([first, streamed], context, gallery)).toBe(gallery);

    const grown = {
      type: "message",
      message: {
        ...second.message,
        text: `${second.message.text}\n![four](https://cdn.test/4.png)`,
      },
    };
    const next = threadImageGallery([first, grown], context, gallery);
    expect(next).not.toBe(gallery);
    expect(keys(next).at(-1)).toBe("https://cdn.test/4.png");
  });
});
