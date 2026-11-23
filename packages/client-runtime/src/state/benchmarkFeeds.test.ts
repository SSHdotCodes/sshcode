import type { BenchmarkFeed } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import {
  benchmarkFeedIsFresh,
  loadBenchmarkFeed,
  newestBenchmarkFeed,
  rememberedBenchmarkFeed,
} from "./benchmarkFeeds.ts";

const feed = (fetchedAt: string): BenchmarkFeed => ({
  source: "Artificial Analysis",
  fetchedAt,
  rows: [],
});

it("asks a server once, remembers the answer for an hour, and retries failures later", async () => {
  const read = vi.fn(async () => feed("2026-11-11T06:00:00.000Z"));
  const [a, b] = await Promise.all([
    loadBenchmarkFeed("mac", read, 1000),
    loadBenchmarkFeed("mac", read, 1000),
  ]);
  expect(a).toEqual(b);
  expect(read).toHaveBeenCalledTimes(1);
  expect(rememberedBenchmarkFeed("mac")).toEqual(feed("2026-11-11T06:00:00.000Z"));
  expect(benchmarkFeedIsFresh("mac", 1000 + 59 * 60 * 1000)).toBe(true);
  expect(benchmarkFeedIsFresh("mac", 1000 + 61 * 60 * 1000)).toBe(false);

  expect(await loadBenchmarkFeed("studio", async () => undefined, 1000)).toBeUndefined();
  expect(
    await loadBenchmarkFeed("studio", () => Promise.reject(new Error("offline")), 1000),
  ).toBeUndefined();
  expect(rememberedBenchmarkFeed("studio")).toBeUndefined();
  // A server that failed is left alone for ten minutes, then asked again.
  expect(benchmarkFeedIsFresh("studio", 1000 + 9 * 60 * 1000)).toBe(true);
  expect(benchmarkFeedIsFresh("studio", 1000 + 11 * 60 * 1000)).toBe(false);
  // A failure after a good answer keeps the good answer.
  await loadBenchmarkFeed("mac", async () => undefined, 1000 + 2 * 60 * 60 * 1000);
  expect(rememberedBenchmarkFeed("mac")).toEqual(feed("2026-11-11T06:00:00.000Z"));

  // A server with no key answers null: remembered, so it is not asked on every redraw.
  await loadBenchmarkFeed("phone-host", async () => null, 1000);
  expect(rememberedBenchmarkFeed("phone-host")).toBeNull();
  expect(benchmarkFeedIsFresh("phone-host", 2000)).toBe(true);
});

it("takes the most recent read among several servers", () => {
  const older = feed("2026-11-10T06:00:00.000Z");
  const newer = feed("2026-11-11T06:00:00.000Z");
  expect(newestBenchmarkFeed([older, null, undefined, newer])).toBe(newer);
  expect(newestBenchmarkFeed([null, undefined])).toBeNull();
});
