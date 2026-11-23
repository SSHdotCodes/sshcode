import * as DateTime from "effect/DateTime";
import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { makeThreadShellFixture } from "../../test-fixtures";
import {
  homeMachineSummaries,
  visibleHomeMachine,
  threadHasUnreadOutput,
  threadNeedsYou,
} from "./homeMachineModel";

const machine = EnvironmentId.make("mac");
const remote = EnvironmentId.make("remote");

describe("Home machine filter", () => {
  it("shows the filter only for two or more visible machines, omitting archived and subagent chats", () => {
    const threads = [
      makeThreadShellFixture({ environmentId: machine }),
      makeThreadShellFixture({ environmentId: remote, archivedAt: "2026-10-25T10:00:00Z" }),
      makeThreadShellFixture({
        environmentId: remote,
        lineage: {
          rootThreadId: ThreadId.make("root"),
          parentThreadId: ThreadId.make("root"),
          relationshipToParent: "subagent",
        },
      }),
    ];
    expect(homeMachineSummaries(threads).size).toBe(1);
    expect(
      homeMachineSummaries([...threads, makeThreadShellFixture({ environmentId: remote })]).size,
    ).toBe(2);
  });

  it("counts chats needing you per machine and falls back to All for a removed selection", () => {
    const summary = homeMachineSummaries([
      makeThreadShellFixture({ environmentId: machine, hasPendingApprovals: true }),
      makeThreadShellFixture({
        environmentId: machine,
        hasPendingUserInput: true,
        hasPendingApprovals: true,
      }),
      makeThreadShellFixture({ environmentId: remote }),
    ]);
    expect(summary.get(machine)?.needsYou).toBe(2);
    expect(summary.get(remote)?.needsYou).toBe(0);
    expect(visibleHomeMachine(machine, summary)).toBe(machine);
    expect(visibleHomeMachine("removed", summary)).toBeNull();
    expect(visibleHomeMachine(null, summary)).toBeNull();
  });

  it("counts a failed chat only until it has been opened", () => {
    const failedAt = "2026-10-25T12:00:00.000Z";
    const failed = (lastVisitedAt: string | null) =>
      makeThreadShellFixture({
        environmentId: machine,
        lastVisitedAt,
        latestRun: {
          runId: RunId.make("run"),
          status: "failed",
          requestedAt: null,
          startedAt: null,
          completedAt: failedAt,
          assistantMessageId: null,
        },
        runtime: {
          status: "failed",
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: null,
          lastError: "Command failed",
          updatedAt: failedAt,
        },
      });
    const now = Date.parse("2026-11-10T00:00:00.000Z");
    expect(threadNeedsYou(failed("2026-10-25T11:00:00.000Z"), now)).toBe(true);
    expect(threadNeedsYou(failed("2026-10-25T12:30:00.000Z"), now)).toBe(false);
    // Old failures nobody opened stay quiet, like the rest of unvisited history.
    expect(threadNeedsYou(failed(null), now)).toBe(false);
    expect(threadNeedsYou(failed(null), Date.parse("2026-10-25T13:00:00.000Z"))).toBe(true);
  });
});

it("marks agent output during a running turn as unread, without marking the user's prompt", () => {
  const base = makeThreadShellFixture({ lastVisitedAt: "2026-10-25T10:00:00Z" });
  const assistant = {
    ...base,
    source: {
      ...base.source,
      latestVisibleMessage: {
        id: MessageId.make("reply"),
        role: "assistant" as const,
        text: "Still working",
        updatedAt: DateTime.makeUnsafe("2026-10-25T10:01:00Z"),
      },
    },
  };
  expect(threadHasUnreadOutput(assistant)).toBe(true);
  expect(threadHasUnreadOutput({ ...assistant, lastVisitedAt: null })).toBe(false);
  expect(
    threadHasUnreadOutput({
      ...assistant,
      source: {
        ...assistant.source,
        latestVisibleMessage: { ...assistant.source.latestVisibleMessage, role: "user" },
      },
    }),
  ).toBe(false);
});
