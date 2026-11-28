import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  teamBoardRepoLatestPostId,
  formatTeamBoardMembers,
  formatTeamBoardPushTime,
  formatTeamBoardRanges,
  formatTeamBoardTime,
  parseTeamBoardDraft,
  sameTeamBoardRow,
  TEAM_BOARD_FILTERS,
  TEAM_BOARD_MESSAGE_MAX,
  teamBoardAuthorKey,
  teamBoardDraftError,
  teamBoardAddressee,
  teamBoardAuthorLine,
  teamBoardHoldsLabel,
  teamBoardAddressedMember,
  teamBoardRoster,
  type TeamBoardMember,
  type TeamBoardMemberState,
  type TeamBoardRosterChip,
  teamBoardAuthorsFromKey,
  teamBoardAuthorsKey,
  type TeamBoardAuthors,
  teamBoardFileLabel,
  teamBoardFiles,
  teamBoardKind,
  teamBoardOverlapLabel,
  type TeamBoardFilter,
  type TeamBoardKindTone,
  teamBoardPill,
  teamBoardPillLabel,
  type TeamBoardRow,
  teamBoardRows,
} from "@t3tools/client-runtime/state/team-board";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import { useNavigate } from "@tanstack/react-router";
import {
  ThreadId,
  type NodeId,
  type ScopedThreadRef,
  type ServerProvider,
  type TeamBoardFile,
  type TeamBoardPost,
  type TeamBoardPush,
  type TeamBoardSnapshot,
} from "@t3tools/contracts";
import {
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CrownIcon,
  MessagesSquareIcon,
  PinIcon,
  ReplyIcon,
  UserRoundIcon,
  XIcon,
} from "lucide-react";
import {
  createContext,
  type KeyboardEvent,
  memo,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";

import { cn, randomUUID } from "~/lib/utils";
import {
  showTeamBoardPill,
  teamBoardEnvironment,
  teamBoardOpenAtom,
  type TeamBoardView,
} from "../../state/teamBoard";
import { useServerConfigs } from "../../state/entities";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Spinner } from "../ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";
import { SubagentAvatar } from "./SubagentCard";

type Subagents = ReadonlyArray<TeamBoardMember>;
type Drivers = TeamBoardAuthors;
const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/** Authors as the chat's subagent rows show them; the map changes only when one does. */
function useAuthorDrivers(subagents: Subagents): Drivers {
  const key = teamBoardAuthorsKey(subagents);
  return useMemo(() => teamBoardAuthorsFromKey(key), [key]);
}

/** The lead chat's providers, and how a post opens its author's chat. */
const BoardPeople = createContext<{
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly members: ReadonlyArray<TeamBoardMember>;
  readonly onOpen: ((threadId: string) => void) | null;
}>({ providers: EMPTY_PROVIDERS, members: [], onOpen: null });

function useAuthorLine(author: TeamBoardPost["author"], drivers: Drivers) {
  const { providers } = use(BoardPeople);
  const info = author.taskId === undefined ? undefined : drivers.get(author.taskId);
  const provider = providers.find((entry) => entry.instanceId === info?.providerInstanceId);
  const modelLabel =
    info === undefined
      ? null
      : resolveSubagentMetadata({
          model: info.model,
          modelOptions: info.modelOptions,
          provider,
        }).modelLabel;
  return { ...teamBoardAuthorLine(author, info, modelLabel), info, provider };
}

/** "Team board · 6 posts · 1 overlap" above the lead's composer, beside live progress. */
export function TeamBoardPill(props: { readonly threadRef: ScopedThreadRef }) {
  const ref = props.threadRef;
  const summary = useAtomValue(teamBoardEnvironment.summaryAtom(ref));
  const seen = useAtomValue(teamBoardEnvironment.seenAtom(ref));
  const key = threadKey(ref);
  const openAtom = teamBoardOpenAtom(key);
  const open = useAtomValue(openAtom);
  const setOpen = useAtomSet(openAtom);
  // The pill moves between the dock's start and end; the popover stays over the chat column.
  const [column, setColumn] = useState<Element | null>(null);
  const pill = teamBoardPill(summary, seen);
  const shown = pill !== null;
  useEffect(() => (shown ? showTeamBoardPill(key) : undefined), [shown, key]);
  if (pill === null) return null;
  const label = teamBoardPillLabel(pill);
  const popoverOpen = open?.from === "pill";
  return (
    <Popover
      open={popoverOpen}
      onOpenChange={(next) =>
        setOpen(next ? { view: { kind: "live", taskId: null }, from: "pill" } : null)
      }
    >
      <ComposerBanner.Root
        density="comfortable"
        width="content"
        data-composer-shoulder-tab
        data-team-board-pill="true"
        ref={(element: HTMLDivElement | null) =>
          setColumn(element?.closest("[data-chat-canvas]") ?? null)
        }
      >
        <PopoverTrigger
          render={<ComposerBanner.Row render={<button type="button" />} />}
          aria-label={["Team board", label.posts, label.overlaps, pill.unread ? "new posts" : null]
            .filter(Boolean)
            .join(", ")}
          className={cn(
            "transition-colors duration-200",
            popoverOpen ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <ComposerBanner.Icon>
            <span className="relative inline-flex">
              <MessagesSquareIcon />
              {pill.unread ? (
                <span
                  aria-hidden
                  data-team-board-unread="true"
                  className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary ring-2 ring-background"
                />
              ) : null}
            </span>
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="whitespace-nowrap">
              <span className="text-foreground">Team board</span>
              <span aria-hidden className="text-muted-foreground/60">
                {" · "}
              </span>
              <span className="tabular-nums">{label.posts}</span>
              {label.overlaps ? (
                <>
                  <span aria-hidden className="text-muted-foreground/60">
                    {" · "}
                  </span>
                  <span className="text-warning-foreground tabular-nums">{label.overlaps}</span>
                </>
              ) : null}
            </span>
          </ComposerBanner.Content>
        </PopoverTrigger>
      </ComposerBanner.Root>
      <PopoverPopup
        side="top"
        align="end"
        sideOffset={8}
        {...(column ? { collisionBoundary: column } : {})}
        padding="none"
        className="w-[420px] max-w-[calc(100vw-2rem)]"
      >
        {popoverOpen && open.view.kind === "live" ? (
          <TeamBoardPanel
            threadRef={ref}
            push={null}
            taskId={open.view.taskId}
            onTaskChange={(taskId) => setOpen({ view: { kind: "live", taskId }, from: "pill" })}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/** The header menu's past pushes, and the live board for cards when no pill shows. */
export function TeamBoardDialog(props: { readonly threadRef: ScopedThreadRef }) {
  const openAtom = teamBoardOpenAtom(threadKey(props.threadRef));
  const open = useAtomValue(openAtom);
  const setOpen = useAtomSet(openAtom);
  const shown = open?.from === "elsewhere";
  const show = (view: TeamBoardView) => setOpen({ view, from: "elsewhere" });
  const view = shown ? open.view : null;
  return (
    <Dialog open={shown} onOpenChange={(next) => (next ? null : setOpen(null))}>
      <DialogPopup showCloseButton={false} className="w-[420px] max-w-[calc(100vw-2rem)]">
        <DialogTitle className="sr-only">Team board</DialogTitle>
        {view?.kind === "history" ? (
          <TeamBoardHistoryPanel
            threadRef={props.threadRef}
            onOpenPush={(push) => show({ kind: "push", push, taskId: null })}
            onClose={() => setOpen(null)}
          />
        ) : view?.kind === "push" ? (
          <TeamBoardPanel
            threadRef={props.threadRef}
            push={view.push}
            taskId={view.taskId}
            onTaskChange={(taskId) => show({ ...view, taskId })}
            onBack={() => show({ kind: "history" })}
            onClose={() => setOpen(null)}
          />
        ) : view?.kind === "live" ? (
          <TeamBoardPanel
            threadRef={props.threadRef}
            push={null}
            taskId={view.taskId}
            onTaskChange={(taskId) => show({ kind: "live", taskId })}
            onClose={() => setOpen(null)}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

/** Past pushes, newest first: when each ran and who was on the team. */
function TeamBoardHistoryPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly onOpenPush: (push: TeamBoardPush) => void;
  readonly onClose: () => void;
}) {
  const historyAtom = teamBoardEnvironment.historyListAtom(props.threadRef);
  const history = useAtomValue(historyAtom);
  const loadOlder = useAtomSet(historyAtom);
  const pushes = history.pushes;
  return (
    <div className="flex max-h-[calc(60vh-2px)] min-h-0 flex-col" data-team-board-history="true">
      <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
        <MessagesSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-sm font-medium text-foreground">Team board</span>
        <span className="shrink-0 text-2xs text-muted-foreground">Past pushes · read-only</span>
        <span className="flex-1" />
        <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={props.onClose}>
          <XIcon />
        </Button>
      </div>
      {pushes.length === 0 && !history.loading ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">No past pushes.</p>
      ) : (
        <ol className="min-h-0 flex-1 divide-y divide-border/40 overflow-y-auto overscroll-contain">
          {pushes.map((push) => (
            <li key={push.id}>
              <button
                type="button"
                data-team-board-push={push.id}
                onClick={() => props.onOpenPush(push)}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors duration-120 hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none motion-reduce:transition-none"
              >
                <span className="min-w-0 flex-1 space-y-0.5">
                  <span className="block truncate text-sm text-foreground">
                    {formatTeamBoardMembers(push.members)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground tabular-nums">
                    {formatTeamBoardPushTime(push)}
                  </span>
                </span>
                <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
          {history.loading ? (
            <li className="flex items-center gap-2 px-3 py-2.5 text-xs text-muted-foreground">
              <Spinner size="sm" tone="muted" />
              Loading older pushes…
            </li>
          ) : history.olderCursor !== null ? (
            <li className="px-1.5 py-1">
              <Button
                size="sm"
                variant="ghost"
                className="w-full"
                data-team-board-older="true"
                onClick={() => {
                  if (history.olderCursor !== null) loadOlder(history.olderCursor);
                }}
              >
                Older pushes
              </Button>
            </li>
          ) : null}
        </ol>
      )}
    </div>
  );
}

/** "Team board · sshcode ▾": which live repository's board shows, with two or more live. */
function RepoPicker(props: { readonly threadRef: ScopedThreadRef }) {
  const choice = useAtomValue(teamBoardEnvironment.repoChoiceAtom(props.threadRef));
  const pick = useAtomSet(teamBoardEnvironment.pickedRepoAtom(props.threadRef));
  if (choice === null) {
    return (
      <span className="min-w-0 shrink-0 truncate text-sm font-medium text-foreground">
        Team board
      </span>
    );
  }
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="xs"
            variant="ghost"
            data-team-board-repo-picker="true"
            aria-label={`Team board for ${choice.chosen.name}. Choose a repository.`}
          />
        }
      >
        <span className="font-medium text-foreground">Team board</span>
        <span aria-hidden className="text-muted-foreground/60">
          ·
        </span>
        <span className="min-w-0 truncate">{choice.chosen.name}</span>
        <ChevronDownIcon aria-hidden />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuRadioGroup value={choice.chosen.id} onValueChange={(value) => pick(String(value))}>
          {choice.repos.map((repo) => (
            <MenuRadioItem key={repo.id} value={repo.id} closeOnClick>
              {repo.name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
}

/** The live push's board, or a past push's (`push`), which is read-only and never marks read. */
function TeamBoardPanel(props: {
  readonly threadRef: ScopedThreadRef;
  readonly push: TeamBoardPush | null;
  readonly taskId: NodeId | null;
  readonly onTaskChange: (taskId: NodeId | null) => void;
  readonly onBack?: () => void;
  readonly onClose?: () => void;
}) {
  const ref = props.threadRef;
  const live = props.push === null;
  const details = useAtomValue(
    props.push === null
      ? teamBoardEnvironment.detailsAtom(ref)
      : teamBoardEnvironment.pushAtom(ref, props.push.id),
  );
  const setSeen = useAtomSet(teamBoardEnvironment.seenAtom(ref));
  // The chat's task records, or the QA fixture's stand-ins.
  const subagents = useAtomValue(teamBoardEnvironment.membersAtom(ref));
  const drivers = useAuthorDrivers(subagents);
  const providers = useServerConfigs().get(ref.environmentId)?.providers ?? EMPTY_PROVIDERS;
  const navigate = useNavigate();
  const setBoardOpen = useAtomSet(teamBoardOpenAtom(threadKey(ref)));
  // A post opens its author's chat the way the subagent's row in the lead chat does.
  const people = useMemo(
    () => ({
      providers,
      members: subagents,
      onOpen: (threadId: string) => {
        setBoardOpen(null);
        void navigate({
          to: "/$environmentId/$threadId",
          params: buildThreadRouteParams(
            scopeThreadRef(ref.environmentId, ThreadId.make(threadId)),
          ),
        });
      },
    }),
    [navigate, providers, ref.environmentId, setBoardOpen, subagents],
  );
  const [tab, setTab] = useState<"posts" | "files">("posts");
  const [filter, setFilter] = useState<TeamBoardFilter>("all");
  const summary = useAtomValue(teamBoardEnvironment.summaryAtom(ref));
  const choice = useAtomValue(teamBoardEnvironment.repoChoiceAtom(ref));
  const repo = live ? (choice?.chosen.id ?? null) : null;
  // A reply belongs to the repository it was picked in.
  const [replyState, setReplyState] = useState<{
    readonly repo: string | null;
    readonly post: TeamBoardPost;
  } | null>(null);
  const replyTo = replyState?.repo === repo ? replyState.post : null;
  const setReplyTo = useCallback(
    (post: TeamBoardPost | null) => setReplyState(post === null ? null : { repo, post }),
    [repo],
  );
  // Reading a repository marks only its newest post seen; the dot stays while another has news.
  const latestPostId = live ? teamBoardRepoLatestPostId(summary, repo) : undefined;
  // Reading the live board marks it read on this machine, including posts that land while open.
  useEffect(() => {
    if (latestPostId !== undefined) setSeen({ latestPostId, repo });
  }, [latestPostId, repo, setSeen]);
  const agent =
    props.taskId === null ? null : (subagents.find((entry) => entry.id === props.taskId) ?? null);
  const agentName =
    props.taskId === null
      ? null
      : agent?.title?.trim() ||
        details?.posts?.find((post) => post.author.taskId === props.taskId)?.author.name ||
        "Subagent";
  const canPost = useAtomValue(teamBoardEnvironment.permissionAtom(ref.environmentId));
  const writable = live && details?.active === true;
  const roster = teamBoardRoster(subagents, details);
  const holds = useAtomValue(teamBoardEnvironment.holdsAtom(ref));
  return (
    <BoardPeople value={people}>
      <div className="flex max-h-[calc(60vh-2px)] min-h-0 flex-col" data-team-board-panel="true">
        <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
          {props.onBack ? (
            <Button size="icon-xs" variant="ghost" aria-label="Past pushes" onClick={props.onBack}>
              <ChevronLeftIcon />
            </Button>
          ) : (
            <MessagesSquareIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          )}
          {live ? (
            <RepoPicker threadRef={ref} />
          ) : (
            <span className="min-w-0 shrink-0 truncate text-sm font-medium text-foreground">
              Team board
            </span>
          )}
          {props.push === null && details !== null && !details.active ? (
            <span className="shrink-0 text-2xs text-muted-foreground">Ended · read-only</span>
          ) : null}
          <span className="flex-1" />
          <ToggleGroup
            aria-label="Board view"
            value={[tab]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === "posts" || next === "files") setTab(next);
            }}
          >
            <ToggleGroupItem value="posts">Posts</ToggleGroupItem>
            <ToggleGroupItem value="files">Files</ToggleGroupItem>
          </ToggleGroup>
          {props.onClose ? (
            <Button size="icon-xs" variant="ghost" aria-label="Close" onClick={props.onClose}>
              <XIcon />
            </Button>
          ) : null}
        </div>
        {props.push !== null ? <PushMetadata push={props.push} /> : null}
        <RosterRow
          holds={holds}
          roster={roster}
          selected={props.taskId}
          drivers={drivers}
          onSelect={props.onTaskChange}
        />
        {details === null ? (
          <div className="flex items-center gap-2 px-3 py-6 text-xs text-muted-foreground">
            <Spinner size="sm" tone="muted" />
            Loading the board…
          </div>
        ) : tab === "posts" ? (
          <PostsTab
            snapshot={details}
            filter={filter}
            onFilterChange={setFilter}
            taskId={props.taskId}
            agentName={agentName}
            drivers={drivers}
            onReply={writable && canPost ? setReplyTo : null}
          />
        ) : (
          <FilesTab
            files={teamBoardFiles(details.files ?? [], props.taskId)}
            agentName={agentName}
            drivers={drivers}
          />
        )}
        {writable ? (
          <TeamBoardComposer
            threadRef={ref}
            repo={repo}
            canPost={canPost}
            replyTo={replyTo}
            onClearReply={() => setReplyTo(null)}
            drivers={drivers}
          />
        ) : null}
      </div>
    </BoardPeople>
  );
}

/** When a past push ran and who was on it; the team gives way before the time does. */
function PushMetadata(props: { readonly push: TeamBoardPush }) {
  return (
    <p
      data-team-board-push-meta="true"
      className="flex min-w-0 items-center gap-1 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground"
    >
      <span className="shrink-0 tabular-nums">{formatTeamBoardPushTime(props.push)}</span>
      <span aria-hidden className="shrink-0 text-muted-foreground/60">
        ·
      </span>
      <span className="min-w-0 truncate">{formatTeamBoardMembers(props.push.members)}</span>
      <span aria-hidden className="shrink-0 text-muted-foreground/60">
        ·
      </span>
      <span className="shrink-0">read-only</span>
    </p>
  );
}

function PostsTab(props: {
  readonly snapshot: TeamBoardSnapshot;
  readonly filter: TeamBoardFilter;
  readonly onFilterChange: (filter: TeamBoardFilter) => void;
  readonly taskId: NodeId | null;
  readonly agentName: string | null;
  readonly drivers: Drivers;
  readonly onReply: ((post: TeamBoardPost) => void) | null;
}) {
  const rows = teamBoardRows(props.snapshot.posts ?? [], {
    filter: props.filter,
    taskId: props.taskId,
    ...(props.agentName === null ? {} : { memberName: props.agentName }),
  });
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (postId: string) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(postId)) next.add(postId);
        return next;
      }),
    [],
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <div className="sticky top-0 z-10 border-b border-border/40 bg-popover/95 px-2 py-1.5 backdrop-blur-sm">
        <ToggleGroup
          aria-label="Filter posts"
          variant="pill"
          size="segmented"
          value={[props.filter]}
          onValueChange={(value) => {
            const next = TEAM_BOARD_FILTERS.find((entry) => entry.id === value[0]);
            if (next) props.onFilterChange(next.id);
          }}
        >
          {TEAM_BOARD_FILTERS.map((entry) => (
            <ToggleGroupItem key={entry.id} value={entry.id}>
              {entry.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>
      {rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
          {props.agentName !== null && props.filter === "all"
            ? `No posts from ${props.agentName} yet.`
            : "Nothing here yet."}
        </p>
      ) : (
        <ol className="divide-y divide-border/40">
          {rows.map((row) => (
            <PostThread
              key={row.post.id}
              row={row}
              collapsed={collapsed.has(row.post.id)}
              onToggle={toggle}
              drivers={props.drivers}
              onReply={props.onReply}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

interface PostThreadProps {
  readonly row: TeamBoardRow;
  readonly collapsed: boolean;
  readonly onToggle: (postId: string) => void;
  readonly drivers: Drivers;
  readonly onReply: ((post: TeamBoardPost) => void) | null;
}

/** A thread and its replies; a delta frame re-renders only the threads it touched. */
const PostThread = memo(
  function PostThread(props: PostThreadProps) {
    return (
      <li data-team-board-post={props.row.post.id}>
        <PostRow post={props.row.post} drivers={props.drivers} onReply={props.onReply} />
        {props.row.replies.length > 0 ? (
          <Button
            size="xs"
            variant="ghost"
            className="mb-1 ml-9"
            aria-expanded={!props.collapsed}
            data-team-board-replies-toggle="true"
            onClick={() => props.onToggle(props.row.post.id)}
          >
            {props.collapsed
              ? `${props.row.replies.length} ${props.row.replies.length === 1 ? "reply" : "replies"}`
              : "Hide replies"}
          </Button>
        ) : null}
        {props.row.replies.length > 0 && !props.collapsed ? (
          <ol className="mb-2 ml-9 border-l border-border/70" data-team-board-replies="true">
            {props.row.replies.map((reply) => (
              <li key={reply.id} data-team-board-post={reply.id}>
                <PostRow post={reply} drivers={props.drivers} onReply={null} nested />
              </li>
            ))}
          </ol>
        ) : null}
      </li>
    );
  },
  (previous: PostThreadProps, next: PostThreadProps) =>
    sameTeamBoardRow(previous.row, next.row) &&
    previous.collapsed === next.collapsed &&
    previous.onToggle === next.onToggle &&
    previous.drivers === next.drivers &&
    previous.onReply === next.onReply,
);

const KIND_CHIP_CLASS: Record<TeamBoardKindTone, string> = {
  claim: "bg-info/12 text-info-foreground",
  finding: "bg-violet-500/12 text-violet-700 dark:text-violet-300",
  question: "bg-warning/14 text-warning-foreground",
  done: "bg-success/12 text-success-foreground",
  muted: "bg-muted text-muted-foreground",
  decision: "bg-foreground/8 text-foreground",
};

function PostRow(props: {
  readonly post: TeamBoardPost;
  readonly drivers: Drivers;
  readonly onReply: ((post: TeamBoardPost) => void) | null;
  readonly nested?: boolean;
}) {
  const { post } = props;
  const { onOpen } = use(BoardPeople);
  const kind = teamBoardKind(post.kind);
  const conflict = post.conflict;
  const line = useAuthorLine(post.author, props.drivers);
  const open = onOpen === null || line.open === null ? null : () => onOpen(line.open!);
  return (
    <div
      data-team-board-kind={post.kind}
      data-team-board-conflict={conflict ? "true" : undefined}
      {...(open === null
        ? {}
        : {
            role: "button",
            tabIndex: 0,
            "aria-label": `Open ${line.name}`,
            onClick: open,
            onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                open();
              }
            },
          })}
      className={cn(
        "group/team-post flex gap-2 py-2",
        props.nested ? "pr-3 pl-3" : "px-3",
        conflict && "bg-warning/8",
        open !== null &&
          "cursor-pointer hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none active:bg-accent/60",
      )}
    >
      <AuthorAvatar author={post.author} drivers={props.drivers} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-start gap-1.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
            <AuthorName author={post.author} drivers={props.drivers} />
            <span className="flex min-w-0 max-w-full items-center gap-1.5">
              <Addressee post={post} drivers={props.drivers} />
              {kind ? (
                <span
                  className={cn(
                    "shrink-0 rounded-sm px-1.5 py-px text-2xs font-medium",
                    KIND_CHIP_CLASS[kind.tone],
                  )}
                >
                  {kind.label}
                </span>
              ) : null}
              {post.pinned ? (
                <PinIcon aria-label="Pinned" className="size-3 shrink-0 text-muted-foreground" />
              ) : null}
            </span>
          </div>
          {props.onReply ? (
            <span className="opacity-0 transition-opacity duration-120 group-hover/team-post:opacity-100 focus-within:opacity-100 motion-reduce:transition-none">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Reply to ${line.name}`}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onReply?.(post);
                }}
              >
                <ReplyIcon />
              </Button>
            </span>
          ) : null}
          <time className="shrink-0 text-2xs text-muted-foreground tabular-nums">
            {formatTeamBoardTime(post.at)}
          </time>
        </div>
        <p className="text-sm leading-snug break-words text-foreground">{post.text}</p>
        {conflict ? (
          <p className="text-xs text-warning-foreground">{teamBoardOverlapLabel(conflict)}</p>
        ) : null}
        {post.files?.length || post.commit ? (
          <div className="flex flex-wrap gap-1">
            {post.commit ? <FileChip label={post.commit} path={`Commit ${post.commit}`} /> : null}
            {post.files?.map((file) => (
              <FileChip key={file} label={fileChipLabel(file)} path={file} />
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function fileChipLabel(file: string) {
  const label = teamBoardFileLabel(file);
  return label.symbol ? `${label.name}#${label.symbol}` : label.name;
}

function FileChip(props: { readonly label: string; readonly path: string }) {
  return (
    <span
      aria-label={props.path}
      className="max-w-full truncate rounded-sm bg-muted px-1.5 py-px font-mono text-2xs text-muted-foreground"
    >
      {props.label}
    </span>
  );
}

function FilesTab(props: {
  readonly files: ReadonlyArray<TeamBoardFile>;
  readonly agentName: string | null;
  readonly drivers: Drivers;
}) {
  if (props.files.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">
          {props.agentName === null
            ? "No file is being edited by two subagents."
            : `${props.agentName} shares no files yet.`}
        </p>
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
      <ol className="divide-y divide-border/40">
        {props.files.map((file) => (
          <li key={file.path} className="space-y-1.5 px-3 py-2" data-team-board-file={file.path}>
            <div className="flex min-w-0 items-center gap-2">
              <span className="flex min-w-0 flex-1 font-mono text-xs text-foreground">
                <MiddleTruncate value={file.path} />
              </span>
              {file.willConflict === true ? (
                <span className="shrink-0 rounded-sm bg-warning/14 px-1.5 py-px text-2xs font-medium text-warning-foreground">
                  Will conflict
                </span>
              ) : file.willConflict === false ? (
                <span className="shrink-0 text-2xs text-muted-foreground">No conflict</span>
              ) : null}
            </div>
            <ul className="space-y-1">
              {file.agents.map((entry) => (
                <li
                  key={teamBoardAuthorKey(entry.author)}
                  data-team-board-stale={entry.stale ? "true" : undefined}
                  className={cn(
                    "flex min-w-0 items-center gap-1.5 text-xs",
                    entry.stale && "opacity-60",
                  )}
                >
                  <AuthorAvatar author={entry.author} drivers={props.drivers} small />
                  <AuthorName author={entry.author} drivers={props.drivers} />
                  <span className="min-w-0 truncate text-muted-foreground tabular-nums">
                    {[
                      formatTeamBoardRanges(entry.ranges),
                      ...(entry.claims ?? []).map((claim) => {
                        const label = teamBoardFileLabel(claim);
                        return label.symbol ? `editing ${label.symbol}` : "editing the file";
                      }),
                      // No change in a while: the range may no longer be what it edits.
                      entry.stale ? "stale" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </div>
  );
}

const STATE_DOT: Record<TeamBoardMemberState, string> = {
  working: "bg-info",
  done: "bg-success",
  failed: "bg-destructive",
};
const STATE_LABEL: Record<TeamBoardMemberState, string> = {
  working: "working",
  done: "done",
  failed: "failed",
};

/** One chip per member; picking one filters Posts and Files to it, picking it again clears. */
function RosterRow(props: {
  readonly roster: ReadonlyArray<TeamBoardRosterChip>;
  readonly selected: NodeId | null;
  readonly drivers: Drivers;
  readonly onSelect: (taskId: NodeId | null) => void;
  /** Files each member holds now, from the presence feed (live frames carry no presence). */
  readonly holds?: ReadonlyMap<string, number>;
}) {
  if (props.roster.length === 0) return null;
  return (
    <div className="h-10 shrink-0 border-b border-border/60">
      <ScrollArea radius="none" hideScrollbars scrollFade scrollFadePadding={false}>
        <div
          role="group"
          aria-label="Team"
          data-team-board-roster="true"
          className="flex h-full w-max min-w-full items-center gap-1.5 px-3"
        >
          {props.roster.map((chip) => {
            const selected = props.selected === chip.member.id;
            const detail = teamBoardHoldsLabel(props.holds?.get(chip.member.id) ?? chip.holds);
            return (
              <button
                key={chip.member.id}
                type="button"
                aria-pressed={selected}
                aria-label={[chip.name, STATE_LABEL[chip.state], detail].filter(Boolean).join(", ")}
                data-team-board-member={chip.member.id}
                onClick={() => props.onSelect(selected ? null : chip.member.id)}
                className={cn(
                  "inline-flex h-7 max-w-[18rem] shrink-0 items-center gap-1.5 rounded-full border px-1.5 pr-2.5 text-xs transition-colors duration-120 motion-reduce:transition-none",
                  selected
                    ? "border-foreground/25 bg-accent text-foreground"
                    : "border-border/70 text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                )}
              >
                <span className="relative inline-flex shrink-0">
                  <AuthorAvatar
                    author={{ name: chip.name, taskId: chip.member.id }}
                    drivers={props.drivers}
                    small
                  />
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -right-0.5 -bottom-0.5 size-1.5 rounded-full ring-1 ring-background",
                      STATE_DOT[chip.state],
                    )}
                  />
                </span>
                <span className="max-w-[9rem] shrink-0 truncate font-medium text-foreground">
                  {chip.name}
                </span>
                {detail ? (
                  <span className="min-w-0 truncate text-2xs text-muted-foreground">{detail}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}

/** "→ Sol 6.2", "→ Lead" or "→ You": the addressee's avatar and short model name. */
function Addressee(props: { readonly post: TeamBoardPost; readonly drivers: Drivers }) {
  const { members } = use(BoardPeople);
  const to = teamBoardAddressee(props.post);
  const member = to?.kind === "member" ? teamBoardAddressedMember(members, props.post) : undefined;
  const author = { name: to?.name ?? "", ...(member ? { taskId: member.id } : {}) };
  const line = useAuthorLine(author, props.drivers);
  if (to === null) return null;
  const name = member ? line.name : to.name;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={`to ${name}`}
            className="flex min-w-0 items-center gap-1 text-2xs text-muted-foreground"
          />
        }
      >
        <span aria-hidden className="shrink-0">
          →
        </span>
        {member ? <AuthorAvatar author={author} drivers={props.drivers} small /> : null}
        {member && line.model !== null ? (
          <>
            <span aria-hidden className="min-w-0 truncate font-medium text-foreground">
              {name}
            </span>
            <span aria-hidden className="shrink-0 whitespace-nowrap">
              {line.model}
            </span>
          </>
        ) : (
          <span aria-hidden className="shrink-0 font-medium whitespace-nowrap text-foreground">
            {name}
          </span>
        )}
      </TooltipTrigger>
      <TooltipPopup>{name}</TooltipPopup>
    </Tooltip>
  );
}

/** The sender as its row in the lead chat names it: title, then the model's short name. */
function AuthorName(props: {
  readonly author: TeamBoardPost["author"];
  readonly drivers: Drivers;
}) {
  const line = useAuthorLine(props.author, props.drivers);
  return (
    <span className="flex min-w-0 shrink items-baseline gap-1">
      <span className="min-w-0 shrink truncate text-xs font-medium text-foreground">
        {line.name}
      </span>
      {line.model === null ? null : (
        <span className="shrink-0 text-2xs text-muted-foreground">{line.model}</span>
      )}
    </span>
  );
}

function AuthorAvatar(props: {
  readonly author: TeamBoardPost["author"];
  readonly drivers: Drivers;
  readonly small?: boolean;
}) {
  const line = useAuthorLine(props.author, props.drivers);
  const size = props.small ? "size-4" : "size-6";
  if (props.author.user || props.author.taskId === undefined) {
    const Icon = props.author.user ? UserRoundIcon : CrownIcon;
    return (
      <span
        aria-hidden
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted text-muted-foreground",
          size,
        )}
      >
        <Icon className={props.small ? "size-2.5" : "size-3.5"} />
      </span>
    );
  }
  // Same mark as the subagent's row: its instance's own icon; a neutral mark when unknown.
  return (
    <SubagentAvatar
      driver={line.provider?.driver ?? line.info?.driver ?? undefined}
      provider={line.provider}
      className={cn("ring-0", size)}
    />
  );
}

function TeamBoardComposer(props: {
  readonly threadRef: ScopedThreadRef;
  /** With two or more live repositories, the one this post goes to. */
  readonly repo: string | null;
  readonly canPost: boolean;
  readonly replyTo: TeamBoardPost | null;
  readonly onClearReply: () => void;
  readonly drivers: Drivers;
}) {
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const post = useAtomCommand(teamBoardEnvironment.post, {
    label: "message the team",
    reportFailure: false,
  });
  const parsed = parseTeamBoardDraft(draft);
  const lengthError = teamBoardDraftError(draft);
  const disabled = !props.canPost || pending;
  const canSend = !disabled && parsed.text.length > 0 && lengthError === null;
  const send = async () => {
    if (!canSend) return;
    setPending(true);
    setError(null);
    const result = await post({
      environmentId: props.threadRef.environmentId,
      input: {
        threadId: props.threadRef.threadId,
        text: parsed.text,
        ...(props.repo === null ? {} : { repo: props.repo }),
        ...(props.replyTo ? { replyTo: props.replyTo.id } : {}),
        ...(parsed.decision ? { decision: true } : {}),
        clientRequestId: randomUUID(),
      },
    });
    setPending(false);
    if (result._tag === "Success") {
      setDraft("");
      props.onClearReply();
    } else {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error && cause.message ? cause.message : "The post did not send.");
    }
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  };
  return (
    <div className="border-t border-border/60 px-3 py-2" data-team-board-composer="true">
      {props.replyTo ? (
        <div className="mb-1 flex items-center gap-1 text-2xs text-muted-foreground">
          <ReplyIcon aria-hidden className="size-3" />
          <span className="min-w-0 truncate">
            Replying to <AuthorName author={props.replyTo.author} drivers={props.drivers} />
          </span>
          <Button
            size="icon-tiny"
            variant="ghost"
            aria-label="Cancel reply"
            onClick={props.onClearReply}
          >
            <XIcon />
          </Button>
        </div>
      ) : null}
      <div className="flex items-end gap-2">
        <textarea
          aria-label="Message the team"
          rows={1}
          value={draft}
          disabled={disabled}
          maxLength={TEAM_BOARD_MESSAGE_MAX + 40}
          placeholder={
            props.canPost ? "Message the team" : "This connection can't post to the team"
          }
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          className="field-sizing-content max-h-28 min-h-8 min-w-0 flex-1 resize-none rounded-lg border border-input bg-background px-2.5 py-1.5 text-sm text-foreground outline-none placeholder:text-muted-foreground/70 focus-visible:border-ring disabled:opacity-60"
        />
        <Button
          size="icon-sm"
          aria-label={parsed.decision ? "Post decision" : "Send to the team"}
          disabled={!canSend}
          onClick={() => void send()}
        >
          {pending ? <Spinner /> : <ArrowUpIcon />}
        </Button>
      </div>
      {error || lengthError || parsed.decision ? (
        <p
          className={cn(
            "mt-1 text-2xs",
            error || lengthError ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {error ?? lengthError ?? "Posts a pinned decision every subagent reads first."}
        </p>
      ) : null}
    </div>
  );
}
