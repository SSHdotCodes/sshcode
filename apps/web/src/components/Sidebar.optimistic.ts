export type SidebarPendingAction = "pin" | "unpin" | "snooze" | "unsnooze" | "settle" | "unsettle";

/** Lifecycle projection and rollback belong to threadEnvironment. This store
 * only keeps sidebar controls busy until their command finishes. */
export function createSidebarPendingActions() {
  type Pending = { readonly key: string; readonly action: SidebarPendingAction };
  let pending: ReadonlyMap<string, Pending> = new Map();
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  const remove = (entry: Pending) => {
    if (pending.get(entry.key) !== entry) return;
    const next = new Map(pending);
    next.delete(entry.key);
    pending = next;
    emit();
  };
  return {
    snapshot: () => pending,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    begin(key: string, action: SidebarPendingAction) {
      if (pending.has(key)) return null;
      const entry: Pending = { key, action };
      pending = new Map(pending).set(key, entry);
      emit();
      return entry;
    },
    async run<A>(entry: Pending | null, perform: () => Promise<A>): Promise<A | null> {
      if (entry === null || pending.get(entry.key) !== entry) return null;
      try {
        return await perform();
      } finally {
        remove(entry);
      }
    },
    cancel() {
      if (pending.size === 0) return;
      pending = new Map();
      emit();
    },
  };
}
