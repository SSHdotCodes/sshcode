import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { agentBehaviorLevels, DEFAULT_AGENT_BEHAVIOR, ServerSettings } from "./settings.ts";

describe("agentBehaviorLevels", () => {
  it("reads missing or unknown levels as default", () => {
    assert.deepStrictEqual(agentBehaviorLevels(undefined), DEFAULT_AGENT_BEHAVIOR);
    assert.deepStrictEqual(
      agentBehaviorLevels({ tokens: "high", subagents: "maximum", questions: 3, replies: "short" }),
      { ...DEFAULT_AGENT_BEHAVIOR, tokens: "high", replies: "short" },
    );
  });

  it("decodes settings files written before the field existed", () => {
    const settings = Schema.decodeUnknownSync(ServerSettings)({});
    assert.deepStrictEqual(agentBehaviorLevels(settings.agentBehavior), DEFAULT_AGENT_BEHAVIOR);
  });
});
