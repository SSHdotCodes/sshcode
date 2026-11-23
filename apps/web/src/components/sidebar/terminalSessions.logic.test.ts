import { CLAUDE_RC_TAB } from "@t3tools/contracts";
import {
  chatTabShowsThread,
  resolveSelectedChatTab,
} from "@t3tools/client-runtime/state/chat-tabs";
import { expect, it } from "vite-plus/test";

it("keeps the built-in Terminal key out of the normal chat tabs", () => {
  expect(chatTabShowsThread(CLAUDE_RC_TAB, [], "any-chat")).toBe(false);
  expect(resolveSelectedChatTab(CLAUDE_RC_TAB, [])).toBe("");
});
