import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertNoExtraAppRunsForProviderChildren,
  assertSemanticProjectionIntegrity,
  backgroundNotifications,
  projectionFor,
} from "../shared.ts";

const CHILD_TASK_ID = "a5d7d869cbb05c754";
const GRANDCHILD_TASK_ID = "a412f30077dfd84dd";

// The grandchild ends while the root is idle, but Claude reports that end to
// the child that started it. Only the child's end wakes the root, so it alone
// opens run 2 and names the wake.
export function assertClaudeNestedBackgroundSubagentWakeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertNoExtraAppRunsForProviderChildren({ projection, expectedAppRuns: 2 });

  const byTask = (taskId: string) => {
    const subagent = projection.subagents.find((agent) => agent.nativeTaskRef?.nativeId === taskId);
    assert.isDefined(subagent, `missing subagent for task ${taskId}`);
    assert.equal(subagent.status, "completed");
    return subagent;
  };
  const child = byTask(CHILD_TASK_ID);
  const grandchild = byTask(GRANDCHILD_TASK_ID);
  assert.equal(child.parentNodeId, projection.runs[0]?.rootNodeId);
  assert.equal(grandchild.parentNodeId, child.id, "the grandchild hangs off the child");
  // The grandchild starts while the root is idle. Its buffered notification
  // must never move its launch into the later wake turn.
  assert.equal(grandchild.runId, projection.runs[0]?.id);
  for (const event of result.domainEvents) {
    if (event.type === "subagent.updated" && event.payload.id === grandchild.id) {
      assert.equal(event.payload.runId, projection.runs[0]?.id);
      assert.notEqual(event.payload.status, "cancelled");
    }
  }

  const wakeMessage = projection.messages.find(
    (message) => message.id === projection.runs[1]?.userMessageId,
  );
  assert.equal(wakeMessage?.text, "CHILD_DONE", "the child's end opens the wake");
  if (child.childThreadId === null) {
    throw new Error("The child subagent is missing its child thread.");
  }
  assert.deepEqual(backgroundNotifications(projection), [
    {
      summary: `Subagent "${child.title}" finished`,
      outcome: "completed",
      source: { kind: "subagent", childThreadId: child.childThreadId },
    },
  ]);
}
