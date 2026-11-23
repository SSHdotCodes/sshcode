import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import { makeThreadShellFixture } from "../../test-fixtures";
import { isWorkflowThread, workflowListHiddenKeys } from "./workflowVisibility";

const key = (thread: ReturnType<typeof makeThreadShellFixture>) =>
  threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id });

describe("workflow list visibility", () => {
  it("hides dedicated leads and their known lineage without needing retained run history", () => {
    const normal = makeThreadShellFixture({ id: ThreadId.make("chat"), title: "Normal chat" });
    const lead = makeThreadShellFixture({ id: ThreadId.make("lead"), title: "Workflow lead" });
    // Wire provenance is preserved after its bounded run record has been pruned.
    Object.defineProperty(lead.source, "creationSource", { value: "workflows" });
    const child = makeThreadShellFixture({
      id: ThreadId.make("child"),
      title: "Worker",
      lineage: { parentThreadId: lead.id, relationshipToParent: "subagent", rootThreadId: lead.id },
    });
    expect(isWorkflowThread(lead)).toBe(true);
    expect(isWorkflowThread(normal)).toBe(false);
    const hidden = workflowListHiddenKeys([normal, lead, child]);
    expect([...hidden]).toEqual([key(lead), key(child)]);
    expect(hidden.has(key(normal))).toBe(false);
  });
});
