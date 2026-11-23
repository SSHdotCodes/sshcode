import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const read = vi.hoisted(() => vi.fn<(file: File) => Promise<string>>());
vi.mock("../../lib/imageCompression", () => ({ readFileAsDataUrl: read }));

let store: typeof import("../../composerDraftStore").useComposerDraftStore;
let target: import("../../composerDraftStore").DraftId;
let persistImages: typeof import("./queuedMessageEdit").persistQueuedEditImages;
const image = {
  type: "image" as const,
  id: "picture",
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 3,
  file: new File(["png"], "screen.png", { type: "image/png" }),
  previewUrl: "blob:picture",
};

beforeEach(async () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("window", { localStorage: storage, addEventListener: () => {} });
  const drafts = await import("../../composerDraftStore");
  store = drafts.useComposerDraftStore;
  target = drafts.DraftId.make("queued-edit:image-test");
  persistImages = (await import("./queuedMessageEdit")).persistQueuedEditImages;
  read.mockReset();
  // The first import loads the composer's whole module graph. In a full run on a busy
  // machine that alone has outlasted the default hook timeout.
}, 60_000);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("queued edit image persistence", () => {
  it("persists images even after the editing composer is no longer mounted", async () => {
    store.getState().addImages(target, [image]);
    read.mockResolvedValue("data:image/png;base64,cG5n");
    await persistImages(target);
    expect(store.getState().getComposerDraft(target)?.persistedAttachments).toMatchObject([
      { id: "picture", dataUrl: "data:image/png;base64,cG5n" },
    ]);
  });
  it("does not resurrect an image removed during encoding", async () => {
    store.getState().addImages(target, [image]);
    let finish!: (value: string) => void;
    read.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = persistImages(target);
    store.getState().removeImage(target, image.id);
    finish("data:image/png;base64,cG5n");
    await pending;
    expect(store.getState().getComposerDraft(target)?.persistedAttachments ?? []).toEqual([]);
  });
});
