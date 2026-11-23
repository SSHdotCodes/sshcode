import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

export const THREAD_CACHE_BYTE_BUDGET = 64 * 1024 * 1024;

export interface ThreadCacheIndex {
  readonly version: 1;
  readonly clock: number;
  readonly entries: Readonly<Record<string, { readonly bytes: number; readonly usedAt: number }>>;
}

export interface ThreadCacheWrite {
  readonly key: string;
  readonly snapshot: string;
  readonly preview: unknown;
}

export interface ThreadCacheBackend {
  readonly readIndex: (environmentId: EnvironmentId) => Promise<ThreadCacheIndex>;
  /** Snapshot, preview, evictions and index must commit together. */
  readonly commit: (
    environmentId: EnvironmentId,
    index: ThreadCacheIndex,
    removed: ReadonlyArray<string>,
    write?: ThreadCacheWrite,
  ) => Promise<void>;
}

const pinName = (key: string) => `t3code:thread-cache:open:${key}`;
const byteSize = (value: string) => new TextEncoder().encode(value).byteLength;

/** Only the snapshot store is managed here. Drafts and outboxes are never cleanup targets. */
export function makeThreadCacheRetention(options: {
  readonly backend: ThreadCacheBackend;
  readonly locks?: LockManager;
  /** Also protect threads with unsent work. Null means protection could not be read. */
  readonly protectedKeys?: () => ReadonlySet<string> | null;
  readonly maxBytes?: number;
  readonly now?: () => number;
}) {
  const { backend, locks } = options;
  const maxBytes = options.maxBytes ?? THREAD_CACHE_BYTE_BUDGET;
  const now = options.now ?? Date.now;
  let evictionAvailable = locks !== undefined;
  let pending = Promise.resolve();
  const serialize = <A>(environmentId: EnvironmentId, run: () => Promise<A>): Promise<A> => {
    if (locks) return locks.request(`t3code:thread-cache:write:${environmentId}`, run);
    const next = pending.then(run, run);
    pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const retain = (environmentId: EnvironmentId, threadId: ThreadId): Promise<() => void> => {
    // Without Web Locks, eviction is disabled: another tab's open threads cannot
    // be distinguished safely from inactive snapshots. Compact encoding still applies.
    if (!locks) return Promise.resolve(() => undefined);
    return new Promise<() => void>((resolve, reject) => {
      void locks
        .request(
          pinName(`${environmentId}:${threadId}`),
          { mode: "shared" },
          () => new Promise<void>((release) => resolve(release)),
        )
        .catch(reject);
    }).catch(() => {
      evictionAvailable = false;
      return () => undefined;
    });
  };

  const commitWithRetention = async (
    environmentId: EnvironmentId,
    index: ThreadCacheIndex,
    protectedKey: string,
    write?: ThreadCacheWrite,
  ) => {
    const entries = { ...index.entries };
    let total = Object.values(entries).reduce((sum, entry) => sum + entry.bytes, 0);
    const candidates = Object.keys(entries).sort((a, b) => entries[a]!.usedAt - entries[b]!.usedAt);
    const removed: string[] = [];
    const commit = () => backend.commit(environmentId, { ...index, entries }, removed, write);
    const protectedKeys = options.protectedKeys ? options.protectedKeys() : new Set<string>();
    if (!locks || !evictionAvailable || protectedKeys === null) return commit();
    const prune = async (position: number): Promise<void> => {
      while (
        position < candidates.length &&
        (candidates[position] === protectedKey || protectedKeys.has(candidates[position]!))
      )
        position++;
      if (total <= maxBytes || position === candidates.length) return commit();
      const key = candidates[position]!;
      // Holding the exclusive lock through commit closes the race with a tab
      // opening this thread while eviction is being prepared. Browser crashes
      // release shared pins automatically, with no persisted leases to expire.
      return locks.request(pinName(key), { mode: "exclusive", ifAvailable: true }, async (lock) => {
        if (lock !== null) {
          total -= entries[key]!.bytes;
          delete entries[key];
          removed.push(key);
        }
        return prune(position + 1);
      });
    };
    return prune(0);
  };

  const save = (environmentId: EnvironmentId, write: ThreadCacheWrite) =>
    serialize(environmentId, async () => {
      const previous = await backend.readIndex(environmentId);
      const clock = Math.max(now(), previous.clock + 1);
      const bytes =
        byteSize(write.snapshot) +
        byteSize(JSON.stringify(write.preview)) +
        byteSize(write.key) +
        64;
      return commitWithRetention(
        environmentId,
        {
          version: 1,
          clock,
          entries: { ...previous.entries, [write.key]: { bytes, usedAt: clock } },
        },
        write.key,
        write,
      );
    });

  const touch = (environmentId: EnvironmentId, threadId: ThreadId) =>
    serialize(environmentId, async () => {
      const previous = await backend.readIndex(environmentId);
      const key = `${environmentId}:${threadId}`;
      const entry = previous.entries[key];
      if (!entry) return;
      const clock = Math.max(now(), previous.clock + 1);
      await commitWithRetention(
        environmentId,
        {
          version: 1,
          clock,
          entries: { ...previous.entries, [key]: { ...entry, usedAt: clock } },
        },
        key,
      );
    });

  return { retain, save, touch };
}
