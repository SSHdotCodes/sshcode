import { describe, expect, it } from "vite-plus/test";

import { providerHealthNotice } from "./providerHealth.ts";

const now = Date.parse("2026-11-03T20:00:00.000Z");

describe("providerHealthNotice", () => {
  it("names a usage limit and when it ends", () => {
    const notice = providerHealthNotice(
      {
        recentFailure: {
          kind: "usage_limit",
          message: "You've hit your limit.",
          occurredAt: "2026-11-03T19:50:00.000Z",
          resetAt: "2026-11-03T22:40:00.000Z",
        },
      },
      now,
    );
    expect(notice?.kind).toBe("usage_limit");
    expect(notice?.title).toMatch(/^At its usage limit until \S/);
    expect(notice?.message).toBe("You've hit your limit.");
  });

  it("says when the last run failed for a provider error", () => {
    expect(
      providerHealthNotice(
        {
          recentFailure: {
            kind: "provider_error",
            message: "Billing required.",
            occurredAt: "2026-11-03T19:50:00.000Z",
          },
        },
        now,
      )?.title,
    ).toMatch(/^Last run failed at \S/);
  });

  it("keeps a run that ended signed out past the time another try is fair", () => {
    // Nothing has worked since, so the picker and Settings still say so.
    const notice = providerHealthNotice(
      {
        recentFailure: {
          kind: "authentication_error",
          message: "Signed out. Sign in again.",
          occurredAt: "2026-11-03T12:00:00.000Z",
          resetAt: "2026-11-03T13:00:00.000Z",
        },
      },
      now,
    );
    expect(notice?.title).toMatch(/^Signed out since \S/);
    expect(notice?.message).toBe("Signed out. Sign in again.");
  });

  it("is quiet for a healthy provider and once a limit has reset", () => {
    expect(providerHealthNotice({}, now)).toBeNull();
    expect(
      providerHealthNotice(
        {
          recentFailure: {
            kind: "usage_limit",
            message: "You've hit your limit.",
            occurredAt: "2026-11-03T17:00:00.000Z",
            resetAt: "2026-11-03T19:00:00.000Z",
          },
        },
        now,
      ),
    ).toBeNull();
  });
});

it("uses the same advisory credit sentence for picker, composer and usage rows", () => {
  const occurredAt = "2026-11-03T19:50:00.000Z";
  const message = "Budget exhausted. Add credits or raise the spending limit.";
  const notice = providerHealthNotice(
    { recentFailure: { kind: "billing_error", outOfCredit: true, occurredAt, message } },
    Date.parse("2030-01-01"),
  );
  expect(notice?.title).toBe("Out of credit");
  expect(notice?.message).toBe(
    `Out of credit since ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(Date.parse(occurredAt))}: ${message}`,
  );
});

it("limits notices to the affected model and keeps provider rows quiet", () => {
  const provider = {
    recentFailure: {
      kind: "usage_limit" as const,
      message: "Fable limit reached.",
      occurredAt: "2026-11-03T19:50:00.000Z",
      resetAt: "2026-11-03T22:40:00.000Z",
      modelIds: ["fable"],
    },
  };
  expect(providerHealthNotice(provider, now)).toBeNull();
  expect(providerHealthNotice(provider, now, "opus")).toBeNull();
  expect(providerHealthNotice(provider, now, "fable")?.kind).toBe("usage_limit");
});
