import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { scheduledMessageLocalDateTime } from "@t3tools/client-runtime/scheduled-message";
import {
  mergeScheduledMessagePickerValue,
  scheduledMessagePickerValue,
} from "./scheduledMessagePicker";

afterEach(() => vi.unstubAllEnvs());

describe.each(["America/New_York", "Europe/Istanbul", "Pacific/Kiritimati"])(
  "scheduled picker in %s",
  (zone) => {
    it("merges Android UTC-midnight calendar days with the previously chosen local time", () => {
      vi.stubEnv("TZ", zone);
      const previous = new Date("2026-10-02T09:30");
      const picked = new Date("2026-10-05T00:00:00.000Z");
      const merged = mergeScheduledMessagePickerValue(previous, picked, "date", "android");
      expect(merged && scheduledMessageLocalDateTime(merged.getTime())).toBe("2026-10-05T09:30");
      expect(scheduledMessageLocalDateTime(previous.getTime())).toBe("2026-10-02T09:30");
      expect(scheduledMessagePickerValue(previous, "date", "android").toISOString()).toBe(
        "2026-10-02T00:00:00.000Z",
      );
    });
    it("uses the iOS local calendar day and preserves the previous local time", () => {
      vi.stubEnv("TZ", zone);
      const previous = new Date("2026-10-02T09:30");
      const picked = new Date("2026-10-05T23:10");
      const merged = mergeScheduledMessagePickerValue(previous, picked, "date", "ios");
      expect(merged && scheduledMessageLocalDateTime(merged.getTime())).toBe("2026-10-05T09:30");
      expect(scheduledMessagePickerValue(previous, "date", "ios")).toBe(previous);
    });
    it.each(["android", "ios"])(
      "changes %s time without changing the chosen calendar day",
      (platform) => {
        vi.stubEnv("TZ", zone);
        const previous = new Date("2026-10-05T09:30");
        const picked = new Date("2026-10-28T16:45");
        const merged = mergeScheduledMessagePickerValue(previous, picked, "time", platform);
        expect(merged && scheduledMessageLocalDateTime(merged.getTime())).toBe("2026-10-05T16:45");
        const pickerValue = scheduledMessagePickerValue(previous, "time", platform);
        if (platform === "android") {
          expect(scheduledMessageLocalDateTime(pickerValue.getTime())).toBe("2000-01-01T09:30");
        } else {
          expect(pickerValue).toBe(previous);
        }
      },
    );
  },
);

it("preserves wall-clock time across daylight-saving changes and rejects skipped times", () => {
  vi.stubEnv("TZ", "America/New_York");
  const previous = new Date("2027-03-13T09:30");
  const merged = mergeScheduledMessagePickerValue(
    previous,
    new Date("2027-03-14T00:00:00Z"),
    "date",
    "android",
  );
  expect(merged && scheduledMessageLocalDateTime(merged.getTime())).toBe("2027-03-14T09:30");
  expect(merged?.toISOString()).toBe("2027-03-14T13:30:00.000Z");
  expect(
    mergeScheduledMessagePickerValue(
      new Date("2027-03-13T02:30"),
      new Date("2027-03-14T00:00:00Z"),
      "date",
      "android",
    ),
  ).toBeNull();
});

/** Expo's Android Calendar sets both chosen fields, then reads the lenient instant. */
function androidTimeCallback(initial: Date, hour: number, minute: number): Date {
  const picked = new Date(initial.getTime());
  picked.setHours(hour, minute);
  return picked;
}

it("rejects a spring-gap hour before Android can normalize the intended choice", () => {
  vi.stubEnv("TZ", "America/New_York");
  const selectedDay = new Date("2027-03-14T09:30");
  // This is the native callback the actual send day previously produced.
  const normalized = androidTimeCallback(selectedDay, 2, 30);
  expect(scheduledMessageLocalDateTime(normalized.getTime())).toBe("2027-03-14T03:30");
  const input = scheduledMessagePickerValue(selectedDay, "time", "android");
  const picked = androidTimeCallback(input, 2, 30);
  expect(picked.getHours()).toBe(2);
  expect(picked.getMinutes()).toBe(30);
  expect(mergeScheduledMessagePickerValue(selectedDay, picked, "time", "android")).toBeNull();
  expect(scheduledMessageLocalDateTime(selectedDay.getTime())).toBe("2027-03-14T09:30");
});

it("accepts a valid Android time on the transition day after native round trip", () => {
  vi.stubEnv("TZ", "America/New_York");
  const selectedDay = new Date("2027-03-14T09:30");
  const input = scheduledMessagePickerValue(selectedDay, "time", "android");
  const picked = androidTimeCallback(input, 3, 30);
  const merged = mergeScheduledMessagePickerValue(selectedDay, picked, "time", "android");
  expect(merged && scheduledMessageLocalDateTime(merged.getTime())).toBe("2027-03-14T03:30");
  expect(merged?.toISOString()).toBe("2027-03-14T07:30:00.000Z");
});
