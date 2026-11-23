import { describe, expect, it } from "vite-plus/test";
import { makeNetworkTiming } from "./networkTiming.ts";

describe("network timing", () => {
  it("keeps fast-network budgets and grows them with latency and variance", () => {
    const timing = makeNetworkTiming();
    expect(timing.budget("https://mac.test", 3_000)).toBe(3_000);
    timing.observe("https://mac.test", 20);
    expect(timing.budget("https://mac.test", 3_000)).toBe(3_000);
    timing.observe("https://mac.test", 1_500);
    expect(timing.budget("https://mac.test", 3_000)).toBeGreaterThan(8_000);
    expect(timing.budget("wss://mac.test/ws", 3_000)).toBe(
      timing.budget("https://mac.test", 3_000),
    );
    expect(timing.budget("https://other.test", 3_000)).toBe(3_000);
    timing.observe("https://mac.test", 100_000);
    expect(timing.budget("https://mac.test", 20_000)).toBe(120_000);
  });
});
