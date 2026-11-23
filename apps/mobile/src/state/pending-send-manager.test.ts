import { AtomRegistry } from "effect/reactivity";
import { CommandId, EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createPendingSendManager, type PendingSendStorage } from "./pending-send-manager";
import { PendingSendSchema, type PendingSend } from "./pending-send-model";
import * as Schema from "effect/Schema";

const decodeSend = Schema.decodeUnknownSync(PendingSendSchema);

const registries: AtomRegistry.AtomRegistry[] = [];
function harness(saved: Map<string, PendingSend> = new Map()) {
  const registry = AtomRegistry.make();
  registries.push(registry);
  const storage: PendingSendStorage = {
    load: vi.fn(async () => ({ sends: [...saved.values()], errors: [] })),
    write: vi.fn(async (send) => {
      saved.set(send.id, structuredClone(send));
    }),
    remove: vi.fn(async (send) => {
      saved.delete(send.id);
    }),
  };
  const manager = createPendingSendManager(registry, storage);
  return { manager, storage, saved, sends: () => registry.get(manager.sendsAtom) };
}
const side: PendingSend = {
  id: CommandId.make("side-stable-id"),
  environmentId: EnvironmentId.make("desk"),
  threadId: ThreadId.make("thread"),
  createdAt: "2026-10-20T12:00:00.000Z",
  kind: "side-question",
  prompt: "Did that message arrive?",
};
const answer: PendingSend = {
  id: CommandId.make("answer-stable-id"),
  environmentId: side.environmentId,
  threadId: side.threadId,
  createdAt: side.createdAt,
  kind: "user-input",
  requestId: RuntimeRequestId.make("question"),
  answers: { choice: "Use TypeScript" },
  attachmentsByQuestionId: {
    choice: [
      { type: "image", id: "image", name: "screen.png", mimeType: "image/png", sizeBytes: 42 },
    ],
  },
};
afterEach(() => registries.splice(0).forEach((registry) => registry.dispose()));

describe("durable side questions and card answers", () => {
  it.each([side, answer])(
    "recovers $kind after a killed app with exactly the same wire id and payload",
    async (send) => {
      const first = harness();
      const gate = Promise.withResolvers<void>();
      vi.mocked(first.storage.write).mockImplementationOnce(async (value) => {
        await gate.promise;
        first.saved.set(value.id, structuredClone(value));
      });
      const writing = first.manager.enqueue(send);
      expect(first.sends()).toEqual([]);
      gate.resolve();
      await writing;
      const next = harness(first.saved);
      await next.manager.load();
      expect(next.sends()).toEqual([send]);
      expect(decodeSend(next.sends()[0])).toEqual(send);
    },
  );

  it("keeps a failed disk write out of the queue so the input still owns the content", async () => {
    const h = harness();
    vi.mocked(h.storage.write).mockRejectedValueOnce(new Error("disk full"));
    await expect(h.manager.enqueue(side)).rejects.toThrow("disk full");
    expect(h.sends()).toEqual([]);
  });

  it("keeps the first payload and id when a duplicate tap supplies a new id", async () => {
    const h = harness();
    await h.manager.enqueue(side);
    const result = await h.manager.enqueue({ ...side, id: CommandId.make("new-id") });
    expect(result).toEqual(side);
    expect(h.sends()).toEqual([side]);
    expect(h.storage.write).toHaveBeenCalledTimes(1);
  });

  it("keeps a second slash question in its composer while the first is pending", async () => {
    const h = harness();
    await h.manager.enqueue(side);
    await expect(
      h.manager.enqueue({
        ...side,
        id: CommandId.make("second-question"),
        prompt: "another question",
      }),
    ).rejects.toThrow("already waiting");
    expect(h.sends()).toEqual([side]);
  });

  it("does not resurrect a delivered question when a late retry arrives", async () => {
    const h = harness();
    await h.manager.enqueue(side);
    await h.manager.remove(side);
    await h.manager.retry(side);
    expect(h.sends()).toEqual([]);
    expect(h.saved.size).toBe(0);
  });

  it("retains a rejected answer and its files across restart, then replaces it durably on retry", async () => {
    const h = harness();
    await h.manager.enqueue(answer);
    await h.manager.fail(answer, "This question is no longer available.");
    const next = harness(h.saved);
    await next.manager.load();
    expect(next.sends()[0]?.error).toBe("This question is no longer available.");
    expect(next.sends()[0]).toMatchObject({
      answers: { choice: "Use TypeScript" },
      attachmentsByQuestionId:
        answer.kind === "user-input" ? answer.attachmentsByQuestionId : undefined,
    });
    const retry = { ...answer, id: CommandId.make("retry-after-rejection") };
    await next.manager.enqueue(retry);
    expect(next.sends()).toEqual([retry]);
    expect([...h.saved.values()]).toEqual([retry]);
  });

  it("does not forget an acknowledged send if removing its file fails", async () => {
    const h = harness();
    await h.manager.enqueue(side);
    vi.mocked(h.storage.remove).mockRejectedValueOnce(new Error("file busy"));
    await expect(h.manager.remove(side)).rejects.toThrow("file busy");
    expect(h.sends()).toEqual([side]);
    await h.manager.remove(side);
    expect(h.sends()).toEqual([]);
    const next = harness(h.saved);
    await next.manager.load();
    expect(next.sends()).toEqual([]);
  });

  it("preserves readable pending sends and reports a partial load failure", async () => {
    const h = harness();
    vi.mocked(h.storage.load).mockResolvedValue({
      sends: [side],
      errors: [new Error("unreadable answer")],
    });
    await expect(h.manager.load()).rejects.toThrow("Some pending sends could not be read.");
    expect(h.sends()).toEqual([side]);
  });
});
