import { describe, expect, it } from "vite-plus/test";
import { WorkflowId, type WorkflowDefinition } from "@t3tools/contracts";
import { decideWorkflowDraftRestore } from "./workflowDrafts";

function doc(updatedAt: string, name = "Team"): WorkflowDefinition {
  return {
    version: 1,
    id: WorkflowId.make("team"),
    name,
    description: "",
    rootNodeId: null,
    nodes: [],
    edges: [],
    createdAt: "2026-11-06T05:00:00.000Z",
    updatedAt,
  };
}

describe("decideWorkflowDraftRestore", () => {
  it("drops a draft the server already has", () => {
    const remote = doc("2026-11-06T05:01:00.000Z", "Renamed");
    expect(
      decideWorkflowDraftRestore(remote, {
        base: doc("2026-11-06T05:00:00.000Z"),
        draft: { ...remote },
      }),
    ).toEqual({ kind: "none" });
  });
  it("restores edits made on top of the current server copy", () => {
    const remote = doc("2026-11-06T05:00:00.000Z");
    const draft = doc("2026-11-06T05:01:00.000Z", "Renamed");
    expect(decideWorkflowDraftRestore(remote, { base: remote, draft })).toEqual({
      kind: "restore",
      draft,
      saved: remote,
    });
  });
  it("keeps the draft's base when another device saved after it, so the editor warns", () => {
    const base = doc("2026-11-06T05:00:00.000Z");
    const draft = doc("2026-11-06T05:01:00.000Z", "Phone edit");
    const remote = doc("2026-11-06T05:02:00.000Z", "Mac edit");
    const decision = decideWorkflowDraftRestore(remote, { base, draft });
    expect(decision).toEqual({ kind: "restore", draft, saved: base });
    if (decision.kind === "restore") expect(decision.saved.updatedAt).not.toBe(remote.updatedAt);
  });
});
