import { describe, expect, it } from "vite-plus/test";

import { dropInheritedAgentSessionMarkers } from "./agentSessionMarkers.ts";

describe("dropInheritedAgentSessionMarkers", () => {
  it("removes an agent's child-session markers and keeps the user's Claude settings", () => {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      CLAUDECODE: "1",
      CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_ENTRYPOINT: "sdk-ts",
      CLAUDE_CODE_SESSION_ID: "session",
      CLAUDE_CONFIG_DIR: "/Users/me/.claude-work",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
    };
    dropInheritedAgentSessionMarkers(env);
    expect(env).toEqual({
      PATH: "/usr/bin",
      CLAUDE_CONFIG_DIR: "/Users/me/.claude-work",
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "64000",
    });
  });
});
