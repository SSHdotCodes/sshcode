import { CLAUDE_RC_TAB } from "@t3tools/contracts";
import { resolveSelectedChatTab } from "@t3tools/client-runtime/state/chat-tabs";

/** The built-in Terminal chip is not a user tab, so the chat-tab resolver must not drop it. */
export function resolveHomeChatTab(
  stored: string,
  tabs: ReadonlyArray<{ readonly key: string }>,
): string {
  return stored === CLAUDE_RC_TAB ? CLAUDE_RC_TAB : resolveSelectedChatTab(stored, tabs);
}
