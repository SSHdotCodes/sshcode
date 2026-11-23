export function createSidebarPrefetch<T>(options: {
  readonly load: (key: string, signal: AbortSignal) => Promise<T>;
  readonly delayMs?: number;
  readonly concurrency?: number;
  readonly cacheSize?: number;
  readonly cacheMs?: number;
}) {
  type Intent = {
    revision: string;
    owners: Set<object>;
    timer: ReturnType<typeof setTimeout> | null;
    ready: boolean;
    controller: AbortController | null;
  };
  const intents = new Map<string, Intent>();
  const cache = new Map<string, { value: T; expiresAt: number; revision: string }>();
  const listeners = new Map<string, Set<() => void>>();
  let active = 0;
  let disposed = false;
  const notify = (key: string) => listeners.get(key)?.forEach((listener) => listener());
  const cancel = () => {
    for (const intent of intents.values()) {
      if (intent.timer !== null) clearTimeout(intent.timer);
      intent.controller?.abort();
    }
    intents.clear();
  };
  const pump = () => {
    if (disposed) return;
    for (const [key, intent] of intents) {
      if (active >= (options.concurrency ?? 2)) break;
      if (!intent.ready || intent.controller !== null) continue;
      const controller = new AbortController();
      intent.controller = controller;
      active++;
      void Promise.resolve()
        .then(() => options.load(key, controller.signal))
        .then(
          (value) => {
            if (disposed || controller.signal.aborted || intents.get(key) !== intent) return;
            cache.delete(key);
            cache.set(key, {
              value,
              expiresAt: Date.now() + (options.cacheMs ?? 30_000),
              revision: intent.revision,
            });
            for (const oldest of cache.keys()) {
              if (cache.size <= (options.cacheSize ?? 16)) break;
              cache.delete(oldest);
            }
            notify(key);
          },
          () => {},
        )
        .finally(() => {
          active--;
          if (intents.get(key) === intent) intents.delete(key);
          pump();
        });
    }
  };

  return {
    request(key: string, revision = "", requestOptions?: { readonly immediate?: boolean }) {
      if (disposed) return () => {};
      const cached = cache.get(key);
      if (cached && cached.expiresAt > Date.now() && cached.revision === revision) return () => {};
      const immediate = requestOptions?.immediate === true;
      let intent = intents.get(key);
      if (intent && intent.revision !== revision) {
        if (intent.timer !== null) clearTimeout(intent.timer);
        intent.controller?.abort();
        intents.delete(key);
        intent = undefined;
      }
      if (intent === undefined) {
        intent = {
          revision,
          owners: new Set(),
          timer: null,
          ready: immediate,
          controller: null,
        };
        const pending = intent;
        intents.set(key, pending);
        if (!immediate) {
          pending.timer = setTimeout(() => {
            pending.timer = null;
            pending.ready = true;
            pump();
          }, options.delayMs ?? 80);
        }
      } else if (immediate && !intent.ready) {
        if (intent.timer !== null) {
          clearTimeout(intent.timer);
          intent.timer = null;
        }
        intent.ready = true;
      }
      const owner = {};
      intent.owners.add(owner);
      const held = intent;
      if (immediate) pump();
      return () => {
        held.owners.delete(owner);
        if (held.owners.size !== 0 || intents.get(key) !== held) return;
        if (held.timer !== null) clearTimeout(held.timer);
        intents.delete(key);
        held.controller?.abort();
        pump();
      };
    },
    snapshot(key: string): T | undefined {
      return cache.get(key)?.value;
    },
    subscribe(key: string, listener: () => void) {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0) listeners.delete(key);
      };
    },
    cancel,
    dispose() {
      disposed = true;
      cancel();
      cache.clear();
      listeners.clear();
    },
  };
}
