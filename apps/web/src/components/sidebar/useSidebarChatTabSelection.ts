import { ALL_CHATS_TAB } from "@t3tools/client-runtime/state/chat-tabs";
import * as Schema from "effect/Schema";
import { useCallback, useEffect } from "react";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useAtomValue } from "@effect/atom-react";
import { chatListTabsEnabledAtom } from "../../state/server";

/** Shared by the chat list and the attention roster, which stays mounted in Settings. */
export function useSidebarChatTabSelection() {
  const enabled = useAtomValue(chatListTabsEnabledAtom);
  const [stored, setStored] = useLocalStorage(
    "t3code:sidebar-chat-tab:v1",
    ALL_CHATS_TAB,
    Schema.String,
  );
  useEffect(() => {
    if (enabled === false && stored !== ALL_CHATS_TAB) setStored(ALL_CHATS_TAB);
  }, [enabled, stored, setStored]);
  const select = useCallback(
    (key: string) => {
      if (enabled) setStored(key);
    },
    [enabled, setStored],
  );
  return { enabled: enabled !== false, selected: enabled ? stored : ALL_CHATS_TAB, select };
}
