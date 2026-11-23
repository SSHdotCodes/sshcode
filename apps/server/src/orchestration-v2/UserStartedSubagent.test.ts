import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { delegatedCompletionWakeDetail } from "./NotificationMailbox.ts";
import { userStartedSubagentNotice } from "./ProviderTurnStartService.ts";
import { taskReference } from "./taskReference.ts";

const now = DateTime.makeUnsafe("2026-11-17T20:00:00.000Z");
const leadThreadId = ThreadId.make("thread:lead");

const task = (overrides: Partial<OrchestrationV2Subagent> = {}): OrchestrationV2Subagent => ({
  id: NodeId.make("node:delegated-task:user-start"),
  threadId: leadThreadId,
  runId: RunId.make("run:lead:1"),
  parentNodeId: NodeId.make("node:lead-root"),
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerThreadId: null,
  childThreadId: ThreadId.make("thread:child"),
  nativeTaskRef: null,
  prompt: "Check why the build is slow",
  title: null,
  model: "gpt-5.4",
  status: "completed",
  result: "The cache key changes on every run.",
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  ...overrides,
});

describe("what the lead reads about a subagent the user started", () => {
  it("names who started it and what was asked", () => {
    const started = task({ createdBy: "user" });
    assert.equal(
      delegatedCompletionWakeDetail([started.id], [started]),
      `Subagent ${taskReference(started.id)} (started by the user, who asked: Check why the build is slow): completed (codex/gpt-5.4)\nThe cache key changes on every run.`,
    );
  });

  it("points at the subagent's own chat, which a lead with subagents off can still read", () => {
    const silent = task({ createdBy: "user", result: null });
    assert.include(
      delegatedCompletionWakeDetail([silent.id], [silent]),
      'No result text. Read t3_thread_read({threadId:"thread:child"}).',
    );
    const long = task({ createdBy: "user", result: "y".repeat(6000) });
    assert.isTrue(
      delegatedCompletionWakeDetail([long.id], [long]).endsWith(
        '\n… rest: t3_thread_read({threadId:"thread:child"})',
      ),
    );
    // The lead's own subagents read as before.
    const own = task({ result: null });
    assert.include(
      delegatedCompletionWakeDetail([own.id], [own]),
      `Read task_status({taskId:"${taskReference(own.id)}"}).`,
    );
  });

  it("keeps a long or multi-line task to one short line", () => {
    const started = task({
      createdBy: "user",
      prompt: `Look at\n  the build.\n${"x".repeat(600)}`,
    });
    const header = delegatedCompletionWakeDetail([started.id], [started]).split("\n")[0]!;
    assert.include(header, "who asked: Look at the build. xxx");
    assert.include(header, "…): completed");
    assert.isBelow(header.length, 420);
  });

  it("leaves the result of the lead's own subagent exactly as before", () => {
    const own = task();
    assert.equal(
      delegatedCompletionWakeDetail([own.id], [own]),
      `Subagent ${taskReference(own.id)}: completed (codex/gpt-5.4)\nThe cache key changes on every run.`,
    );
  });
});

describe("what a subagent the user started reads on its first turn", () => {
  const thread = {
    createdBy: "user" as const,
    creationSource: "web" as const,
    lineage: {
      parentThreadId: leadThreadId,
      relationshipToParent: "subagent" as const,
      rootThreadId: leadThreadId,
    },
  };
  const first = { id: RunId.make("run:child:1"), ordinal: 1, startedAt: null };

  it("points it at the lead's chat for background", () => {
    assert.equal(
      userStartedSubagentNotice(thread, [first], first),
      "The user started this task from chat thread:lead. Read that chat with t3_thread_read when you need background.",
    );
  });

  it("says it once, also when a restart continues a first run that never started", () => {
    const continuation = { id: RunId.make("run:child:2"), ordinal: 2, startedAt: null };
    assert.isDefined(userStartedSubagentNotice(thread, [first, continuation], continuation));
    const later = { id: RunId.make("run:child:3"), ordinal: 3, startedAt: null };
    assert.isUndefined(
      userStartedSubagentNotice(thread, [{ ...first, startedAt: now }, continuation, later], later),
    );
  });

  it("says nothing to the lead's own subagents, forks or ordinary chats", () => {
    assert.isUndefined(
      userStartedSubagentNotice({ ...thread, createdBy: "agent" }, [first], first),
    );
    assert.isUndefined(
      userStartedSubagentNotice({ ...thread, creationSource: "provider" }, [first], first),
    );
    assert.isUndefined(
      userStartedSubagentNotice(
        { ...thread, lineage: { ...thread.lineage, relationshipToParent: "fork" } },
        [first],
        first,
      ),
    );
    assert.isUndefined(
      userStartedSubagentNotice(
        {
          ...thread,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: leadThreadId },
        },
        [first],
        first,
      ),
    );
  });
});
