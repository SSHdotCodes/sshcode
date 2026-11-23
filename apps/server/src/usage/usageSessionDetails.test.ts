import { describe, expect, it } from "vite-plus/test";
import { sessionDetails } from "./usageSessionDetails.ts";

describe("session metadata", () => {
  it("reads native parents without treating forks as subagents", () => {
    expect(
      sessionDetails(
        {
          type: "session_meta",
          payload: {
            id: "child",
            source: { subagent: { thread_spawn: { parent_thread_id: "parent" } } },
          },
        },
        "child",
      ),
    ).toEqual([{ kind: "subagent", sessionId: "child", parentSessionId: "parent" }]);
    expect(
      sessionDetails(
        { type: "session_meta", payload: { id: "fork", forked_from_id: "parent" } },
        "fork",
      ),
    ).toEqual([]);
  });
  it("keeps reported sizes and leaves missing sizes unknown", () => {
    expect(
      sessionDetails(
        {
          subtype: "compact_boundary",
          timestamp: "2026-11-09T15:00:00Z",
          sessionId: "s",
          compactMetadata: { preTokens: 167000, postTokens: 25000 },
        },
        "",
      )[0],
    ).toMatchObject({
      kind: "compaction",
      sessionId: "s",
      beforeTokens: 167000,
      afterTokens: 25000,
    });
    expect(
      sessionDetails(
        {
          type: "event_msg",
          timestamp: "2026-11-09T15:00:00Z",
          payload: { type: "context_compacted" },
        },
        "s",
      )[0],
    ).toMatchObject({ beforeTokens: null, afterTokens: null });
  });
});
