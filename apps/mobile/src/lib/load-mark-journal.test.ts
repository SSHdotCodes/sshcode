import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createLoadMarkJournal } from "./load-mark-journal";

afterEach(() => vi.useRealTimers());

describe("load mark journal", () => {
  it.each(["read", "write"] as const)(
    "stops after failed %s I/O and retries on the next foreground mark",
    async (operation) => {
      vi.useFakeTimers();
      const read = vi.fn(async () => "old\n");
      const write = vi.fn(async (_text: string) => {});
      if (operation === "read") read.mockRejectedValueOnce(new Error("unavailable"));
      else write.mockRejectedValueOnce(new Error("unavailable"));
      const journal = createLoadMarkJournal({ read, write });
      journal.record("launch");
      await vi.advanceTimersByTimeAsync(2_000);
      const reads = read.mock.calls.length;
      const writes = write.mock.calls.length;
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(read).toHaveBeenCalledTimes(reads);
      expect(write).toHaveBeenCalledTimes(writes);
      journal.record("app.active");
      await vi.advanceTimersByTimeAsync(2_000);
      expect(write).toHaveBeenLastCalledWith("old\nlaunch\napp.active\n");
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("flushes a mark whose timer fired during an earlier in-flight write", async () => {
    vi.useFakeTimers();
    const firstWrite = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const write = vi
      .fn()
      .mockImplementationOnce(() => {
        started.resolve();
        return firstWrite.promise;
      })
      .mockResolvedValue(undefined);
    const journal = createLoadMarkJournal({ read: async () => "old\n", write });
    journal.record("launch");
    const pending = journal.flush();
    await started.promise;
    journal.record("chat");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(write).toHaveBeenCalledTimes(1);
    firstWrite.resolve();
    await pending;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(write).toHaveBeenLastCalledWith("old\nlaunch\nchat\n");
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does no history work while recording startup and keeps marks arriving during a read", async () => {
    vi.useFakeTimers();
    const history = Promise.withResolvers<string>();
    const read = vi.fn(() => history.promise);
    const write = vi.fn(async (_text: string) => {});
    const journal = createLoadMarkJournal({ read, write });
    journal.record("launch");
    expect(read).not.toHaveBeenCalled();
    const pending = journal.flush();
    journal.record("chat-list");
    expect(write).not.toHaveBeenCalled();
    history.resolve("old-launch\nold-chat\n");
    await pending;
    expect(write).toHaveBeenLastCalledWith("old-launch\nold-chat\nlaunch\nchat-list\n");
  });

  it("does not overwrite unread history after a read error, and retries without losing marks", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockRejectedValueOnce(new Error("disk busy")).mockResolvedValue("old\n");
    const write = vi.fn(async (_text: string) => {});
    const journal = createLoadMarkJournal({ read, write });
    journal.record("launch");
    await expect(journal.flush()).rejects.toThrow("disk busy");
    expect(write).not.toHaveBeenCalled();
    journal.record("visible");
    await journal.flush();
    expect(write).toHaveBeenCalledWith("old\nlaunch\nvisible\n");
  });

  it("serializes writes, retains concurrent marks and keeps the existing history bound", async () => {
    vi.useFakeTimers();
    const firstWrite = Promise.withResolvers<void>();
    const write = vi
      .fn()
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(undefined);
    const journal = createLoadMarkJournal({ read: async () => "a\nb\n", write, limit: 3 });
    journal.record("c");
    const pending = journal.flush();
    await Promise.resolve();
    await Promise.resolve();
    journal.record("d");
    expect(journal.flush()).toBe(pending);
    firstWrite.resolve();
    await pending;
    await journal.flush();
    expect(write).toHaveBeenLastCalledWith("b\nc\nd\n");
    expect(await journal.read()).toBe("b\nc\nd\n");
  });
});
