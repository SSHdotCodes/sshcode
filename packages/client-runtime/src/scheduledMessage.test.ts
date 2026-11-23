import { afterEach, expect, it, vi } from "vite-plus/test";
import {
  scheduledMessageInstant,
  scheduledMessageLocalDateTime,
  scheduledMessageUnavailableReason,
} from "./scheduledMessage.ts";

afterEach(() => vi.unstubAllEnvs());

it("converts the selected local time to an absolute instant in the device zone", () => {
  vi.stubEnv("TZ", "America/New_York");
  expect(scheduledMessageInstant("2027-01-15T09:30", 0)).toBe("2027-01-15T14:30:00.000Z");
  expect(scheduledMessageLocalDateTime("2027-01-15T14:30:00.000Z")).toBe("2027-01-15T09:30");
});
it("rejects past times, invalid dates and a skipped daylight-saving time", () => {
  vi.stubEnv("TZ", "America/New_York");
  expect(
    scheduledMessageInstant("2027-01-15T09:30", Date.parse("2027-01-15T14:30:00Z")),
  ).toBeNull();
  expect(scheduledMessageInstant("2027-02-30T09:30", 0)).toBeNull();
  expect(scheduledMessageInstant("2027-03-14T02:30", 0)).toBeNull();
  expect(scheduledMessageInstant("2027-03-14T03:30", 0)).toBe("2027-03-14T07:30:00.000Z");
});

it("requires an explicit capability from the destination environment", () => {
  expect(scheduledMessageUnavailableReason(undefined)).toBe(
    "Update this environment to schedule messages.",
  );
  expect(scheduledMessageUnavailableReason({})).toBe(
    "Update this environment to schedule messages.",
  );
  expect(scheduledMessageUnavailableReason({ scheduledMessages: false })).not.toBeNull();
  expect(scheduledMessageUnavailableReason({ scheduledMessages: true })).toBeNull();
});
