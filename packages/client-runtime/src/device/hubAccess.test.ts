import { describe, expect, it } from "vite-plus/test";

import { createDeviceAccessRetry } from "./hubAccess.ts";

describe("createDeviceAccessRetry", () => {
  it("refreshes once at once, backs off, then stops until reset", () => {
    const retry = createDeviceAccessRetry();
    const delays = Array.from({ length: 7 }, () => retry.rejected());
    expect(delays).toEqual([0, 1_000, 2_000, 4_000, null, null, null]);
    retry.reset();
    expect(retry.rejected()).toBe(0);
  });

  it("treats a rejection after a started stream as a fresh expiry", () => {
    const retry = createDeviceAccessRetry();
    retry.rejected();
    retry.rejected();
    retry.reset();
    expect([retry.rejected(), retry.rejected()]).toEqual([0, 1_000]);
  });

  it("knows a rejection is still waiting for its stream", () => {
    const retry = createDeviceAccessRetry();
    expect(retry.awaitingStream()).toBe(false);
    retry.rejected();
    expect(retry.awaitingStream()).toBe(true);
    retry.reset();
    expect(retry.awaitingStream()).toBe(false);
  });
});
