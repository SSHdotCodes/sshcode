import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  UNOPENED_FAILURE_ATTENTION_MS,
  createInboxReturnTracker,
  failureNeedsYou,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  it("stamps a thread when it stops working, but never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", true))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();

    tracker.observe([thread("a", false), thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeDefined();
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
  });

  it("forgets deleted threads and resets when the beta turns off", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([thread("a", false), thread("b", false)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();

    tracker.observe(null);
    expect(tracker.returnedAt(thread("b", false))).toBeUndefined();
    // After a reset the next call is a fresh baseline again.
    tracker.observe([thread("b", true)]);
    tracker.observe([thread("b", false)]);
    expect(tracker.returnedAt(thread("b", false))).toBeDefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      // A wake run requested after the other thread's send.
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    // Launched by an agent: no user message, so creation time is the send.
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});

it("orders a newly created independent chat like a new user chat without requiring a user-authored message", () => {
  const created = {
    ...thread("created", true),
    createdAt: "2026-06-01T03:00:00.000Z",
    latestUserAuthoredMessageAt: null,
  };
  const older = {
    ...thread("older", true),
    latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
  };
  const userCreated = {
    ...thread("user-created", true),
    createdAt: created.createdAt,
    latestUserAuthoredMessageAt: null,
  };
  expect(sortWorkingThreadsBySend([older, created]).map((row) => row.id)).toEqual([
    "created",
    "older",
  ]);
  expect(sortWorkingThreadsBySend([older, userCreated]).map((row) => row.id)).toEqual([
    "user-created",
    "older",
  ]);
});

describe("failureNeedsYou", () => {
  const failedAt = "2026-06-01T12:00:00.000Z";
  const at = (iso: string) => Date.parse(iso);
  const failed = (overrides: {
    readonly lastVisitedAt?: string | null;
    readonly completedAt?: string | null;
    readonly status?: "failed" | "completed";
    readonly subagent?: boolean;
  }) => ({
    updatedAt: "2026-06-01T12:00:05.000Z",
    lineage: {
      rootThreadId: ThreadId.make("root"),
      parentThreadId: overrides.subagent ? ThreadId.make("root") : null,
      relationshipToParent: overrides.subagent ? ("subagent" as const) : null,
    },
    latestRun:
      overrides.completedAt === null
        ? null
        : {
            runId: RunId.make("run"),
            status: "failed" as const,
            requestedAt: null,
            startedAt: null,
            completedAt: overrides.completedAt ?? failedAt,
            assistantMessageId: null,
          },
    runtime: {
      status: overrides.status ?? ("failed" as const),
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: "Command failed",
      updatedAt: failedAt,
    },
    ...("lastVisitedAt" in overrides ? { lastVisitedAt: overrides.lastVisitedAt } : {}),
  });
  const soon = at("2026-06-01T13:00:00.000Z");

  it("asks until the chat is opened after the failure", () => {
    expect(failureNeedsYou(failed({ lastVisitedAt: "2026-06-01T11:00:00.000Z" }), soon)).toBe(true);
    expect(failureNeedsYou(failed({ lastVisitedAt: "2026-06-01T12:00:01.000Z" }), soon)).toBe(
      false,
    );
    // Seen stays seen, however long ago.
    expect(
      failureNeedsYou(
        failed({ lastVisitedAt: "2026-06-01T12:00:01.000Z" }),
        at("2026-09-01T00:00:00.000Z"),
      ),
    ).toBe(false);
    // Unseen stays unseen too: only opening the chat clears it.
    expect(
      failureNeedsYou(
        failed({ lastVisitedAt: "2026-06-01T11:00:00.000Z" }),
        at("2026-09-01T00:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("asks for a day when nobody has opened the chat, then goes quiet", () => {
    const unopened = failed({ lastVisitedAt: null });
    expect(failureNeedsYou(unopened, soon)).toBe(true);
    expect(failureNeedsYou(unopened, at(failedAt) + UNOPENED_FAILURE_ATTENTION_MS)).toBe(false);
    expect(failureNeedsYou(failed({}), soon)).toBe(true);
  });

  it("uses the chat's last change when the failed turn has no end time", () => {
    const shell = failed({ completedAt: null, lastVisitedAt: "2026-06-01T12:00:03.000Z" });
    expect(failureNeedsYou(shell, soon)).toBe(true);
    expect(failureNeedsYou({ ...shell, lastVisitedAt: "2026-06-01T12:00:06.000Z" }, soon)).toBe(
      false,
    );
  });

  it("never asks for a subagent's failure or a chat that did not fail", () => {
    expect(failureNeedsYou(failed({ subagent: true, lastVisitedAt: null }), soon)).toBe(false);
    expect(failureNeedsYou(failed({ status: "completed", lastVisitedAt: null }), soon)).toBe(false);
  });
});
