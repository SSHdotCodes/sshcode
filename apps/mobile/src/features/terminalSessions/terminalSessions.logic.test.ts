import { CLAUDE_RC_TAB } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { resolveHomeChatTab } from "./terminalSessions.logic";

it("preserves the Terminal chip and still drops an unknown tab", () => {
  expect(resolveHomeChatTab(CLAUDE_RC_TAB, [])).toBe(CLAUDE_RC_TAB);
  expect(resolveHomeChatTab("missing", [{ key: "work" }])).toBe("");
  expect(resolveHomeChatTab("work", [{ key: "work" }])).toBe("work");
});
