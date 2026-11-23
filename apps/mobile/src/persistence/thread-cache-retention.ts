import type { EnvironmentId } from "@t3tools/contracts";

const retained = new Map<EnvironmentId, Map<string, number>>();

/** Keep the visible chat's offline copy while other thread caches are evicted. */
export function retainThreadCache(environmentId: EnvironmentId, threadId: string): () => void {
  const threads = retained.get(environmentId) ?? new Map<string, number>();
  retained.set(environmentId, threads);
  threads.set(threadId, (threads.get(threadId) ?? 0) + 1);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    const count = threads.get(threadId) ?? 0;
    if (count > 1) threads.set(threadId, count - 1);
    else threads.delete(threadId);
    if (threads.size === 0) retained.delete(environmentId);
  };
}

export function retainedThreadCaches(): ReadonlyArray<readonly [EnvironmentId, string]> {
  return [...retained].flatMap(([environmentId, threads]) =>
    [...threads.keys()].map((threadId) => [environmentId, threadId] as const),
  );
}
