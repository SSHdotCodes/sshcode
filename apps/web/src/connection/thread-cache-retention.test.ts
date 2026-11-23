import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  makeThreadCacheRetention,
  type ThreadCacheBackend,
  type ThreadCacheIndex,
} from "./thread-cache-retention";

const environment = EnvironmentId.make("environment");
const other = EnvironmentId.make("other");
const key = (id: string, env = environment) => `${env}:${id}`;
const write = (id: string, env = environment) => ({
  key: key(id, env),
  snapshot: "a".repeat(100),
  preview: { version: 1, preview: null },
});

function memoryBackend() {
  const values = new Map<string, unknown>();
  const indexes = new Map<EnvironmentId, ThreadCacheIndex>();
  let failCommit = false;
  const backend: ThreadCacheBackend = {
    readIndex: async (environmentId) =>
      indexes.get(environmentId) ?? { version: 1, clock: 0, entries: {} },
    commit: async (environmentId, index, removed, next) => {
      if (failCommit) throw new DOMException("Quota exceeded", "QuotaExceededError");
      for (const key of removed) {
        values.delete(key);
        values.delete(`${key}#preview`);
      }
      if (next) {
        values.set(next.key, next.snapshot);
        values.set(`${next.key}#preview`, next.preview);
      }
      indexes.set(environmentId, structuredClone(index));
    },
  };
  return {
    backend,
    values,
    fail: () => {
      failCommit = true;
    },
  };
}

/** Models shared/exclusive Web Locks across separate cache runtimes. */
function browserLocks() {
  const held = new Map<string, Array<"shared" | "exclusive">>();
  const waiting = new Map<string, Array<() => void>>();
  const request = async <A>(
    name: string,
    optionsOrRun: LockOptions | ((lock: Lock | null) => Promise<A>),
    callback?: (lock: Lock | null) => Promise<A>,
  ): Promise<A> => {
    const options = typeof optionsOrRun === "function" ? {} : optionsOrRun;
    const run = typeof optionsOrRun === "function" ? optionsOrRun : callback!;
    const mode = options.mode ?? "exclusive";
    const blocked = () =>
      (held.get(name)?.length ?? 0) > 0 &&
      (mode === "exclusive" || held.get(name)!.includes("exclusive"));
    if (options.ifAvailable && blocked()) return run(null);
    while (blocked()) {
      await new Promise<void>((resolve) =>
        waiting.set(name, [...(waiting.get(name) ?? []), resolve]),
      );
    }
    const holders = held.get(name) ?? [];
    holders.push(mode);
    held.set(name, holders);
    try {
      return await run({ name, mode } as Lock);
    } finally {
      holders.splice(holders.indexOf(mode), 1);
      const queued = waiting.get(name) ?? [];
      waiting.delete(name);
      for (const resume of queued) resume();
    }
  };
  return { request } as unknown as LockManager;
}

describe("web thread snapshot retention", () => {
  it("budgets UTF-8 bytes rather than character counts", async () => {
    const memory = memoryBackend();
    const cache = makeThreadCacheRetention({ ...memory, locks: browserLocks(), maxBytes: 450 });
    await cache.save(environment, { ...write("emoji"), snapshot: "😀".repeat(50) });
    await cache.save(environment, write("new"));
    expect(memory.values.has(key("emoji"))).toBe(false);
    expect(memory.values.has(key("new"))).toBe(true);
  });

  it("brings an existing oversized cache under budget on a read without needing another server update", async () => {
    const memory = memoryBackend();
    const oldCache = makeThreadCacheRetention(memory);
    await oldCache.save(environment, write("oldest"));
    await oldCache.save(environment, write("open"));
    await oldCache.save(environment, write("recent"));
    const cache = makeThreadCacheRetention({ ...memory, locks: browserLocks(), maxBytes: 500 });
    await cache.touch(environment, ThreadId.make("open"));
    expect(memory.values.has(key("oldest"))).toBe(false);
    expect(memory.values.has(key("open"))).toBe(true);
    expect(memory.values.has(key("recent"))).toBe(true);
  });

  it("evicts by last read within one environment and removes previews with snapshots", async () => {
    const memory = memoryBackend();
    const cache = makeThreadCacheRetention({
      ...memory,
      locks: browserLocks(),
      maxBytes: 500,
      now: () => 1,
    });
    await cache.save(environment, write("first"));
    await cache.save(environment, write("second"));
    await cache.save(other, write("other", other));
    await cache.touch(environment, ThreadId.make("first"));
    await cache.save(environment, write("third"));
    expect(memory.values.has(key("first"))).toBe(true);
    expect(memory.values.has(key("second"))).toBe(false);
    expect(memory.values.has(`${key("second")}#preview`)).toBe(false);
    expect(memory.values.has(key("third"))).toBe(true);
    expect(memory.values.has(key("other", other))).toBe(true);
  });

  it("protects open threads across tabs until their scopes release the browser lock", async () => {
    const memory = memoryBackend();
    const locks = browserLocks();
    const firstTab = makeThreadCacheRetention({ ...memory, locks, maxBytes: 500 });
    const secondTab = makeThreadCacheRetention({ ...memory, locks, maxBytes: 500 });
    const release = await firstTab.retain(environment, ThreadId.make("open"));
    await firstTab.save(environment, write("open"));
    await secondTab.save(environment, write("closed"));
    await secondTab.save(environment, write("third"));
    expect(memory.values.has(key("open"))).toBe(true);
    expect(memory.values.has(key("closed"))).toBe(false);
    release();
    await secondTab.save(environment, write("fourth"));
    expect(memory.values.has(key("open"))).toBe(false);
  });

  it("leaves drafts and outboxes untouched and keeps snapshots with unsent work", async () => {
    const memory = memoryBackend();
    memory.values.set("composer-drafts", { prompt: "unsent" });
    memory.values.set("outbox", { message: "not yet delivered" });
    const protectedKeys = new Set([key("draft")]);
    const cache = makeThreadCacheRetention({
      ...memory,
      locks: browserLocks(),
      maxBytes: 500,
      protectedKeys: () => protectedKeys,
    });
    await cache.save(environment, write("draft"));
    await cache.save(environment, write("old"));
    await cache.save(environment, write("new"));
    expect(memory.values.has(key("draft"))).toBe(true);
    expect(memory.values.has(key("old"))).toBe(false);
    expect(memory.values.get("composer-drafts")).toEqual({ prompt: "unsent" });
    expect(memory.values.get("outbox")).toEqual({ message: "not yet delivered" });
  });

  it("fails closed when draft protection or cross-tab liveness is unavailable", async () => {
    for (const options of [{ locks: browserLocks(), protectedKeys: () => null }, {}]) {
      const memory = memoryBackend();
      const cache = makeThreadCacheRetention({ ...memory, ...options, maxBytes: 1 });
      await cache.save(environment, write("first"));
      await cache.save(environment, write("second"));
      expect(memory.values.has(key("first"))).toBe(true);
      expect(memory.values.has(key("second"))).toBe(true);
    }
  });

  it("keeps the previous cache when a quota failure aborts the replacement", async () => {
    const memory = memoryBackend();
    const cache = makeThreadCacheRetention({ ...memory, locks: browserLocks(), maxBytes: 250 });
    await cache.save(environment, write("first"));
    memory.fail();
    await expect(cache.save(environment, write("second"))).rejects.toThrow("Quota exceeded");
    expect(memory.values.has(key("first"))).toBe(true);
    expect(memory.values.has(key("second"))).toBe(false);
  });
});
