import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { deriveThreadTurnSubagents, resolveSubagentPillSegment } from "./threadSubagents.ts";

const at = (iso: string) => DateTime.makeUnsafe(iso);

function subagent(
  overrides: Omit<Partial<OrchestrationV2Subagent>, "id"> & { readonly id: string },
): OrchestrationV2Subagent {
  const { id, ...rest } = overrides;
  return {
    id: NodeId.make(id),
    threadId: ThreadId.make("thread-1"),
    runId: RunId.make("run-1"),
    parentNodeId: NodeId.make("node-1"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: ThreadId.make("thread-child"),
    nativeTaskRef: null,
    prompt: "Do the thing",
    title: "Worker",
    model: "gpt-5.4",
    status: "running",
    result: null,
    startedAt: at("2026-06-20T00:00:00.000Z"),
    completedAt: null,
    updatedAt: at("2026-06-20T00:00:01.000Z"),
    ...rest,
  };
}

const run = (id: string, status: "running" | "completed", startedAt = "2026-06-20T00:00:02.000Z") =>
  ({ id: RunId.make(id), status, requestedAt: at(startedAt), startedAt: at(startedAt) }) as never;
const activeRun = run("run-1", "running");
const finishedRun = run("run-1", "completed");

describe("deriveThreadTurnSubagents", () => {
  it("includes remote subagents in the mobile roster and live pill", () => {
    const remote = subagent({ id: "nova", remote: { environmentId: EnvironmentId.make("nova") } });
    const turn = deriveThreadTurnSubagents({ runs: [activeRun], subagents: [remote] });
    expect(turn?.subagents).toEqual([remote]);
    expect(turn?.liveCount).toBe(1);
    expect(resolveSubagentPillSegment(turn)?.accessibilityLabel).toBe("1 of 1 agents working");
  });

  it("returns null when the thread has never spawned an agent", () => {
    expect(deriveThreadTurnSubagents({ runs: [activeRun], subagents: [] })).toBeNull();
  });

  it("scopes the roster to the active run and orders it by start time", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-0", "completed"), activeRun],
      subagents: [
        subagent({ id: "b", startedAt: at("2026-06-20T00:00:05.000Z") }),
        subagent({ id: "old", runId: RunId.make("run-0"), status: "completed" }),
        subagent({ id: "a", startedAt: at("2026-06-20T00:00:02.000Z") }),
      ],
    });

    expect(turn?.runId).toBe("run-1");
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(turn?.turnActive).toBe(true);
  });

  it("keeps agents an earlier turn started while they are still working", () => {
    // A child's completion wakes the parent into a new turn while its
    // siblings from the turn that spawned them keep running.
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-0", "completed"), activeRun],
      subagents: [
        subagent({ id: "sibling-done", runId: RunId.make("run-0"), status: "completed" }),
        subagent({ id: "sibling-working", runId: RunId.make("run-0") }),
      ],
    });

    expect(turn?.runId).toBe("run-1");
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["sibling-working"]);
    expect(turn?.liveCount).toBe(1);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("1/1");
  });

  it("keeps agents an earlier turn started that finish during this one", () => {
    // A steer starts a new turn while a delegated task is still out. When the
    // task reports back, the turn reading its result still lists it.
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-0", "completed", "2026-06-19T23:59:00.000Z"), activeRun],
      subagents: [
        subagent({
          id: "finished-before",
          runId: RunId.make("run-0"),
          status: "completed",
          completedAt: at("2026-06-20T00:00:01.000Z"),
        }),
        subagent({
          id: "finished-during",
          runId: RunId.make("run-0"),
          status: "completed",
          completedAt: at("2026-06-20T00:00:05.000Z"),
          updatedAt: at("2026-06-20T00:00:05.000Z"),
        }),
      ],
    });

    expect(turn?.runId).toBe("run-1");
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["finished-during"]);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("1 done");
  });

  it("keeps the tasks whose results woke this turn", () => {
    // A child's completion wakes the parent after the child finished, so the
    // wake run starts later; it continues work that began with the prompt.
    const wake = {
      id: RunId.make("run-1"),
      status: "running",
      requestedAt: at("2026-06-20T00:00:10.000Z"),
      startedAt: at("2026-06-20T00:00:10.000Z"),
      workStartedAt: at("2026-06-19T23:59:00.000Z"),
    } as never;
    const turn = deriveThreadTurnSubagents({
      runs: [run("run-0", "completed", "2026-06-19T23:59:00.000Z"), wake],
      subagents: [
        subagent({
          id: "before-prompt",
          runId: RunId.make("run-earlier"),
          status: "completed",
          completedAt: at("2026-06-19T23:00:00.000Z"),
          updatedAt: at("2026-06-19T23:00:00.000Z"),
        }),
        subagent({
          id: "woke-parent",
          runId: RunId.make("run-0"),
          status: "completed",
          completedAt: at("2026-06-20T00:00:05.000Z"),
          updatedAt: at("2026-06-20T00:00:05.000Z"),
        }),
      ],
    });

    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["woke-parent"]);
    expect(resolveSubagentPillSegment(turn)?.label).toBe("1 done");
  });

  it("falls back to the most recently updated agent's run once the turn settles", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun, run("run-2", "completed")],
      subagents: [
        subagent({ id: "old", status: "completed", updatedAt: at("2026-06-20T00:00:01.000Z") }),
        subagent({
          id: "recent",
          runId: RunId.make("run-2"),
          status: "completed",
          updatedAt: at("2026-06-20T00:00:09.000Z"),
        }),
      ],
    });

    expect(turn?.runId).toBe("run-2");
    expect(turn?.turnActive).toBe(false);
    expect(turn?.subagents.map((entry) => entry.id)).toEqual(["recent"]);
  });

  it("lists working agents before idle ones and finished ones last", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [
        subagent({
          id: "done-early",
          status: "completed",
          startedAt: at("2026-06-20T00:00:01.000Z"),
        }),
        subagent({ id: "idle", status: "idle", startedAt: at("2026-06-20T00:00:02.000Z") }),
        subagent({ id: "working-late", startedAt: at("2026-06-20T00:00:06.000Z") }),
        subagent({ id: "failed", status: "failed", startedAt: at("2026-06-20T00:00:03.000Z") }),
        subagent({ id: "working-early", startedAt: at("2026-06-20T00:00:04.000Z") }),
      ],
    });

    expect(turn?.subagents.map((entry) => entry.id)).toEqual([
      "working-early",
      "working-late",
      "idle",
      "done-early",
      "failed",
    ]);
  });

  it("counts idle as neither working nor done", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [
        subagent({ id: "a", status: "running" }),
        subagent({ id: "b", status: "idle" }),
        subagent({ id: "c", status: "failed" }),
      ],
    });

    expect(turn?.liveCount).toBe(1);
    expect(turn?.settledCount).toBe(1);
    expect(turn?.subagents).toHaveLength(3);
  });
});

describe("resolveSubagentPillSegment", () => {
  it("shows how many of the turn's agents are still working", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [
        subagent({ id: "a", status: "running" }),
        subagent({ id: "b", status: "waiting" }),
        subagent({ id: "c", status: "completed" }),
      ],
    });

    expect(resolveSubagentPillSegment(turn)).toEqual({
      label: "2/3",
      accessibilityLabel: "2 of 3 agents working",
    });
  });

  it("reports the finished roster while the turn is still running", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [activeRun],
      subagents: [subagent({ id: "a", status: "completed" })],
    });

    expect(resolveSubagentPillSegment(turn)).toEqual({
      label: "1 done",
      accessibilityLabel: "1 agent done",
    });
  });

  it("hides itself once the turn is over and nothing is working", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun],
      subagents: [subagent({ id: "a", status: "completed" })],
    });

    expect(resolveSubagentPillSegment(turn)).toBeNull();
    expect(resolveSubagentPillSegment(null)).toBeNull();
  });

  it("stays visible after the turn ends while an agent is still working", () => {
    const turn = deriveThreadTurnSubagents({
      runs: [finishedRun],
      subagents: [subagent({ id: "a", status: "running" })],
    });

    expect(resolveSubagentPillSegment(turn)?.label).toBe("1/1");
  });
});
