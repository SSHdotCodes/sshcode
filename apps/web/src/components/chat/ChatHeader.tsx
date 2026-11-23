import { usePrivacyLabel, usePrivacyMode } from "~/hooks/usePrivacyMode";
import { DiscordMemberList } from "../discord/DiscordMemberList";
import { Dialog, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { CasualVoiceControl } from "../discord/CasualVoiceControl";
import { ComputerUseStatus } from "../computer-use/ComputerUseStatus";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ChevronDownIcon,
  FolderIcon,
  HashIcon,
  UsersIcon,
  SearchIcon,
  ImagesIcon,
  CornerUpLeftIcon,
} from "lucide-react";
import { fileBasename } from "@t3tools/shared/path";
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { useUiMode } from "../../hooks/useTheme";
import { useEnvironment } from "../../state/environments";
import { useThreadShell } from "../../state/entities";
import { requestThreadFindOpen } from "./threadFindActionBus";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import * as Schema from "effect/Schema";
import { useClientSettings } from "../../hooks/useSettings";
import { WorkflowRunCrumb } from "../workflows/WorkflowRunCrumb";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  /** Drafts have no server thread yet, so the title carries no action menu. */
  isServerThread: boolean;
  /** Null for threads without a project, which lead with nothing or their folder. */
  activeProject: EnvironmentProject | null;
  /** The folder a thread without a project was started in, if the user picked one. */
  activeFolderPath?: string | null | undefined;
  parentThreadLink: { threadId: ThreadId; title: string } | null;
  onOpenThread: (threadId: ThreadId) => void;
  rightPanelOpen: boolean;
  membersPanelUnavailable?: boolean;
  /** The side chat's button joins the panel toggles, so the title leaves room for four. */
  sideChatControlShown: boolean;
  /** In a split pane the pane's own controls follow and leave the room for the window's buttons. */
  inSplitPane?: boolean;
  onNewThreadInProject: () => void;
  onOpenMedia?: (() => void) | undefined;
  onOpenProjectSettings?: (() => void) | undefined;
}

/**
 * Rename commit rule shared with the sidebar's inline rename: trim, reject
 * empty (the caller toasts), and skip the mutation when nothing changed.
 */
export function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
  /**
   * The title the field opened with. Leaving it untouched is a no-op even if
   * the live title changed meanwhile (a generated title, or a rename from
   * another device), so blurring the field never writes the old text back.
   */
  readonly startTitle?: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle || trimmed === input.startTitle?.trim()) {
    return { action: "noop" };
  }
  return { action: "commit", title: trimmed };
}

// How long a click on the thread title waits before opening the action menu,
// so a double-click-to-rename can cancel it first. Only the native desktop
// menu needs this: it swallows input while open, so the wait must cover the
// OS double-click interval. The browser fallback menu keeps seeing DOM
// events (the second click dismisses it and dblclick still fires), so it
// opens immediately.
const TITLE_MENU_OPEN_DELAY_MS = 500;
export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  isServerThread,
  activeProject,
  activeFolderPath = null,
  parentThreadLink,
  onOpenThread,
  rightPanelOpen,
  membersPanelUnavailable = false,
  sideChatControlShown,
  inSplitPane = false,
  onNewThreadInProject,
  onOpenMedia,
  onOpenProjectSettings,
}: ChatHeaderProps) {
  const privateLabel = usePrivacyLabel();
  const privacy = usePrivacyMode();
  const displayThreadTitle = privateLabel("Chat", activeThreadId, activeThreadTitle);
  const parentTitle = parentThreadLink
    ? privateLabel("Chat", parentThreadLink.threadId, parentThreadLink.title)
    : "";
  const [uiMode] = useUiMode();
  const environment = useEnvironment(uiMode === "discord" ? activeThreadEnvironmentId : null);
  const headerThread = useThreadShell(
    uiMode === "discord" ? scopeThreadRef(activeThreadEnvironmentId, activeThreadId) : null,
  );
  const [membersOpen, setMembersOpen] = useLocalStorage(
    "t3code:discord:members-open:v1",
    true,
    Schema.Boolean,
  );
  // Matches ChatView: the member list column sits under the window's panel toggles.
  const memberListFits = useMediaQuery("(min-width: 1200px)") && !membersPanelUnavailable;
  const [membersDialogOpen, setMembersDialogOpen] = useState(false);
  const memberListShown = memberListFits && membersOpen;
  const activeProjectName = activeProject
    ? privateLabel("Project", activeProject.id, activeProject.title)
    : undefined;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const interfaceFont = useClientSettings((settings) => settings.fontFamilySans);
  const casualVoice = useClientSettings((settings) => settings.casualVoice);
  const breadcrumbContainerRef = useRef<HTMLDivElement>(null);
  const [collapseParentTitle, setCollapseParentTitle] = useState(false);
  const activeThreadRef = useMemo(
    () => scopeThreadRef(activeThreadEnvironmentId, activeThreadId),
    [activeThreadEnvironmentId, activeThreadId],
  );
  const canOperateThread = useEnvironmentScope(
    activeThreadEnvironmentId,
    AuthOrchestrationOperateScope,
  );
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  // Inline rename, keyed by thread: navigating away drops an in-progress
  // rename instead of committing stale text. Cleared on thread change (not
  // just hidden) so returning to the thread doesn't revive the old draft.
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId ||
      renaming.environmentId !== activeThreadEnvironmentId ||
      !canOperateThread ||
      privacy)
  ) {
    setRenaming(null);
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  // Leaving rename swaps the input back for the title, which needs a fresh fit.
  const isRenamingTitle = renamingTitle !== null;
  useEffect(() => {
    const list = breadcrumbContainerRef.current?.querySelector("ol");
    if (!list || !parentThreadLink) return;
    // Measure the untruncated labels, including a collapsed parent's hidden
    // text, so expanding and collapsing never change the fit calculation.
    // Width-capped labels (the project) never grow, so their overflow is skipped.
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      const width = Array.from(list.children).reduce(
        (total, item) => {
          const label = item.querySelector('[data-slot="workspace-breadcrumb-text"]');
          const ellipsis = item.querySelector("[data-parent-breadcrumb-ellipsis]");
          return (
            total +
            (item.firstElementChild?.getBoundingClientRect().width ?? 0) +
            (label && getComputedStyle(label).maxWidth === "none"
              ? label.scrollWidth - label.clientWidth
              : 0) -
            (ellipsis?.getBoundingClientRect().width ?? 0)
          );
        },
        gap * (list.children.length - 1),
      );
      setCollapseParentTitle(width > list.clientWidth);
    };
    measure();
    const frame = requestAnimationFrame(measure);
    document.fonts.addEventListener("loadingdone", measure);
    const stopObserving = observeResize(list, measure);
    return () => {
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener("loadingdone", measure);
      stopObserving();
    };
  }, [activeProjectName, activeThreadTitle, parentThreadLink, interfaceFont, isRenamingTitle]);
  const renameCommittedRef = useRef(false);
  const startRename = useCallback(() => {
    if (
      privacy ||
      !isServerThread ||
      !readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)
    )
      return;
    renameCommittedRef.current = false;
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  }, [activeThreadEnvironmentId, activeThreadId, activeThreadTitle, isServerThread, privacy]);
  const commitRename = useCallback(
    (title: string) => {
      setRenaming(null);
      if (!readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)) return;
      const resolution = resolveRenameCommit({
        title,
        originalTitle: activeThreadTitle,
        ...(renaming ? { startTitle: renaming.title } : {}),
      });
      if (resolution.action === "reject-empty") {
        toastManager.add({ type: "warning", title: "Chat title cannot be empty" });
        return;
      }
      if (resolution.action === "noop") return;
      void updateThreadMetadata({
        environmentId: activeThreadEnvironmentId,
        input: { threadId: activeThreadId, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to rename chat",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      });
    },
    [activeThreadEnvironmentId, activeThreadId, activeThreadTitle, renaming, updateThreadMetadata],
  );
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    onStartRename: startRename,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = useCallback(() => {
    if (titleMenuTimerRef.current === null) return;
    clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  }, []);
  // Drop a pending menu-open when the thread changes or the header unmounts,
  // so it can never fire for a thread the user already left.
  useEffect(
    () => () => {
      cancelPendingTitleMenu();
    },
    [activeThreadEnvironmentId, activeThreadId, cancelPendingTitleMenu],
  );
  const openTitleMenuNow = useCallback(() => {
    cancelPendingTitleMenu();
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  }, [cancelPendingTitleMenu, openMenu]);
  const openMenuFromTitle = useCallback(
    (event: ReactMouseEvent<HTMLButtonElement>) => {
      // The trailing click of a double-click belongs to rename, not the menu.
      if (isTrailingDoubleClick(event.detail)) return;
      // Keyboard activation and the explicit chevron affordance can never be
      // the first half of a double-click, so they open without waiting.
      const clickedChevron =
        (event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null;
      if (event.detail === 0 || clickedChevron || window.desktopBridge === undefined) {
        openTitleMenuNow();
        return;
      }
      // Stay pending long enough for dblclick to cancel the open before the
      // native menu appears and swallows the second click.
      cancelPendingTitleMenu();
      titleMenuTimerRef.current = window.setTimeout(() => {
        titleMenuTimerRef.current = null;
        openTitleMenuNow();
      }, TITLE_MENU_OPEN_DELAY_MS);
    },
    [cancelPendingTitleMenu, openTitleMenuNow],
  );
  const handleTitleDoubleClick = useCallback(
    (event: ReactMouseEvent) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      // The chevron is the explicit menu affordance; only the title text renames.
      if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
      cancelPendingTitleMenu();
      closeMenu();
      startRename();
    },
    [cancelPendingTitleMenu, closeMenu, startRename],
  );
  const handleHeaderContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (renamingTitle !== null) return;
      if (!isServerThread && onOpenProjectSettings === undefined) return;
      cancelPendingTitleMenu();
      event.preventDefault();
      if (!isServerThread) {
        const api = readLocalApi();
        if (!api) return;
        void api.contextMenu
          .show([{ id: "project-settings", label: "Project settings", icon: "settings" }], {
            x: event.clientX,
            y: event.clientY,
          })
          .then((action) => {
            if (action === "project-settings") onOpenProjectSettings?.();
          });
        return;
      }
      openMenu({ x: event.clientX, y: event.clientY });
    },
    [cancelPendingTitleMenu, isServerThread, onOpenProjectSettings, openMenu, renamingTitle],
  );
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter") {
        renameCommittedRef.current = true;
        commitRename(event.currentTarget.value);
      } else if (event.key === "Escape") {
        renameCommittedRef.current = true;
        setRenaming(null);
      }
    },
    [commitRename],
  );
  if (uiMode === "discord") {
    return (
      <div className="dc-chat-heading" onContextMenu={handleHeaderContextMenu}>
        {parentThreadLink ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="dc-icon-button"
                  aria-label={`Back to ${parentTitle}`}
                  onClick={() => onOpenThread(parentThreadLink.threadId)}
                />
              }
            >
              <CornerUpLeftIcon size={20} />
            </TooltipTrigger>
            <TooltipPopup side="bottom">{parentTitle}</TooltipPopup>
          </Tooltip>
        ) : (
          <HashIcon size={24} />
        )}
        {renamingTitle !== null ? (
          <input
            autoFocus
            aria-label="Chat title"
            defaultValue={renamingTitle}
            onBlur={(event) => {
              if (!renameCommittedRef.current) commitRename(event.currentTarget.value);
            }}
            onKeyDown={handleRenameKeyDown}
            onFocus={(event) => event.currentTarget.select()}
            className="min-w-0 flex-1 bg-transparent outline-none"
          />
        ) : (
          <button
            type="button"
            ref={titleButtonRef}
            className="dc-chat-title"
            onClick={isServerThread ? openMenuFromTitle : undefined}
            onDoubleClick={canOperateThread ? handleTitleDoubleClick : undefined}
            onBlur={cancelPendingTitleMenu}
            aria-label={`Chat actions for ${displayThreadTitle}`}
          >
            <h2>{displayThreadTitle}</h2>
          </button>
        )}
        {activeProject ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="dc-icon-button"
                  aria-label={`New chat in ${activeProjectName}`}
                  onClick={onNewThreadInProject}
                />
              }
            >
              <FolderIcon size={18} />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {privacy ? "Hidden workspace path" : activeProject.workspaceRoot}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {casualVoice ? (
          <CasualVoiceControl environmentId={activeThreadEnvironmentId} threadId={activeThreadId} />
        ) : null}
        <Tooltip>
          <TooltipTrigger render={<span className="dc-chat-topic" />}>
            {[
              environment
                ? privateLabel("Computer", environment.environmentId, environment.label)
                : null,
              privacy ? null : headerThread?.branch,
              headerThread?.modelSelection.model,
            ]
              .filter(Boolean)
              .join(" · ")}
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {privacy
              ? "Details hidden"
              : (activeFolderPath ?? activeProjectCwd ?? environment?.label ?? "Chat")}
          </TooltipPopup>
        </Tooltip>
        <span
          className="dc-header-actions"
          style={{
            marginRight: rightPanelOpen
              ? 40
              : memberListShown
                ? 8
                : sideChatControlShown
                  ? 128
                  : 96,
          }}
        >
          <ComputerUseStatus
            discord
            environmentId={activeThreadEnvironmentId}
            threadId={activeThreadId}
          />
          {onOpenMedia ? (
            <button
              type="button"
              className="dc-icon-button [-webkit-app-region:no-drag]"
              aria-label="Media"
              onClick={onOpenMedia}
            >
              <ImagesIcon size={20} />
            </button>
          ) : null}
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="dc-icon-button"
                  aria-label="Find in chat"
                  onClick={() => requestThreadFindOpen()}
                />
              }
            >
              <SearchIcon size={20} />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Find in chat</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="dc-icon-button dc-members-toggle"
                  aria-label="Toggle member list"
                  aria-pressed={memberListFits ? membersOpen : membersDialogOpen}
                  onClick={() =>
                    memberListFits ? setMembersOpen(!membersOpen) : setMembersDialogOpen(true)
                  }
                />
              }
            >
              <UsersIcon size={22} />
            </TooltipTrigger>
            <TooltipPopup side="bottom">Member list</TooltipPopup>
          </Tooltip>
        </span>
        {!memberListFits && membersDialogOpen ? (
          <Dialog open onOpenChange={setMembersDialogOpen}>
            <DialogPopup className="max-w-sm">
              <DialogHeader>
                <DialogTitle>Members</DialogTitle>
              </DialogHeader>
              <DiscordMemberList
                dialog
                threadRef={activeThreadRef}
                onOpenThread={(ref) => {
                  setMembersDialogOpen(false);
                  onOpenThread(ref.threadId);
                }}
              />
            </DialogPopup>
          </Dialog>
        ) : null}
      </div>
    );
  }
  return (
    <div
      ref={breadcrumbContainerRef}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        rightPanelOpen ? "pr-10" : inSplitPane ? "pr-2" : sideChatControlShown ? "pr-32" : "pr-24",
      )}
      onContextMenu={handleHeaderContextMenu}
    >
      <WorkspaceBreadcrumb
        ariaLabel="Chat breadcrumb"
        className="flex-1 overflow-clip [overflow-clip-margin:2px]"
      >
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProject ? (
          <>
            <WorkspaceBreadcrumbItem className="shrink">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`New chat in ${activeProjectName}`}
                      onClick={onNewThreadInProject}
                      className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  }
                >
                  <ProjectFavicon project={activeProject} className="size-3.5" />
                  <WorkspaceBreadcrumbText className="max-w-40">
                    {activeProjectName}
                  </WorkspaceBreadcrumbText>
                </TooltipTrigger>
                <TooltipPopup side="top">New chat in {activeProjectName}</TooltipPopup>
              </Tooltip>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbSeparator>
          </>
        ) : activeFolderPath ? (
          <>
            <WorkspaceBreadcrumbItem className="shrink">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-muted-foreground" />
                  }
                >
                  <FolderIcon aria-hidden className="size-3.5 shrink-0" />
                  <WorkspaceBreadcrumbText className="max-w-40">
                    {privateLabel("Folder", activeFolderPath, fileBasename(activeFolderPath))}
                  </WorkspaceBreadcrumbText>
                </TooltipTrigger>
                <TooltipPopup side="top">
                  {privacy ? "Hidden workspace path" : activeFolderPath}
                </TooltipPopup>
              </Tooltip>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbSeparator>
          </>
        ) : null}
        <WorkflowRunCrumb environmentId={activeThreadEnvironmentId} threadId={activeThreadId} />
        {parentThreadLink ? (
          <>
            <WorkspaceBreadcrumbItem>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`Open parent chat: ${parentTitle}`}
                      onClick={() => onOpenThread(parentThreadLink.threadId)}
                      className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                    />
                  }
                >
                  <WorkspaceBreadcrumbText
                    aria-hidden
                    className={collapseParentTitle ? "w-0" : undefined}
                  >
                    {parentTitle}
                  </WorkspaceBreadcrumbText>
                  {collapseParentTitle ? (
                    <span aria-hidden data-parent-breadcrumb-ellipsis>
                      ...
                    </span>
                  ) : null}
                </TooltipTrigger>
                <TooltipPopup side="top">{parentTitle}</TooltipPopup>
              </Tooltip>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbSeparator>
          </>
        ) : null}
        <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
          {renamingTitle !== null ? (
            <input
              autoFocus
              aria-label="Chat title"
              className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-inset ring-ring/50 focus:ring-ring"
              defaultValue={renamingTitle}
              onBlur={(event) => {
                if (renameCommittedRef.current) return;
                // Focus landing on a navigation button means the rename was
                // abandoned — discard it rather than persisting a half-draft.
                if (
                  event.relatedTarget instanceof HTMLElement &&
                  event.relatedTarget.closest("button")
                ) {
                  setRenaming(null);
                  return;
                }
                commitRename(event.currentTarget.value);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleRenameKeyDown}
            />
          ) : isServerThread ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    ref={titleButtonRef}
                    type="button"
                    aria-label={`Chat actions for ${displayThreadTitle}`}
                    aria-haspopup="menu"
                    onClick={openMenuFromTitle}
                    onDoubleClick={canOperateThread ? handleTitleDoubleClick : undefined}
                    onBlur={cancelPendingTitleMenu}
                    className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  />
                }
              >
                <h2 className="min-w-0">
                  <WorkspaceBreadcrumbText>{displayThreadTitle}</WorkspaceBreadcrumbText>
                </h2>
                <ChevronDownIcon
                  aria-hidden
                  data-thread-title-chevron
                  className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{displayThreadTitle}</TooltipPopup>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={<h2 aria-label={displayThreadTitle} className="min-w-0 flex-1" />}
              >
                <WorkspaceBreadcrumbText>{displayThreadTitle}</WorkspaceBreadcrumbText>
              </TooltipTrigger>
              <TooltipPopup side="top">{displayThreadTitle}</TooltipPopup>
            </Tooltip>
          )}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {casualVoice ? (
        <CasualVoiceControl
          plain
          environmentId={activeThreadEnvironmentId}
          threadId={activeThreadId}
        />
      ) : null}
      <ComputerUseStatus environmentId={activeThreadEnvironmentId} threadId={activeThreadId} />
      {onOpenMedia ? (
        <span className="[-webkit-app-region:no-drag]">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Media"
            title="Media"
            onClick={onOpenMedia}
          >
            <ImagesIcon />
          </Button>
        </span>
      ) : null}
    </div>
  );
});
