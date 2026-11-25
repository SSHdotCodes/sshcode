import type { EnvironmentId } from "@t3tools/contracts";
import { threadOutboxRetryDelayMs } from "./thread-outbox-model";

/** A recovery event also invalidates failures still returning from the old connection. */
export function createPendingDeliveryRetries(wake: () => void) {
  type Retry = {
    environmentId: EnvironmentId;
    attempt: number;
    timer?: ReturnType<typeof setTimeout>;
  };
  const entries = new Map<string, Retry>();
  const clear = (id: string) => {
    const entry = entries.get(id);
    if (entry?.timer !== undefined) clearTimeout(entry.timer);
    entries.delete(id);
  };
  const reset = (environmentId?: EnvironmentId) => {
    for (const [id, entry] of entries) {
      if (environmentId === undefined || entry.environmentId === environmentId) clear(id);
    }
  };
  let connected = new Set<EnvironmentId>();
  return {
    clear,
    reset,
    prune(ids: ReadonlySet<string>) {
      for (const id of entries.keys()) if (!ids.has(id)) clear(id);
    },
    observeConnections(
      environments: ReadonlyArray<{ environmentId: EnvironmentId; connectionState: string }>,
    ) {
      const next = new Set(
        environments
          .filter((env) => env.connectionState === "connected")
          .map((env) => env.environmentId),
      );
      for (const id of next) if (!connected.has(id)) reset(id);
      connected = next;
    },
    waiting: (id: string) => entries.get(id)?.timer !== undefined,
    onFailure(id: string, environmentId: EnvironmentId) {
      const entry = entries.get(id) ?? { environmentId, attempt: 0 };
      entries.set(id, entry);
      return () => {
        if (entries.get(id) !== entry || entry.timer !== undefined) return;
        entry.timer = setTimeout(
          () => {
            delete entry.timer;
            wake();
          },
          threadOutboxRetryDelayMs(++entry.attempt),
        );
      };
    },
  };
}
