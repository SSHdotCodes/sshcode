import type { BenchmarkFeed } from "@t3tools/contracts";

/** A screen opened again within the hour draws from what it already has. */
const FRESH_FOR_MS = 60 * 60 * 1000;
/** A server that failed to answer (offline, or a build without the feed) is left alone for a while. */
const RETRY_AFTER_MS = 10 * 60 * 1000;
const remembered = new Map<
  string,
  { readonly until: number; readonly feed: BenchmarkFeed | null | undefined }
>();
const loading = new Map<string, Promise<BenchmarkFeed | null | undefined>>();

/** `undefined`: never asked. `null`: asked, and that server has no live figures. */
export function rememberedBenchmarkFeed(environmentId: string): BenchmarkFeed | null | undefined {
  return remembered.get(environmentId)?.feed;
}

export function benchmarkFeedIsFresh(environmentId: string, now: number): boolean {
  const entry = remembered.get(environmentId);
  return entry !== undefined && now < entry.until;
}

/**
 * One request per server, however many screens ask at once. `read` resolves
 * `undefined` for a failed call (offline, or a server without the feed): the
 * last good answer is kept, and that server is asked again after a pause.
 */
export function loadBenchmarkFeed(
  environmentId: string,
  read: () => Promise<BenchmarkFeed | null | undefined>,
  now: number,
): Promise<BenchmarkFeed | null | undefined> {
  const running = loading.get(environmentId);
  if (running) return running;
  const request = read()
    .then(
      (feed) => feed,
      () => undefined,
    )
    .then((feed) => {
      remembered.set(
        environmentId,
        feed === undefined
          ? { until: now + RETRY_AFTER_MS, feed: remembered.get(environmentId)?.feed }
          : { until: now + FRESH_FOR_MS, feed },
      );
      return feed;
    })
    .finally(() => {
      loading.delete(environmentId);
    });
  loading.set(environmentId, request);
  return request;
}

/** With several servers connected, the most recent read wins. */
export function newestBenchmarkFeed(
  feeds: Iterable<BenchmarkFeed | null | undefined>,
): BenchmarkFeed | null {
  let newest: BenchmarkFeed | null = null;
  for (const feed of feeds) {
    if (feed && (newest === null || feed.fetchedAt > newest.fetchedAt)) newest = feed;
  }
  return newest;
}
