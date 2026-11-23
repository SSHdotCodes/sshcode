import { describe, expect, it } from "vite-plus/test";
import { formatTranscriptTimestamp } from "./time";

const now = new Date(2026, 10, 11, 17);
const format = (date: Date) =>
  formatTranscriptTimestamp(date.toISOString(), now).replace(/\u202f/g, " ");

describe("transcript timestamps", () => {
  it("shows just the time on the same local calendar day", () => {
    expect(format(new Date(2026, 10, 11, 16, 2))).toBe("4:02 PM");
  });
  it("adds the month and day on another day", () => {
    expect(format(new Date(2026, 10, 10, 16, 2))).toBe("Nov 10, 4:02 PM");
  });
  it("adds the year for another year", () => {
    expect(format(new Date(2025, 10, 10, 16, 2))).toBe("Nov 10, 2025, 4:02 PM");
  });
  it("uses the calendar date across midnight, even less than 24 hours apart", () => {
    expect(formatTranscriptTimestamp(new Date(2026, 10, 10, 23, 59).toISOString(), now)).toMatch(
      /^Nov 10, /,
    );
  });
  it("includes a future date and a future year", () => {
    expect(format(new Date(2026, 10, 12, 16, 2))).toBe("Nov 12, 4:02 PM");
    expect(format(new Date(2027, 0, 1, 16, 2))).toBe("Jan 1, 2027, 4:02 PM");
  });
  it("leaves invalid timestamps empty", () => {
    expect(formatTranscriptTimestamp("invalid", now)).toBe("");
  });
});
