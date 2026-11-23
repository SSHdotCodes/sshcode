import {
  compareSessionBoxes,
  presentSessionBoxCached,
  sessionBoxFacesFor,
  sessionBoxSiblingShare,
  type SessionBoxPresentation,
} from "@t3tools/client-runtime/state/session-boxes";
import { harnessMascotIdentity } from "@t3tools/shared/harnessThemes";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { harnessMascotAgentId } from "@t3tools/shared/harnessMascots";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  belongsInSidebarSettledShelf,
  filterSidebarV2VisibleThreads,
  hasUnseenCompletion,
  resolveThreadLastVisitedAt,
} from "../components/Sidebar.logic";
import { NewChatBackdrop } from "../components/chat/NewChatDashboard";
import { SessionBox } from "../components/sessionBoxes/SessionBox";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useNowMinute } from "../hooks/useNowMinute";
import { useClientSettings } from "../hooks/useSettings";
import { useServerConfigs, useThreadShells } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { buildThreadRouteParams } from "../threadRoutes";
import { useUiStateStore } from "../uiStateStore";
import {
  useHiddenWorkflowChatKeys,
  withoutWorkflowRunChats,
} from "../components/workflows/WorkflowRunChatsTracker";

type BoardGroup = "needsYou" | "working" | "recent" | "settled";

const GROUP_LABELS: Record<BoardGroup, string> = {
  needsYou: "Needs you",
  working: "Working",
  recent: "Recent",
  settled: "Settled",
};

const SETTLED_PAGE = 24;

interface BoardEntry {
  readonly thread: EnvironmentThreadShell;
  readonly box: SessionBoxPresentation;
  readonly updatedAt: string;
}

/**
 * Every chat as a box on one screen: what needs you first, then what is working, then
 * the rest, each ranked by the needs-you model. Snoozed chats stay off the board.
 */
function BoardPage() {
  const router = useRouter();
  const nowMinute = useNowMinute();
  const allThreads = useThreadShells();
  const hiddenWorkflowChats = useHiddenWorkflowChatKeys();
  const serverConfigs = useServerConfigs();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const lastVisitedById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const [settledShown, setSettledShown] = useState(SETTLED_PAGE);
  const chatBackdropEnabled = useClientSettings((settings) => settings.chatBackdropEnabled);

  const labelById = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const groups = useMemo(() => {
    const now = Date.parse(`${nowMinute}:00.000Z`);
    const preciseNow = new Date(now).toISOString();
    const visible = filterSidebarV2VisibleThreads(
      withoutWorkflowRunChats(allThreads, hiddenWorkflowChats),
      null,
    );
    const siblingShare = sessionBoxSiblingShare(visible.map((thread) => thread.title));
    const faces = sessionBoxFacesFor(visible);
    const result: Record<BoardGroup, BoardEntry[]> = {
      needsYou: [],
      working: [],
      recent: [],
      settled: [],
    };
    for (const thread of visible) {
      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      if (capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now: preciseNow })) {
        continue;
      }
      const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
      const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, lastVisitedById[key]);
      const box = presentSessionBoxCached(thread, {
        now,
        siblingShare,
        face: faces.get(thread.id),
        unseen: hasUnseenCompletion({ ...thread, lastVisitedAt }),
      });
      const group: BoardGroup = belongsInSidebarSettledShelf(
        thread,
        capabilities?.threadSettlement === true,
      )
        ? "settled"
        : box.tone === "asking"
          ? "needsYou"
          : box.tone === "working"
            ? "working"
            : "recent";
      result[group].push({ thread, box, updatedAt: thread.updatedAt });
    }
    for (const entries of Object.values(result)) entries.sort(compareSessionBoxes);
    return result;
  }, [allThreads, hiddenWorkflowChats, lastVisitedById, nowMinute, serverConfigs]);

  const providerFor = (thread: EnvironmentThreadShell) => {
    const instanceId = thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId;
    return (
      serverConfigs
        .get(thread.environmentId)
        ?.providers.find((provider) => provider.instanceId === instanceId) ?? null
    );
  };
  const total = groups.needsYou.length + groups.working.length + groups.recent.length;

  return (
    <SidebarInset className="relative h-dvh min-h-0 overflow-hidden">
      {/* The same dimmed arc as behind conversations, where the boxes leave the page empty. */}
      {chatBackdropEnabled ? <NewChatBackdrop docked /> : null}
      <WorkspacePageHeader electron={isElectron} className="relative">
        <LayoutGridIcon className="size-4 text-muted-foreground" />
        <h1 className="text-sm font-medium">Board</h1>
        <span className="text-xs text-muted-foreground">
          {groups.needsYou.length > 0
            ? `${groups.needsYou.length} need you · ${groups.working.length} working`
            : `${groups.working.length} working · ${total} chats`}
        </span>
      </WorkspacePageHeader>
      <div className="relative min-h-0 flex-1 overflow-y-auto px-5 pt-3 pb-10">
        {(["needsYou", "working", "recent", "settled"] as const).map((group) => {
          const entries =
            group === "settled" ? groups.settled.slice(0, settledShown) : groups[group];
          if (entries.length === 0) return null;
          return (
            <section key={group} className="mb-6">
              <h2 className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
                {GROUP_LABELS[group]}
                <span className="ml-1.5 font-normal opacity-70">{groups[group].length}</span>
              </h2>
              <ul className="grid grid-cols-[repeat(auto-fill,minmax(118px,1fr))] gap-2.5">
                {entries.map(({ thread, box }) => {
                  const ref = scopeThreadRef(thread.environmentId, thread.id);
                  const provider = providerFor(thread);
                  return (
                    <li key={scopedThreadKey(ref)} className="list-none">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label={thread.title}
                              className="group/sidebar-row block w-full cursor-pointer rounded-xl text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                              onClick={() =>
                                void router.navigate({
                                  to: "/$environmentId/$threadId",
                                  params: buildThreadRouteParams(ref),
                                })
                              }
                            >
                              <SessionBox
                                box={box}
                                {...harnessMascotIdentity({
                                  driver: provider?.driver ?? null,
                                  instanceId: provider?.instanceId ?? null,
                                  model: thread.modelSelection.model,
                                  agentId: harnessMascotAgentId(
                                    provider?.driver,
                                    provider
                                      ? serverConfigs.get(thread.environmentId)?.settings
                                          .providerInstances[provider.instanceId]?.config
                                      : null,
                                  ),
                                })}
                                isActive={false}
                                isSelected={false}
                                isPinned={thread.pinnedAt !== null}
                                machineLabel={
                                  thread.environmentId === primaryEnvironmentId
                                    ? null
                                    : (labelById.get(thread.environmentId) ?? null)
                                }
                                size="board"
                              />
                            </button>
                          }
                        />
                        <TooltipPopup side="bottom">{thread.title}</TooltipPopup>
                      </Tooltip>
                    </li>
                  );
                })}
              </ul>
              {group === "settled" && groups.settled.length > settledShown ? (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2"
                  onClick={() => setSettledShown((count) => count + SETTLED_PAGE)}
                >
                  Show more
                </Button>
              ) : null}
            </section>
          );
        })}
        {total + groups.settled.length === 0 ? (
          <p className="py-16 text-center text-sm text-muted-foreground">No chats yet</p>
        ) : null}
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/board")({ component: BoardPage });
