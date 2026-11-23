import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { formatOverviewStatus, overviewStatusUpdate } from "./statusText.ts";

const now = Date.parse("2026-10-18T18:05:00.000Z");
const at = (minutesAgo: number) => DateTime.makeUnsafe(now - minutesAgo * 60_000);

function shell(
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell {
  const threadId = ThreadId.make(id);
  const instanceId = ProviderInstanceId.make("claudeAgent");
  return {
    id: threadId,
    projectId: ProjectId.make("project-scratch"),
    title: id,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "completed",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: at(600),
    updatedAt: at(30),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const subagentOf = (parent: string, id: string, overrides: Partial<OrchestrationV2ThreadShell>) =>
  shell(id, {
    lineage: {
      rootThreadId: ThreadId.make(parent),
      parentThreadId: ThreadId.make(parent),
      relationshipToParent: "subagent",
    },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
    ...overrides,
  });

describe("Overview status", () => {
  it("updates only changed records while the clock advances, and resets on new context", () => {
    const threads = [shell("unchanged"), shell("changed")];
    const first = formatOverviewStatus({ now, threads });
    const later = formatOverviewStatus({ now: now + 60_000, threads });
    assert.strictEqual(
      overviewStatusUpdate(later, first),
      `Now: 2026-10-18T18:06:00.000Z (time zone ${new Intl.DateTimeFormat().resolvedOptions().timeZone}).\nNo chat changes.`,
    );
    const changed = formatOverviewStatus({
      now: now + 60_000,
      threads: [threads[0]!, shell("changed", { status: "running" })],
    });
    const delta = overviewStatusUpdate(changed, first);
    assert.include(delta, 'Working:\n- "changed"');
    assert.notInclude(delta, "(id unchanged)");
    const removed = formatOverviewStatus({ now, threads: [threads[0]!] });
    assert.include(overviewStatusUpdate(removed, first), "No longer listed (ids): changed.");
    assert.include(overviewStatusUpdate(first), "Full snapshot (replaces earlier status)");
    assert.include(overviewStatusUpdate(first), "(id unchanged)");
    // A settled/archived record leaves the list even if its clock is unchanged.
    assert.include(
      overviewStatusUpdate(
        formatOverviewStatus({ now, threads: [shell("changed", { archivedAt: at(1) })] }),
        first,
      ),
      "unchanged, changed",
    );
  });
  it("lists what waits on the user first, then work, then what finished", () => {
    const text = formatOverviewStatus({
      now,
      timeZone: "America/New_York",
      threads: [
        shell("thread-done", {
          title: "Fix login",
          latestVisibleMessage: {
            id: MessageId.make("message-1"),
            role: "assistant",
            text: "Fixed the login bug\n\nand added a test.",
            updatedAt: at(30),
          },
        }),
        shell("thread-busy", {
          title: "Speed up builds",
          status: "running",
          activityRunStatus: "running",
          activityRunStartedAt: at(25),
          updatedAt: at(1),
        }),
        subagentOf("thread-busy", "thread-busy-child", {
          title: "Profile the build",
          status: "running",
          activityRunStatus: "running",
          activityRunStartedAt: at(10),
        }),
        shell("thread-asks", {
          title: "Pick a database",
          status: "running",
          activityRunStatus: "waiting",
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-1"),
            kind: "user_input",
            createdAt: at(5),
          },
          updatedAt: at(5),
        }),
        shell("thread-failed", {
          title: "Deploy",
          status: "failed",
          lastError: "The server   refused\nthe connection.",
          updatedAt: at(90),
        }),
        shell("thread-old", { updatedAt: at(5 * 24 * 60) }),
        shell("thread-settled", { settledAt: at(10) }),
        shell("thread-archived", { archivedAt: at(10) }),
        shell("overview-1", { title: "Overview" }),
        shell("models:saved", { title: "Models", status: "running" }),
      ],
    });
    assert.strictEqual(
      text,
      [
        "Now: 2026-10-18T18:05:00.000Z (time zone America/New_York).",
        "6 chats: 1 waiting on the user, 1 working, 2 finished or idle in the last 2 days, 2 older or settled (not listed).",
        "",
        "Waiting on the user:",
        '- "Pick a database" (id thread-asks) · claude-opus-5-5 · asked the user a question · working',
        "",
        "Working:",
        '- "Speed up builds" (id thread-busy) · claude-opus-5-5 · working, started 2026-10-18T17:40:00.000Z',
        '  Subagents: 1 total, 1 working. "Profile the build" (id thread-busy-child, gpt-6.1-sol, working, started 2026-10-18T17:55:00.000Z)',
        "",
        "Recently finished or idle:",
        '- "Fix login" (id thread-done) · claude-opus-5-5 · finished at 2026-10-18T17:35:00.000Z',
        "  Last message (agent, 2026-10-18T17:35:00.000Z): Fixed the login bug and added a test.",
        '- "Deploy" (id thread-failed) · claude-opus-5-5 · failed at 2026-10-18T16:35:00.000Z: The server refused the connection.',
      ].join("\n"),
    );
  });

  it("puts a chat whose subagent asks the user under waiting", () => {
    const text = formatOverviewStatus({
      now,
      timeZone: "UTC",
      threads: [
        shell("thread-lead", { status: "completed" }),
        subagentOf("thread-lead", "thread-child", {
          status: "running",
          activityRunStatus: "waiting",
          pendingRuntimeRequest: {
            id: RuntimeRequestId.make("request-2"),
            kind: "command",
            createdAt: at(2),
          },
        }),
      ],
    });
    assert.include(text, 'Waiting on the user:\n- "thread-lead"');
    assert.include(
      text,
      'Subagents: 1 total, 1 working, 1 waiting on the user. "thread-child" (id thread-child, gpt-6.1-sol, wants the user\'s approval (command))',
    );
  });
});
