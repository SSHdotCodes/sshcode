import { WorkflowId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { matchComposerWorkflowItems } from "./ComposerWorkflow";
import { exampleWorkflow } from "./workflowExamples";

describe("matchComposerWorkflowItems", () => {
  const opus = { ...exampleWorkflow("2026-11-06T17:00:00.000Z", false), name: "Opus team" };
  const release = {
    ...exampleWorkflow("2026-11-06T18:00:00.000Z", true),
    id: WorkflowId.make("wf_release"),
  };

  it("offers workflows whose name has every typed word", () => {
    expect(matchComposerWorkflowItems([opus, release], "opus")).toEqual([
      {
        id: `workflow:${opus.id}`,
        type: "workflow",
        workflowId: opus.id,
        label: "Opus team",
        description: "Workflow · 5 agents",
      },
    ]);
    expect(
      matchComposerWorkflowItems([opus, release], "the rel").map((item) => item.label),
    ).toEqual(["Ship the release"]);
  });

  it("stays quiet until something is typed", () => {
    expect(matchComposerWorkflowItems([opus, release], "  ")).toEqual([]);
  });
});
