import { RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import type { ProjectionLimitRecoveryCandidate } from "./ProjectionStore.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

const HOUR = 3_600_000;
const now = Date.parse("2026-10-30T16:40:00.000Z");

const stopped = (resetAt: string): ProjectionLimitRecoveryCandidate => ({
  id: ThreadId.make("thread-limit"),
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make("thread-limit"),
  },
  creationSource: "web",
  status: "failed",
  lastErrorClass: "usage_limit",
  latestRunId: RunId.make("run-limit"),
  usageLimitResetAt: resetAt,
  archivedAt: null,
  settledOverride: null,
  pendingRuntimeRequest: null,
  latestRunCompletedAt: DateTime.makeUnsafe(Date.parse("2026-10-28T02:11:00.000Z")),
  updatedAt: DateTime.makeUnsafe(Date.parse("2026-10-28T02:11:00.000Z")),
  limitRecovery: null,
  snoozedUntil: null,
});

describe("usage-limit recovery", () => {
  it("leaves a stop alone when its reset passed before auto-resume was turned on", () => {
    // Stopped Oct 27, reset Oct 28 8:00; the setting came on Oct 30.
    expect(limitRecoveryCommand(stopped("2026-10-28T12:00:00.000Z"), true, now)).toBeNull();
    expect(limitRecoveryCommand(stopped("2026-10-28T12:00:00.000Z"), true, now, true)).toBeNull();
  });

  it.each(["local", "remote"] as const)(
    "the blanket setting never arms a %s subagent; a resume the owner asked for still runs",
    (kind) => {
      const resetAt = DateTime.formatIso(DateTime.makeUnsafe(now + HOUR));
      const base = stopped(resetAt);
      const thread: ProjectionLimitRecoveryCandidate = {
        ...base,
        creationSource: kind === "local" ? "mcp" : "server",
        lineage: {
          ...base.lineage,
          relationshipToParent: "subagent",
          parentThreadId: ThreadId.make("parent"),
        },
      };
      expect(limitRecoveryCommand(thread, true, now)).toBeNull();
      expect(limitRecoveryCommand(thread, true, now, true)).toMatchObject({
        limitRecovery: { autoResume: false, snooze: true },
      });
      expect(
        limitRecoveryCommand(
          { ...thread, limitRecovery: { runId: thread.latestRunId!, resetAt, autoResume: true } },
          false,
          now + HOUR,
        ),
      ).toMatchObject({
        type: "message.dispatch",
        usageLimitContinuationOfRunId: thread.latestRunId,
      });
    },
  );

  it("arms a chat that is still waiting for its reset", () => {
    const resetAt = DateTime.formatIso(DateTime.makeUnsafe(now + 2 * HOUR));
    expect(limitRecoveryCommand(stopped(resetAt), true, now)).toMatchObject({
      type: "thread.metadata.update",
      limitRecovery: { resetAt, autoResume: true },
    });
  });
});
