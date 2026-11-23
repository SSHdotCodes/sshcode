import { describe, expect, it } from "@effect/vitest";

import { makeRepeatChecks, unchangedNotice } from "./repeatChecks.ts";

describe("repeatChecks", () => {
  it("reports only an unchanged answer to the same question within the window", () => {
    const check = makeRepeatChecks();
    expect(check("task-a", "running", 0)).toBeUndefined();
    expect(check("task-a", "running", 30_000)).toBe(30_000);
    // Measured from the latest check, not the first.
    expect(check("task-a", "running", 45_000)).toBe(15_000);
    expect(check("task-b", "running", 46_000)).toBeUndefined();
    expect(check("task-a", "completed", 50_000)).toBeUndefined();
    // Checks ten minutes apart are not polling.
    expect(check("task-a", "completed", 50_000 + 10 * 60_000)).toBeUndefined();
  });

  it("names what wakes the thread", () => {
    expect(unchangedNotice(400, "Monitor output or exit")).toBe(
      "No change since your check 1 s ago. Monitor output or exit wakes this thread on its own; end your turn if waiting is all that's left.",
    );
  });
});
