import { CommandId, EnvironmentId, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { QueuedThreadMessage } from "./thread-outbox-model";

const mock = vi.hoisted(() => ({
  calls: [] as string[],
  attachments: [] as Array<{ id: string }>,
  confirm: vi.fn(async () => true),
  remove: vi.fn<typeof import("./thread-outbox-removal").removeThreadOutboxMessage>(),
  merge: vi.fn<typeof import("./use-composer-drafts").mergeComposerDraftContent>(),
  settings: vi.fn(),
}));
vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  digestStringAsync: async (_algorithm: string, value: string) => `hash:${value.length}`,
}));
vi.mock("./projects", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentProjects: { projectsAtom: Atom.make([{ environmentId: "env", id: "project" }]) },
  };
});
vi.mock("./threads", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentThreadShells: {
      threadShellsAtom: Atom.make([{ environmentId: "env", id: "new", archivedAt: null }]),
    },
  };
});
vi.mock("./thread-outbox", () => ({
  confirmThreadOutboxMessageQueued: mock.confirm,
  threadOutboxRevision: () => 7,
}));
vi.mock("./thread-outbox-removal", () => ({ removeThreadOutboxMessage: mock.remove }));
vi.mock("./use-thread-outbox", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    editingQueuedMessageIdsAtom: Atom.make({}),
    holdEditingQueuedMessage: vi.fn(),
    releaseEditingQueuedMessage: vi.fn(),
  };
});
vi.mock("./use-composer-drafts", () => ({
  waitForComposerDraftsLoaded: async () => {},
  getComposerDraftSnapshot: () => ({ text: "", attachments: mock.attachments }),
  updateComposerDraftSettings: mock.settings,
  mergeComposerDraftContent: mock.merge,
}));

import { discardRecoveredOutboxMessage, recoverOutboxMessage } from "./recover-outbox-message";

const message: QueuedThreadMessage = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("old"),
  messageId: MessageId.make("message"),
  commandId: CommandId.make("command"),
  text: "hello",
  createdAt: "2026-10-26T12:00:00.000Z",
  recoveryReason: "missing-thread",
  attachments: [
    {
      type: "file",
      id: "file",
      name: "note.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      fileUri: "file:///note.txt",
    },
  ],
};
const thread = {
  kind: "thread" as const,
  environmentId: message.environmentId,
  threadId: ThreadId.make("new"),
};

beforeEach(() => {
  mock.calls = [];
  mock.attachments = [];
  mock.confirm.mockReset().mockResolvedValue(true);
  mock.remove.mockReset().mockImplementation(async () => {
    mock.calls.push("remove");
    return true;
  });
  mock.merge.mockReset().mockImplementation(async () => {
    mock.calls.push("save");
    return { skippedAttachmentCount: 0 };
  });
  mock.settings.mockReset();
});

describe("outbox recovery", () => {
  it("saves the complete draft before removing the queued message", async () => {
    expect(await recoverOutboxMessage(message, thread)).toBe("env:new");
    expect(mock.calls).toEqual(["save", "remove"]);
    expect(mock.merge).toHaveBeenCalledWith(
      "env:new",
      expect.objectContaining({
        text: "hello",
        attachments: message.attachments,
        sourceShareId: expect.stringMatching(/^outbox-recovery:message:hash:/),
      }),
    );
    expect(mock.remove).toHaveBeenCalledWith(message, 7, expect.any(Function));
  });
  it("saves a new chat draft in the selected project", async () => {
    const destination = {
      kind: "new" as const,
      environmentId: message.environmentId,
      projectId: ProjectId.make("project"),
    };
    expect(await recoverOutboxMessage(message, destination)).toBe("new-task:restored-message");
    expect(mock.settings).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        project: expect.objectContaining({ projectId: destination.projectId }),
      }),
    );
  });
  it("keeps the outbox entry if saving or removal fails", async () => {
    mock.merge.mockRejectedValueOnce(new Error("disk full"));
    await expect(recoverOutboxMessage(message, thread)).rejects.toThrow("disk full");
    expect(mock.remove).not.toHaveBeenCalled();
    mock.remove.mockResolvedValueOnce(false);
    await expect(recoverOutboxMessage(message, thread)).rejects.toThrow("still saved");
  });
  it("gives changed content a different recovery receipt", async () => {
    await recoverOutboxMessage(message, thread);
    const first = mock.merge.mock.calls[0]![1].sourceShareId;
    await recoverOutboxMessage({ ...message, text: "changed instructions" }, thread);
    expect(mock.merge.mock.calls[1]![1].sourceShareId).not.toBe(first);
  });
  it("keeps the outbox if the destination disappears while saving", async () => {
    const { appAtomRegistry } = await import("./atom-registry");
    const { environmentThreadShells } = await import("./threads");
    const writable =
      environmentThreadShells.threadShellsAtom as typeof environmentThreadShells.threadShellsAtom &
        import("effect/reactivity").Atom.Writable<ReadonlyArray<unknown>, ReadonlyArray<unknown>>;
    mock.merge.mockImplementationOnce(async () => {
      appAtomRegistry.set(writable, []);
      return { skippedAttachmentCount: 0 };
    });
    mock.remove.mockImplementationOnce(
      async (_message, _revision, canRemove) => canRemove?.() ?? true,
    );
    await expect(recoverOutboxMessage(message, thread)).rejects.toThrow("still saved");
    appAtomRegistry.set(writable, [{ environmentId: "env", id: "new", archivedAt: null }]);
  });
  it("discards only a still-current queued message", async () => {
    mock.confirm.mockResolvedValueOnce(false);
    await expect(discardRecoveredOutboxMessage(message)).rejects.toThrow("changed");
    expect(mock.remove).not.toHaveBeenCalled();
    await discardRecoveredOutboxMessage(message);
    expect(mock.remove).toHaveBeenCalledWith(message, 7);
  });
  it("does not drop attachments when the destination is full", async () => {
    const { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } = await import("@t3tools/contracts");
    mock.attachments = Array.from({ length: PROVIDER_SEND_TURN_MAX_ATTACHMENTS }, (_, index) => ({
      id: String(index),
    }));
    await expect(recoverOutboxMessage(message, thread)).rejects.toThrow("too many attachments");
    expect(mock.merge).not.toHaveBeenCalled();
    expect(mock.remove).not.toHaveBeenCalled();
  });
});
