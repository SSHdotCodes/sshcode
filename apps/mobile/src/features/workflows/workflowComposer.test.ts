import { describe, expect, it } from "vite-plus/test";
import { WorkflowId } from "@t3tools/contracts";
import { formatComposerContextReference } from "@t3tools/shared/composerContextReferences";
import {
  selectedComposerWorkflow,
  workflowComposerRecord,
  workflowComposerTask,
} from "./workflowComposer";

describe("workflow composer identity", () => {
  it("attaches only identity and a display name, never the graph or a provider plan", () => {
    const record = workflowComposerRecord({ id: WorkflowId.make("team"), name: "Build team" });
    expect(record).toEqual({
      version: 1,
      contextId: "workflow_team",
      kind: "workflow",
      label: "Build team",
      workflowId: "team",
    });
    const text = `${formatComposerContextReference(record)}\nBuild a feature`;
    const context = { version: 1 as const, records: [record] };
    expect(selectedComposerWorkflow(text, context)).toEqual(record);
    expect(workflowComposerTask(text, record)).toBe("Build a feature");
    expect(selectedComposerWorkflow("Build a feature", context)).toBeNull();
  });
  it("keeps task text and unrelated references intact when stripping the workflow chip", () => {
    const record = workflowComposerRecord({ id: WorkflowId.make("team"), name: "Build [team]" });
    const mention = "[reference](t3-context://v1/mention/mention_1)";
    const text = `${formatComposerContextReference(record)} Review ${mention}`;
    expect(workflowComposerTask(text, record)).toBe(`Review ${mention}`);
    expect(selectedComposerWorkflow(text)).toBeNull();
  });
});
