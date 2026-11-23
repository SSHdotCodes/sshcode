import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DraftComposerAttachment } from "../lib/composerImages";

const state = vi.hoisted(() => ({
  attachments: [] as DraftComposerAttachment[],
  convert: vi.fn(),
  append: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("../lib/composerImages", () => ({ convertPastedImagesToAttachments: state.convert }));
vi.mock("./use-composer-drafts", () => ({
  getComposerDraftSnapshot: () => ({ attachments: state.attachments }),
  appendComposerDraftAttachments: state.append,
  replaceComposerDraftAttachment: state.replace,
}));
import { attachMarkedImage, markupDraftAttachment } from "./imageMarkupAttachment";

const original = {
  type: "image" as const,
  id: "original",
  name: "original.png",
  mimeType: "image/png",
  sizeBytes: 1,
  previewUri: "file:///original.png",
  dataUrl: "data:image/png;base64,YQ==",
};
const marked = { ...original, id: "marked", previewUri: "file:///marked.png" };
const input = { draftKey: "env:thread", uri: "file:///marked.png", name: "original-marked.png" };

beforeEach(() => {
  vi.resetAllMocks();
  state.attachments = [original];
  state.convert.mockResolvedValue([marked]);
  state.append.mockReturnValue(0);
  state.replace.mockReturnValue(true);
});
describe("marked image attachments", () => {
  it("adds through the existing image importer with a composer reference", async () => {
    await attachMarkedImage(input);
    expect(state.convert).toHaveBeenCalledWith({ uris: [input.uri], existingCount: 1 });
    expect(state.append).toHaveBeenCalledWith(
      input.draftKey,
      [{ ...marked, name: input.name, previewUri: marked.dataUrl }],
      {
        appendReference: true,
      },
    );
    expect(state.replace).not.toHaveBeenCalled();
  });
  it("replaces at capacity using a fresh attachment id", async () => {
    await attachMarkedImage({ ...input, replaceId: original.id });
    expect(state.convert).toHaveBeenCalledWith({ uris: [input.uri], existingCount: 0 });
    expect(state.replace).toHaveBeenCalledWith(input.draftKey, original.id, {
      ...marked,
      name: input.name,
      previewUri: marked.dataUrl,
    });
    expect(state.append).not.toHaveBeenCalled();
  });
  it("does not resurrect a removed attachment while importing", async () => {
    state.convert.mockImplementation(async () => {
      state.attachments = [];
      return [marked];
    });
    await expect(attachMarkedImage({ ...input, replaceId: original.id })).rejects.toThrow(
      "draft changed",
    );
    expect(state.replace).not.toHaveBeenCalled();
  });
  it("reports rejected imports and raced attachment limits", async () => {
    state.convert.mockResolvedValueOnce([]);
    await expect(attachMarkedImage(input)).rejects.toThrow("could not be attached");
    state.append.mockReturnValue(1);
    await expect(attachMarkedImage(input)).rejects.toThrow("attachment limit");
  });
  it("recognizes a draft page after its preview URI is materialized", () => {
    expect(
      markupDraftAttachment(input.draftKey, {
        uri: "file:///cache/rebased.png",
        draftAttachmentId: original.id,
      }),
    ).toBe(original);
    expect(markupDraftAttachment(input.draftKey, { uri: original.dataUrl })).toBe(original);
    expect(markupDraftAttachment(input.draftKey, { uri: "file:///message.png" })).toBeUndefined();
  });
});
