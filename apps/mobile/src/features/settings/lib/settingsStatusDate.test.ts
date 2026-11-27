import { describe, expect, it, vi } from "vite-plus/test";

import { formatSettingsStatusDate } from "./settingsStatusDate";

// Status dates read the phone's own clock; pin one that is not New York's.
vi.stubEnv("TZ", "America/Los_Angeles");

describe("settings status dates", () => {
  it("uses the phone's standard time and a 12-hour clock", () => {
    expect(formatSettingsStatusDate("2026-01-15T20:05:00Z")).toBe("Jan 15, 2026, 12:05 PM");
  });

  it("observes the phone's daylight saving time", () => {
    expect(formatSettingsStatusDate("2026-07-15T19:05:00Z")).toBe("Jul 15, 2026, 12:05 PM");
  });

  it("uses the phone's calendar date when UTC is on the next day", () => {
    expect(formatSettingsStatusDate(Date.parse("2026-11-09T01:05:00Z"))).toBe(
      "Nov 8, 2026, 5:05 PM",
    );
  });

  it("keeps unavailable dates from crashing a settings screen", () => {
    expect(formatSettingsStatusDate("unavailable")).toBe("Date unavailable");
  });
});
