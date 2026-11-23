import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelComparison,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  comparisonSelectionError,
  comparisonThreadInput,
  groupComparisonThreads,
  sendComparisonFollowUp,
} from "./modelComparison.ts";
import { presentThreadShell } from "./models.ts";

const selection = (model: string, instance = "account") => ({
  instanceId: ProviderInstanceId.make(instance),
  model,
});
const ids = [ThreadId.make("a"), ThreadId.make("b"), ThreadId.make("c")];
const group: ModelComparison = { id: "comparison", title: "Build a tool", threadIds: ids };
const now = "2026-10-26T12:00:00.000Z";
function shell(
  id: ThreadId,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
  environment = "mac",
) {
  const date = DateTime.makeUnsafe(now);
  return presentThreadShell(EnvironmentId.make(environment), {
    id,
    projectId: ProjectId.make("folder"),
    title: "Build a tool",
    providerInstanceId: selection("x").instanceId,
    modelSelection: selection("x"),
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: date,
    updatedAt: date,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    comparison: group,
    ...overrides,
  });
}

describe("comparison selection", () => {
  it("accepts 2–4 distinct models from any instances", () => {
    for (const count of [2, 3, 4])
      expect(
        comparisonSelectionError(
          Array.from({ length: count }, (_, i) => selection(`live-${i}`, `account-${i}`)),
        ),
      ).toBeNull();
    for (const count of [0, 1, 5])
      expect(
        comparisonSelectionError(Array.from({ length: count }, (_, i) => selection(`live-${i}`))),
      ).toContain("two to four");
    expect(comparisonSelectionError([selection("x"), selection("x")])).toContain("different");
    expect(comparisonSelectionError([selection("x", "one"), selection("x", "two")])).toBeNull();
  });
});

it("creates regular chats with identical content, modes and folder, preserving each model's options", () => {
  const message = {
    messageId: MessageId.make("message"),
    role: "user" as const,
    text: "Build a tool",
    context: { version: 1 as const, records: [] },
    attachments: [
      {
        type: "image" as const,
        id: "image",
        name: "design.png",
        mimeType: "image/png",
        sizeBytes: 10,
        url: "/attachments/image.png",
      },
    ],
  };
  const turns = [
    selection("default"),
    { ...selection("custom", "other-account"), options: [{ id: "effort", value: "high" }] },
  ].map((modelSelection, index) =>
    comparisonThreadInput({
      projectId: ProjectId.make("folder"),
      workspaceRoot: "/repo",
      title: "Build a tool",
      isGitRepo: true,
      baseBranch: "main",
      turn: {
        threadId: ids[index]!,
        message,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: now,
      },
    }),
  );
  expect(turns.map((turn) => turn.message)).toEqual([message, message]);
  expect(turns[0]?.modelSelection?.options).toBeUndefined();
  expect(turns[1]?.modelSelection?.options).toEqual([{ id: "effort", value: "high" }]);
  expect(new Set(turns.map((turn) => turn.threadId)).size).toBe(2);
  for (const turn of turns)
    expect(turn.bootstrap).toMatchObject({
      createThread: {
        projectId: "folder",
        runtimeMode: "full-access",
        interactionMode: "default",
        worktreePath: null,
      },
      prepareWorktree: { projectCwd: "/repo", baseBranch: "main", requireWorktree: true },
    });
  const local = comparisonThreadInput({
    projectId: ProjectId.make("folder"),
    workspaceRoot: "/folder",
    title: "Tool",
    isGitRepo: false,
    baseBranch: null,
    turn: turns[0]!,
  });
  expect(local.bootstrap?.prepareWorktree).toBeUndefined();
  expect(local.bootstrap?.createThread?.projectId).toBe("folder");
  expect(() =>
    comparisonThreadInput({
      projectId: ProjectId.make("folder"),
      workspaceRoot: "/repo",
      title: "Tool",
      isGitRepo: true,
      baseBranch: null,
      turn: turns[0]!,
    }),
  ).toThrow("base branch");
});

it("groups only members of the same environment and combines their status", () => {
  const a = shell(ids[0]!);
  const b = { ...shell(ids[1]!), hasPendingUserInput: true };
  const c = {
    ...shell(ids[2]!),
    runtime: {
      status: "running" as const,
      activeRunId: null,
      providerInstanceId: selection("x").instanceId,
      providerName: null,
      lastError: null,
      updatedAt: now,
    },
  };
  const grouped = groupComparisonThreads([c, b, a, shell(ids[0]!, {}, "other-mac")]);
  expect(grouped).toHaveLength(2);
  expect(grouped[0]).toMatchObject({
    id: "a",
    title: "Compare: Build a tool",
    hasPendingUserInput: true,
    runtime: { status: "running" },
  });
  expect(grouped[1]?.environmentId).toBe("other-mac");
  expect(groupComparisonThreads(grouped)).toEqual(grouped);
});

it("keeps settled members reachable and returns normal rows when membership ends", () => {
  const rows = [
    shell(ids[0]!),
    shell(ids[1]!, { settledAt: DateTime.makeUnsafe(now), settledOverride: "settled" }),
  ];
  expect(groupComparisonThreads(rows)).toHaveLength(2);
  const ended = rows.map((row) => ({ ...row, source: { ...row.source, comparison: null } }));
  expect(groupComparisonThreads(ended)).toEqual(ended);
});

it("sends a follow-up to every member once and retains individual failures for a safe retry", async () => {
  const sent: string[] = [];
  const results = await sendComparisonFollowUp(["a", "b", "c"], async (id) => {
    sent.push(id);
    if (id === "b") throw new Error("offline");
  });
  expect(sent).toEqual(["a", "b", "c"]);
  expect(results).toEqual([
    { member: "a", error: null },
    { member: "b", error: "offline" },
    { member: "c", error: null },
  ]);
  await sendComparisonFollowUp(
    results.filter((result) => result.error).map((result) => result.member),
    async (id) => {
      sent.push(id);
    },
  );
  expect(sent).toEqual(["a", "b", "c", "b"]);
});

it("surfaces a failed member even after its runtime parks at idle", () => {
  const failed = shell(ids[1]!, { latestRunId: RunId.make("failed-run"), status: "failed" });
  const grouped = groupComparisonThreads([shell(ids[0]!), { ...failed, runtime: null }]);
  expect(grouped[0]?.latestRun?.status).toBe("failed");
});
