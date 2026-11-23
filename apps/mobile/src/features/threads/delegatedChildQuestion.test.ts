import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { delegatedChildQuestionIsForParent } from "./delegatedChildQuestion";

function thread(
  overrides: Partial<Pick<OrchestrationV2ThreadShell, "lineage" | "forkedFrom" | "creationSource">>,
): Pick<OrchestrationV2ThreadShell, "lineage" | "forkedFrom" | "creationSource"> {
  return {
    creationSource: "mcp",
    lineage: {
      parentThreadId: "thread-parent" as never,
      relationshipToParent: "subagent",
      rootThreadId: "thread-parent" as never,
    },
    forkedFrom: { type: "node", nodeId: "node-1" as never },
    ...overrides,
  };
}

describe("delegatedChildQuestionIsForParent", () => {
  it("hides the reply field on a delegated child", () => {
    expect(delegatedChildQuestionIsForParent(thread({}))).toBe(true);
  });

  it("leaves the parent chat, a fork, and a provider subagent able to answer", () => {
    expect(
      delegatedChildQuestionIsForParent(
        thread({
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: "thread-parent" as never,
          },
          forkedFrom: null,
        }),
      ),
    ).toBe(false);
    expect(
      delegatedChildQuestionIsForParent(
        thread({
          lineage: {
            parentThreadId: "thread-parent" as never,
            relationshipToParent: "fork",
            rootThreadId: "thread-parent" as never,
          },
          forkedFrom: { type: "run", threadId: "thread-parent" as never, runId: "run-1" as never },
        }),
      ),
    ).toBe(false);
    expect(delegatedChildQuestionIsForParent(thread({ creationSource: "provider" }))).toBe(false);
  });
});
