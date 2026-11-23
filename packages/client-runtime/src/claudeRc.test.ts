import { expect, it } from "vite-plus/test";
import { initialClaudeRcState, reduceClaudeRcEvent } from "./claudeRc.ts";

it("replaces replayed and streaming messages instead of duplicating them", () => {
  const partial = reduceClaudeRcEvent(initialClaudeRcState, {
    type: "item",
    item: { id: "answer", role: "assistant", text: "hel" },
  });
  const final = reduceClaudeRcEvent(partial, {
    type: "item",
    item: { id: "answer", role: "assistant", text: "hello" },
  });
  expect(final.items).toEqual([{ id: "answer", role: "assistant", text: "hello" }]);
  expect(initialClaudeRcState.items).toEqual([]);
});

it("deduplicates approvals and removes them when the CLI settles them", () => {
  const event = {
    type: "permission" as const,
    permission: { requestId: "p", toolName: "Bash", description: "pwd" },
  };
  const state = reduceClaudeRcEvent(reduceClaudeRcEvent(initialClaudeRcState, event), event);
  expect(state.permissions).toHaveLength(1);
  expect(
    reduceClaudeRcEvent(state, { type: "permissionResolved", requestId: "p" }).permissions,
  ).toEqual([]);
});

it("assembles small streaming deltas without resending the full answer", () => {
  const first = reduceClaudeRcEvent(initialClaudeRcState, {
    type: "textDelta",
    id: "m",
    text: "hello ",
  });
  const second = reduceClaudeRcEvent(first, { type: "textDelta", id: "m", text: "world" });
  expect(second.items).toEqual([{ id: "m", role: "assistant", text: "hello world" }]);
});
