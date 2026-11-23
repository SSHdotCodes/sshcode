import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerProviderUsageWindow } from "./providerUsageLimits.ts";

const window = { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 100 };
const decodeWindow = Schema.decodeUnknownSync(ServerProviderUsageWindow);

describe("usage window verdict", () => {
  it.each([
    { modelIds: ["opencode/model-a"] },
    { providerIds: ["opencode", "console-custom"] },
    { modelIds: [], providerIds: [] },
  ])("preserves optional limit coverage: %j", (coverage) => {
    expect(decodeWindow({ ...window, ...coverage })).toEqual({ ...window, ...coverage });
  });

  it.each([false, true])("preserves the optional %s verdict across the wire", (limited) => {
    const input = { ...window, limited };
    expect(decodeWindow(input)).toEqual(input);
  });

  it("accepts windows from older servers without a verdict", () => {
    expect(decodeWindow(window)).toEqual(window);
  });

  it("preserves a measured recent pace across the wire", () => {
    const input = { ...window, recentPercentPerHour: 12.5 };
    expect(decodeWindow(input)).toEqual(input);
  });

  it.each([0, -1, Infinity, NaN])("rejects an invalid recent pace: %s", (recentPercentPerHour) => {
    expect(() => decodeWindow({ ...window, recentPercentPerHour })).toThrow();
  });
});
