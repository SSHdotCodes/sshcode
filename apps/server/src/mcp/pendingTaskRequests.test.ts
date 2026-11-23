import { expect, it } from "@effect/vitest";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import { pendingTaskRequests, pendingTaskNeeds } from "./pendingTaskRequests.ts";

it("shows approvals before input, clears answered requests, and ignores background runtime requests", () => {
  const question = { kind: "user_input", status: "pending" };
  for (const kind of ["command", "file-read", "file-change", "permission", "mcp-elicitation"]) {
    expect(pendingTaskNeeds({ runtimeRequests: [question, { kind, status: "pending" }] })).toBe(
      "approval",
    );
  }
  expect(
    pendingTaskNeeds({ runtimeRequests: [question, { kind: "command", status: "resolved" }] }),
  ).toBe("input");
  expect(
    pendingTaskNeeds({
      runtimeRequests: [
        { ...question, status: "cancelled" },
        { kind: "auth_refresh", status: "pending" },
      ],
    }),
  ).toBeUndefined();
});

it("returns distinct short handles for concurrent requests and omits resolved requests", () => {
  const projection = {
    runtimeRequests: [
      { id: "question-1", kind: "user_input", status: "pending" },
      { id: "approval-1", kind: "command", status: "pending" },
      { id: "old", kind: "user_input", status: "resolved" },
    ],
    turnItems: [
      {
        type: "user_input_request",
        requestId: "question-1",
        title: null,
        questions: [{ header: "a".repeat(100) }],
      },
      { type: "approval_request", requestId: "approval-1", title: "Run command" },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  expect(pendingTaskRequests(projection)).toEqual([
    { id: "question-1", kind: "user_input", label: "a".repeat(80) },
    { id: "approval-1", kind: "command", label: "Run command" },
  ]);
  expect(pendingTaskRequests({ runtimeRequests: [], turnItems: [] })).toEqual([]);
});
