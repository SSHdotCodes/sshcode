import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { createMemoryStorage } from "./lib/storage";

const environmentId = EnvironmentId.make("env");
const first = scopeThreadRef(environmentId, ThreadId.make("first"));
const second = scopeThreadRef(environmentId, ThreadId.make("second"));
let storage: Storage;

async function openTab() {
  vi.resetModules();
  return (await import("./composerDraftStore")).useComposerDraftStore;
}

const save = () => vi.advanceTimersByTimeAsync(300);

beforeEach(() => {
  storage = createMemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it("retains drafts for different chats edited by two tabs sharing the same origin", async () => {
  const one = await openTab();
  const two = await openTab();
  one.getState().setPrompt(first, "First unsent draft");
  await save();
  two.getState().setPrompt(second, "Second unsent draft");
  await save();

  const reopened = (await openTab()).getState().draftsByThreadKey;
  expect(reopened[scopedThreadKey(second)]?.prompt).toBe("Second unsent draft");
  expect(reopened[scopedThreadKey(first)]?.prompt).toBe("First unsent draft");
});

it.each(["current storage", "existing v9 snapshot"])(
  "keeps a cleared draft out of %s when another tab saves",
  async (format) => {
    if (format === "existing v9 snapshot") {
      storage.setItem(
        "t3code:composer-drafts:v1",
        JSON.stringify({
          version: 9,
          state: {
            draftsByThreadKey: { [scopedThreadKey(first)]: { prompt: "Unsent", attachments: [] } },
            draftThreadsByThreadKey: {},
            logicalProjectDraftThreadKeyByLogicalProjectKey: {},
          },
        }),
      );
    } else {
      const tab = await openTab();
      tab.getState().setPrompt(first, "Unsent");
      await save();
    }

    const one = await openTab();
    const two = await openTab();
    expect(one.getState().getComposerDraft(first)?.prompt).toBe("Unsent");
    expect(two.getState().getComposerDraft(first)?.prompt).toBe("Unsent");

    one.getState().clearComposerContent(first);
    await save();
    two.getState().setPrompt(second, "Other tab draft");
    await save();

    const reopened = (await openTab()).getState();
    expect(reopened.getComposerDraft(first)).toBeNull();
    expect(reopened.getComposerDraft(second)?.prompt).toBe("Other tab draft");
  },
);

it("keeps the last write to a shared chat and deletes storage for cleared new drafts", async () => {
  const one = await openTab();
  const two = await openTab();
  one.getState().setPrompt(first, "Earlier write");
  two.getState().setPrompt(first, "Later write");
  await save();

  const reopened = await openTab();
  expect(reopened.getState().getComposerDraft(first)?.prompt).toBe("Later write");
  for (let index = 0; index < 5; index++) {
    const thread = scopeThreadRef(environmentId, ThreadId.make(`cleared-${index}`));
    reopened.getState().setPrompt(thread, "Discard me");
    await save();
    reopened.getState().clearComposerContent(thread);
    await save();
  }
  expect(storage.length).toBe(1);
});

it("persists a clear even when the tab never saved its own copy of the draft", async () => {
  const one = await openTab();
  const two = await openTab();
  one.getState().setPrompt(first, "Shared draft");
  await save();

  two.getState().setPrompt(first, "Shared draft");
  two.getState().clearComposerContent(first);
  await save();
  one.getState().setPrompt(second, "Other tab draft");
  await save();

  const reopened = (await openTab()).getState();
  expect(reopened.getComposerDraft(first)).toBeNull();
  expect(reopened.getComposerDraft(second)?.prompt).toBe("Other tab draft");
});

it("marks attachments as unavailable when the saved draft cannot be read", async () => {
  const tab = await openTab();
  const file = new File(["image fixture"], "test.png", { type: "image/png" });
  const attachment = { id: "image", name: file.name, mimeType: file.type, sizeBytes: file.size };
  tab
    .getState()
    .addImage(first, { ...attachment, type: "image", file, previewUrl: "blob:fixture" });
  const setItem = storage.setItem.bind(storage);
  vi.spyOn(storage, "setItem").mockImplementationOnce((key) => setItem(key, "{invalid"));
  await tab
    .getState()
    .syncPersistedAttachments(first, [{ ...attachment, dataUrl: "data:image/png;base64,AA==" }]);
  const restored = tab.getState().getComposerDraft(first);
  expect(restored?.persistedAttachments).toEqual([]);
  expect(restored?.nonPersistedImageIds).toEqual([attachment.id]);
});

it("keeps newly saved images when two draft attachment saves overlap", async () => {
  const tab = await openTab();
  const images = ["first", "second"].map((id) => {
    const file = new File([id], `${id}.png`, { type: "image/png" });
    return { id, name: file.name, mimeType: file.type, sizeBytes: file.size, file };
  });
  const persistedImages = images.map(({ file: _file, ...image }) => ({
    ...image,
    dataUrl: "data:image/png;base64,AA==",
  }));
  const draft = tab.getState();
  draft.addImage(first, { ...images[0]!, type: "image", previewUrl: "blob:first" });
  const firstSave = draft.syncPersistedAttachments(first, persistedImages.slice(0, 1));
  draft.addImage(first, { ...images[1]!, type: "image", previewUrl: "blob:second" });
  await Promise.all([firstSave, draft.syncPersistedAttachments(first, persistedImages)]);
  await save();

  const reopened = await openTab();
  expect(
    reopened
      .getState()
      .getComposerDraft(first)
      ?.images.map((image) => image.id),
  ).toEqual(["first", "second"]);
});
