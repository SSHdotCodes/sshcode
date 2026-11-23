import { useEffect, useMemo } from "react";
import * as Schema from "effect/Schema";
import {
  ALL_CHATS_TAB,
  buildChatTabs,
  chatTabShowsThread,
  resolveSelectedChatTab,
} from "@t3tools/client-runtime/state/chat-tabs";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useUiMode } from "../hooks/useTheme";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useThreadShells } from "../state/entities";
import { useEnvironments } from "../state/environments";
import { useUiStateStore } from "../uiStateStore";
import { filterSidebarV2VisibleThreads } from "./Sidebar.logic";
import {
  useHiddenWorkflowChatKeys,
  withoutWorkflowRunChats,
} from "./workflows/WorkflowRunChatsTracker";
import { sidebarAttentionSourceAtom } from "./Sidebar.attention";

/** Lives beside the shell controls, outside the narrow sidebar's unmounting sheet. */
export function SidebarAttentionSource() {
  const allThreads = useThreadShells();
  const { environments } = useEnvironments();
  const [uiMode] = useUiMode();
  const discordMode = uiMode === "discord";
  const [machineSelection] = useLocalStorage(
    "t3code:sidebar:machine-filter:v1",
    "all",
    Schema.String,
  );
  const [chatTabSelection] = useLocalStorage(
    "t3code:sidebar-chat-tab:v1",
    ALL_CHATS_TAB,
    Schema.String,
  );
  const visits = useUiStateStore((state) => state.threadLastVisitedAtById);
  const hiddenWorkflowChats = useHiddenWorkflowChatKeys();
  const threads = useMemo(() => {
    const homeThreads = withoutWorkflowRunChats(allThreads, hiddenWorkflowChats);
    const tabs = buildChatTabs(filterSidebarV2VisibleThreads(homeThreads, null), {
      threadKey: (thread) => `${thread.environmentId}:${thread.id}`,
      status: () => null,
    });
    const selectedTab = resolveSelectedChatTab(chatTabSelection, tabs);
    const selectedMachine = environments.some((env) => env.environmentId === machineSelection)
      ? machineSelection
      : "all";
    // Subagents stay out of the roster in both modes, as the sidebar keeps them.
    return filterSidebarV2VisibleThreads(homeThreads, null).filter((thread) => {
      const key = `${thread.environmentId}:${thread.id}`;
      return (
        chatTabShowsThread(selectedTab, tabs, key) &&
        (selectedMachine === "all" || thread.environmentId === selectedMachine)
      );
    });
  }, [allThreads, environments, machineSelection, chatTabSelection, hiddenWorkflowChats]);
  useEffect(() => {
    appAtomRegistry.set(sidebarAttentionSourceAtom, { threads, visits, discordMode });
  }, [threads, visits, discordMode]);
  return null;
}
