import { describe, expect, it } from "vite-plus/test";

import { formatSettingsTime } from "./settingsTime";

describe("settings status times", () => {
  it("distinguishes the repeated Eastern hour when daylight saving ends", () => {
    expect(formatSettingsTime("2026-11-01T05:30:00Z")).toBe("Nov 1, 2026, 1:30 AM EDT");
    expect(formatSettingsTime("2026-11-01T06:30:00Z")).toBe("Nov 1, 2026, 1:30 AM EST");
  });

  it("uses the Eastern calendar date and a 12-hour afternoon clock", () => {
    expect(formatSettingsTime("2026-11-09T02:05:00Z")).toBe("Nov 8, 2026, 9:05 PM EST");
  });

  it("preserves an unrecognized server timestamp", () => {
    expect(formatSettingsTime("Unavailable")).toBe("Unavailable");
  });
});
