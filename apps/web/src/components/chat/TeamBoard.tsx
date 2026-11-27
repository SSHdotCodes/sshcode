import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
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
  teamBoardDriversFromKey,
  teamBoardDriversKey,
  teamBoardFileLabel,
  teamBoardFiles,
  teamBoardKind,
  teamBoardOverlapLabel,
  type TeamBoardFilter,
  type TeamBoardKindTone,
  teamBoardPill,
  teamBoardPillLabel,
  teamBoardPresenceLabel,
  type TeamBoardRow,
  teamBoardRows,
} from "@t3tools/client-runtime/state/team-board";
import type {
  NodeId,
  OrchestrationV2Subagent,
  ScopedThreadRef,
  TeamBoardFile,
  TeamBoardPost,
  TeamBoardPush,
  TeamBoardSnapshot,
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
import { type KeyboardEvent, memo, useCallback, useEffect, useMemo, useState } from "react";

import { cn, randomUUID } from "~/lib/utils";
import {
  openTeamBoard,
  teamBoardEnvironment,
  teamBoardOpenAtom,
  type TeamBoardView,
} from "../../state/teamBoard";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { Menu, MenuPopup, MenuRadioGroup, MenuRadioItem, MenuTrigger } from "../ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { MiddleTruncate } from "../ui/middle-truncate";
import { Spinner } from "../ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerBanner } from "./ComposerBanner";
import { providerTextColor } from "./ProviderInstanceIcon";
import { SubagentAvatar } from "./SubagentCard";

type Subagents = ReadonlyArray<OrchestrationV2Subagent>;
type Drivers = ReadonlyMap<string, OrchestrationV2Subagent["driver"]>;
const EMPTY_SUBAGENTS: Subagents = [];

/** Authors' providers; the map changes only when one does, so rows keep their props. */
function useAuthorDrivers(subagents: Subagents): Drivers {
  const key = teamBoardDriversKey(subagents);
  return useMemo(() => teamBoardDriversFromKey(key), [key]);
}

function useThreadSubagents(ref: ScopedThreadRef): Subagents {
  return (
    useAtomValue(
      environmentThreadDetails.threadAtom(ref),
      (thread) => thread?.projection.subagents,
    ) ?? EMPTY_SUBAGENTS
  );
}

/** "Team board · 6 posts · 1 overlap" above the lead's composer, beside live progress. */
export function TeamBoardPill(props: { readonly threadRef: ScopedThreadRef }) {
  const ref = props.threadRef;
  const summary = useAtomValue(teamBoardEnvironment.summaryAtom(ref));
  const seen = useAtomValue(teamBoardEnvironment.seenAtom(ref));
  const openAtom = teamBoardOpenAtom(threadKey(ref));
  const open = useAtomValue(openAtom);
  const setOpen = useAtomSet(openAtom);
  // The pill moves between the dock's start and end; the popover stays over the chat column.
  const [column, setColumn] = useState<Element | null>(null);
  const pill = teamBoardPill(summary, seen);
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
  const subagents = useThreadSubagents(ref);
  const drivers = useAuthorDrivers(subagents);
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
  // The pill counts every live repository, so reading any of them marks the whole team read.
  const latestPostId = live ? summary?.latestPostId : undefined;
  // Reading the live board marks it read on this machine, including posts that land while open.
  useEffect(() => {
    if (latestPostId !== undefined) setSeen(latestPostId);
  }, [latestPostId, setSeen]);
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
  return (
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
      {agentName !== null ? (
        <div className="flex items-center gap-1.5 border-b border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
          <span>Showing</span>
          <AuthorName author={{ name: agentName, taskId: props.taskId! }} drivers={drivers} />
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() => props.onTaskChange(null)}
          >
            Everyone
          </Button>
        </div>
      ) : null}
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
  });
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
  const kind = teamBoardKind(post.kind);
  const conflict = post.conflict;
  return (
    <div
      data-team-board-kind={post.kind}
      data-team-board-conflict={conflict ? "true" : undefined}
      className={cn(
        "group/team-post flex gap-2 py-2",
        props.nested ? "pr-3 pl-3" : "px-3",
        conflict && "bg-warning/8",
      )}
    >
      <AuthorAvatar author={post.author} drivers={props.drivers} />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <AuthorName author={post.author} drivers={props.drivers} />
          {post.to ? (
            <span className="min-w-0 truncate text-2xs text-muted-foreground">to {post.to}</span>
          ) : null}
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
          <span className="flex-1" />
          {props.onReply ? (
            <span className="opacity-0 transition-opacity duration-120 group-hover/team-post:opacity-100 focus-within:opacity-100 motion-reduce:transition-none">
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Reply to ${post.author.name}`}
                onClick={() => props.onReply?.(post)}
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
      <p className="px-3 py-6 text-center text-xs text-muted-foreground">
        {props.agentName === null
          ? "No file is claimed or changed by two agents."
          : `${props.agentName} shares no files yet.`}
      </p>
    );
  }
  return (
    <ol className="min-h-0 flex-1 divide-y divide-border/40 overflow-y-auto overscroll-contain">
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
                      return label.symbol ? `claims ${label.symbol}` : "claims the file";
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
  );
}

/** Subagents use their card's provider color; the user and the lead read in the text color. */
function AuthorName(props: {
  readonly author: TeamBoardPost["author"];
  readonly drivers: Drivers;
}) {
  const driver =
    props.author.taskId === undefined ? undefined : props.drivers.get(props.author.taskId);
  const color = driver ? providerTextColor(driver) : {};
  return (
    <span
      className={cn("min-w-0 shrink truncate text-xs font-medium text-foreground", color.className)}
      style={color.style}
    >
      {props.author.user ? "You" : props.author.name}
    </span>
  );
}

function AuthorAvatar(props: {
  readonly author: TeamBoardPost["author"];
  readonly drivers: Drivers;
  readonly small?: boolean;
}) {
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
  return (
    <SubagentAvatar
      driver={props.drivers.get(props.author.taskId)}
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

/** What a subagent card's agent is claiming or editing now; opens the board filtered to it. */
export function TeamBoardPresenceChip(props: {
  readonly threadRef: ScopedThreadRef;
  readonly taskId: NodeId;
}) {
  const files = useAtomValue(teamBoardEnvironment.presenceAtom(props.threadRef, props.taskId));
  const label = files === null ? null : teamBoardPresenceLabel(files);
  if (files === null || label === null) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        delay={300}
        render={
          <button
            type="button"
            data-team-board-presence={props.taskId}
            aria-label={`On the team board: ${files.join(", ")}. Open the board for this subagent.`}
            onClick={() => openTeamBoard(props.threadRef, props.taskId)}
            className="ml-1.5 inline-flex max-w-36 shrink-0 items-center gap-1 rounded-full border border-border/60 bg-background/60 px-2 py-0.5 font-mono text-2xs text-muted-foreground transition-colors duration-120 ease-out hover:border-border hover:bg-accent/50 hover:text-foreground motion-reduce:transition-none"
          />
        }
      >
        <span className="min-w-0 truncate">{label.name}</span>
        {label.more > 0 ? <span className="shrink-0 tabular-nums">+{label.more}</span> : null}
      </TooltipTrigger>
      <TooltipPopup>
        <span className="block font-mono text-2xs">
          {files.map((file) => (
            <span key={file} className="block">
              {file}
            </span>
          ))}
        </span>
      </TooltipPopup>
    </Tooltip>
  );
}
