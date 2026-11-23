import { describe, expect, it } from "vite-plus/test";

import { formatSettingsStatusDate } from "./settingsStatusDate";

describe("settings status dates", () => {
  it("uses Eastern standard time and a 12-hour clock", () => {
    expect(formatSettingsStatusDate("2026-01-15T20:05:00Z")).toBe("Jan 15, 2026, 3:05 PM ET");
  });

  it("observes Eastern daylight saving time", () => {
    expect(formatSettingsStatusDate("2026-07-15T19:05:00Z")).toBe("Jul 15, 2026, 3:05 PM ET");
  });

  it("uses the Eastern calendar date when UTC is on the next day", () => {
    expect(formatSettingsStatusDate(Date.parse("2026-11-09T01:05:00Z"))).toBe(
      "Nov 8, 2026, 8:05 PM ET",
    );
  });

  it("keeps unavailable dates from crashing a settings screen", () => {
    expect(formatSettingsStatusDate("unavailable")).toBe("Date unavailable");
  });
});
