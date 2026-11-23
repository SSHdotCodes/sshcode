import { afterEach, describe, expect, it } from "vite-plus/test";

import { isServerUnreachableError, markServerReached, nextServerRetryDelayMs } from "./serverRetry";

describe("server retry", () => {
  afterEach(() => markServerReached());

  it("retries only errors where the server didn't answer", () => {
    expect(isServerUnreachableError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isServerUnreachableError({ _tag: "PrimaryEnvironmentRequestError", status: 500 })).toBe(
      true,
    );
    expect(isServerUnreachableError(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(isServerUnreachableError("boom")).toBe(false);
  });

  it("tries quickly at first, then settles to every 15 seconds until the server answers", () => {
    expect(nextServerRetryDelayMs(0)).toBe(1_000);
    expect(nextServerRetryDelayMs(9_000)).toBe(1_000);
    expect(nextServerRetryDelayMs(30_000)).toBe(3_000);
    expect(nextServerRetryDelayMs(120_000)).toBe(15_000);
    markServerReached();
    expect(nextServerRetryDelayMs(500_000)).toBe(1_000);
  });
});
