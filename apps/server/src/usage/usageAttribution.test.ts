import { describe, expect, it } from "vite-plus/test";
import { EMPTY_TOTALS, type UsageRecord } from "@t3tools/provider-core/server/usage";
import { createUsageAttribution } from "./usageAttribution.ts";

const record = (sessionId: string, timestampMs: number): UsageRecord => ({
  provider: "codex",
  sessionId,
  timestampMs,
  model: "gpt-test",
  totals: EMPTY_TOTALS,
  reportedCostUsd: null,
  speed: "standard",
  dedupeKey: null,
});
const bindings = [
  { instanceId: "first", sessionId: "parent", startedAt: "2026-08-01T08:00:00Z" },
  { instanceId: "second", sessionId: "parent", startedAt: "2026-08-01T10:00:00Z" },
  { instanceId: "first", sessionId: "parent", startedAt: "2026-08-01T12:00:00Z" },
  { instanceId: "unrelated-home", sessionId: "parent", startedAt: "2026-08-01T11:30:00Z" },
];
const at = (hour: number) => Date.parse(`2026-08-01T${String(hour).padStart(2, "0")}:00:00Z`);

describe("shared usage attribution", () => {
  it("leaves conflicting accounts at the same instant unattributed", () => {
    const account = createUsageAttribution(
      [
        { instanceId: "first", sessionId: "same", startedAt: "2026-08-01T10:00:00Z" },
        { instanceId: "second", sessionId: "same", startedAt: "2026-08-01T10:00:00Z" },
      ],
      ["first", "second"],
      [],
    );
    expect(account(record("same", at(11)))).toBeUndefined();
  });

  it("follows historical runs in both directions and leaves unknown history for the source default", () => {
    const account = createUsageAttribution(bindings, ["first", "second"], []);
    expect([7, 9, 11, 13].map((hour) => account(record("parent", at(hour))))).toEqual([
      undefined,
      "first",
      "second",
      "first",
    ]);
    expect(account(record("outside-app", at(11)))).toBeUndefined();
  });

  it("inherits a native subagent's launch account without following later parent switches", () => {
    const account = createUsageAttribution(
      bindings,
      ["first", "second"],
      [
        {
          records: [record("child", at(11)), record("child", at(13))],
          details: [{ kind: "subagent", sessionId: "child", parentSessionId: "parent" }],
        },
      ],
    );
    expect(account(record("child", at(13)))).toBe("second");
  });

  it("prefers a child's own app run and terminates cyclic or missing native parent links", () => {
    const account = createUsageAttribution(
      [...bindings, { instanceId: "first", sessionId: "child", startedAt: "2026-08-01T10:30:00Z" }],
      ["first", "second"],
      [
        {
          records: [],
          details: [
            { kind: "subagent", sessionId: "child", parentSessionId: "parent" },
            { kind: "subagent", sessionId: "a", parentSessionId: "b" },
            { kind: "subagent", sessionId: "b", parentSessionId: "a" },
          ],
        },
      ],
    );
    expect(account(record("child", at(11)))).toBe("first");
    expect(account(record("a", at(11)))).toBeUndefined();
  });
});
