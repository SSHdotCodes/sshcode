import { describe, expect, it } from "vite-plus/test";

import { formatBytes } from "./formatBytes";

describe("formatBytes", () => {
  it("picks decimals after rounding", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(9.996 * 1_024)).toBe("10.0 KB");
    expect(formatBytes(99.96 * 1_024)).toBe("100 KB");
    expect(formatBytes(1.5 * 1_024 * 1_024)).toBe("1.50 MB");
  });
});
