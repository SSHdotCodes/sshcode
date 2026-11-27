import { describe, expect, it, vi } from "vite-plus/test";

import { formatSettingsTime } from "./settingsTime";

// Settings times read the viewer's clock; pin one that is not New York's.
vi.stubEnv("TZ", "America/Los_Angeles");

describe("settings status times", () => {
  it("distinguishes the repeated local hour when daylight saving ends", () => {
    expect(formatSettingsTime("2026-11-01T08:30:00Z")).toBe("Nov 1, 2026, 1:30 AM PDT");
    expect(formatSettingsTime("2026-11-01T09:30:00Z")).toBe("Nov 1, 2026, 1:30 AM PST");
  });

  it("uses the viewer's calendar date and a 12-hour afternoon clock", () => {
    expect(formatSettingsTime("2026-11-09T02:05:00Z")).toBe("Nov 8, 2026, 6:05 PM PST");
  });

  it("preserves an unrecognized server timestamp", () => {
    expect(formatSettingsTime("Unavailable")).toBe("Unavailable");
  });
});
