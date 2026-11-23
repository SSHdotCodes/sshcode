import { describe, expect, it } from "vite-plus/test";

import { makeRunningToolCalls } from "./runningToolCalls.ts";

describe("client terminal ownership", () => {
  it("matches concurrent commands within the same native session", () => {
    const calls = makeRunningToolCalls();
    for (const sessionId of ["root", "child"]) {
      for (const command of ["one", "two"]) {
        calls.track(sessionId, {
          sessionUpdate: "tool_call",
          title: command,
          kind: "execute",
          rawInput: { command },
          toolCallId: command,
        });
      }
    }
    calls.created("child", "1", "two");
    calls.created("root", "2", "two");
    calls.created("child", "3", "one");
    calls.track("child", {
      sessionUpdate: "tool_call_update",
      toolCallId: "two",
      status: "completed",
    });
    calls.track("root", { sessionUpdate: "tool_call_update", toolCallId: "two" });
    expect(calls.foreground()).toEqual([
      { sessionId: "root", terminalId: "2" },
      { sessionId: "child", terminalId: "3" },
    ]);
  });

  it("uses an explicit terminal link even when an earlier command matched", () => {
    const calls = makeRunningToolCalls();
    calls.track("s", {
      sessionUpdate: "tool_call",
      title: "run",
      kind: "execute",
      toolCallId: "a",
    });
    calls.created("s", "1", "run");
    calls.track("s", {
      sessionUpdate: "tool_call_update",
      toolCallId: "b",
      content: [{ type: "terminal", terminalId: "1" }],
    });
    calls.track("s", { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" });
    expect(calls.foreground()).toHaveLength(1);
    calls.track("s", { sessionUpdate: "tool_call_update", toolCallId: "b", status: "completed" });
    expect(calls.foreground()).toEqual([]);
  });

  it("keeps an unreported terminal and handles a call reported after creation", () => {
    const calls = makeRunningToolCalls();
    calls.created("s", "1", "one");
    calls.created("s", "2", "two");
    calls.track("s", {
      sessionUpdate: "tool_call",
      toolCallId: "b",
      title: "two",
      kind: "execute",
      rawInput: { command: "two" },
      status: "completed",
    });
    expect(calls.foreground()).toEqual([{ sessionId: "s", terminalId: "1" }]);
    calls.released("1");
    expect(calls.foreground()).toEqual([]);
  });
});
