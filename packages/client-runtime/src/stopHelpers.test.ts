import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { describeThreadHelpers } from "./stopHelpers.ts";

const child = {
  origin: "app_owned" as const,
  status: "running" as const,
  childThreadId: ThreadId.make("child"),
  title: "Review",
  prompt: "Review the patch",
};

describe("describeThreadHelpers", () => {
  it("keeps one-tap Stop when no managed work is active", () => {
    expect(
      describeThreadHelpers({
        subagents: [
          { ...child, status: "completed" },
          { ...child, origin: "provider_native" },
        ],
        monitors: [],
      }),
    ).toBeNull();
  });

  it("counts children, monitors, durable jobs and PR watches with a short roster", () => {
    expect(
      describeThreadHelpers({
        subagents: [child, { ...child, status: "waiting", title: "Check tests" }],
        monitors: [{ description: "Build" }, { description: "Watch checks" }],
      }),
    ).toBe("Keeps 4 subagents running: Review, Check tests, +2 more");
  });

  it("counts active PR watches and ignores unwatched links", () => {
    expect(
      describeThreadHelpers({
        subagents: [],
        monitors: [],
        pullRequests: [
          {
            number: 7,
            watch: {
              startedAt: "2026-11-05T00:00:00.000Z",
              headSha: null,
              failedChecks: [],
              passed: false,
              passedChecks: [],
              remarksThrough: "2026-11-05T00:00:00.000Z",
              remarkIds: [],
              conflicting: false,
              wakes: 0,
            },
          },
          { number: 8 },
        ],
      }),
    ).toBe("Keeps 1 subagent running: PR #7");
  });

  it("normalizes long task names and uses singular for one helper", () => {
    expect(
      describeThreadHelpers({ subagents: [], monitors: [{ description: "Build\n  app" }] }),
    ).toBe("Keeps 1 subagent running: Build app");
    const result = describeThreadHelpers({
      subagents: [{ ...child, title: "x".repeat(100) }],
      monitors: [],
    });
    expect(result).toBe(`Keeps 1 subagent running: ${"x".repeat(39)}…`);
  });
});
