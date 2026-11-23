import { ComposerContextId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import type { ComposerDraft } from "../../state/use-composer-drafts";
import {
  persistScheduledComposerMessage,
  scheduledComposerMessageReason,
} from "./scheduledComposerMessage";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function composer() {
  let draft: ComposerDraft = { text: "Review this code", attachments: [] };
  let pastedTextAttachments = 0;
  let importingContext = false;
  const readDraft = () => draft;
  const readPendingWork = () => ({ pastedTextAttachments, importingContext });
  const persist = vi.fn(async () => "saved");
  const save = (prepare?: () => Promise<void>) =>
    persistScheduledComposerMessage({
      draft,
      readDraft,
      readPendingWork,
      persist,
      ...(prepare ? { prepare } : {}),
    });
  return {
    readDraft,
    readPendingWork,
    persist,
    save,
    beginPaste: async (ready: Promise<void>) => {
      pastedTextAttachments += 1;
      await ready;
      draft = {
        ...draft,
        attachments: [
          {
            id: "pasted",
            type: "file",
            name: "Pasted text.txt",
            mimeType: "text/plain",
            sizeBytes: 1024,
            fileUri: "file:///pasted.txt",
          },
        ],
      };
      pastedTextAttachments -= 1;
    },
    beginContextImport: async (ready: Promise<void>) => {
      importingContext = true;
      await ready;
      draft = {
        ...draft,
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId: ComposerContextId.make("imported"),
              kind: "file",
              label: "Imported context",
              attachmentId: "imported",
              name: "context.txt",
              mimeType: "text/plain",
              sizeBytes: 256,
            },
          ],
        },
      };
      importingContext = false;
    },
    editText: (text: string) => {
      draft = { ...draft, text };
    },
  };
}

describe.each(["existing thread", "new draft"])("scheduled %s composer", (surface) => {
  it.each(["paste", "context"] as const)(
    "blocks a deferred %s before it reaches the draft",
    async (kind) => {
      const c = composer();
      const ready = deferred();
      const preparing =
        kind === "paste" ? c.beginPaste(ready.promise) : c.beginContextImport(ready.promise);
      expect(scheduledComposerMessageReason(c.readDraft(), c.readPendingWork())).toMatch(
        /Wait for/,
      );
      const draftBeforeSave = c.readDraft();
      await expect(c.save(surface === "new draft" ? async () => {} : undefined)).rejects.toThrow(
        /Wait for/,
      );
      expect(c.persist).not.toHaveBeenCalled();
      expect(c.readDraft()).toBe(draftBeforeSave);
      ready.resolve();
      await preparing;
      await expect(c.save()).rejects.toThrow(/Remove attachments and context/);
      expect(c.persist).not.toHaveBeenCalled();
      expect(c.readDraft().text).toBe("Review this code");
    },
  );
});

it.each(["paste", "context"] as const)(
  "rechecks deferred %s work after creating the target",
  async (kind) => {
    const c = composer();
    const target = deferred();
    const ready = deferred();
    const saving = c.save(() => target.promise);
    const preparation =
      kind === "paste" ? c.beginPaste(ready.promise) : c.beginContextImport(ready.promise);
    target.resolve();
    await expect(saving).rejects.toThrow(/Wait for/);
    expect(c.persist).not.toHaveBeenCalled();
    ready.resolve();
    await preparation;
    expect(c.readDraft().text).toBe("Review this code");
  },
);

it("preserves edits made while the schedule target is being created", async () => {
  const c = composer();
  const target = deferred();
  const saving = c.save(() => target.promise);
  c.editText("Review this code and its migrations");
  target.resolve();
  await expect(saving).rejects.toThrow("Your draft changed");
  expect(c.persist).not.toHaveBeenCalled();
  expect(c.readDraft().text).toBe("Review this code and its migrations");
});

it("persists a ready text-only draft after target preparation", async () => {
  const c = composer();
  const target = deferred();
  const saving = c.save(() => target.promise);
  expect(c.persist).not.toHaveBeenCalled();
  target.resolve();
  await expect(saving).resolves.toBe("saved");
  expect(c.persist).toHaveBeenCalledOnce();
});
