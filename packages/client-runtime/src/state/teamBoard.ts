import {
  WS_METHODS,
  type EnvironmentId,
  type NodeId,
  type OrchestrationV2Subagent,
  type ScopedThreadRef,
  type TeamBoardFile,
  type TeamBoardPost,
  type TeamBoardPostInput,
  type TeamBoardPush,
  type TeamBoardSnapshot,
  type TeamBoardSubscribeInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { parseThreadKey, threadKey } from "./entities.ts";
import {
  type AtomCommand,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export function createTeamBoardAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  const subscribe = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "team board",
    tag: WS_METHODS.teamBoardSubscribe,
    idleTtlMs: 0,
    resubscribeOnWakeup: true,
    // Delta frames carry only what changed; readers always see the whole board.
    transform: (frames) =>
      frames.pipe(
        Stream.mapAccum(
          (): TeamBoardSnapshot | null => null,
          (previous, frame) => {
            const next = applyTeamBoardFrame(previous, frame);
            return [next, [next]] as const;
          },
        ),
      ),
  });
  const post = createEnvironmentRpcCommand(runtime, {
    label: "message the team",
    tag: WS_METHODS.teamBoardPost,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
    },
  });
  return { subscribe, post };
}

export type TeamBoardSubagent = Pick<OrchestrationV2Subagent, "id" | "origin" | "remote" | "title">;
/** What a post header and the roster read about a member, from the lead chat's task records. */
export type TeamBoardMember = TeamBoardSubagent &
  Pick<
    OrchestrationV2Subagent,
    "driver" | "providerInstanceId" | "model" | "modelSelection" | "childThreadId" | "status"
  >;
export type TeamBoardPostTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: TeamBoardPostInput;
};
export type TeamBoardPostCommand = AtomCommand<TeamBoardPostTarget, void, unknown>;
type TeamBoardSubscribeTarget = {
  readonly environmentId: EnvironmentId;
  readonly input: TeamBoardSubscribeInput;
};

/**
 * What one view reads: the live summary (every live repository together) or one live
 * repository's posts, presence, a past push, or an older page of past pushes. Only the live
 * summary counts toward the pill and its unread dot.
 */
export type TeamBoardRequest =
  | { readonly kind: "summary" }
  | { readonly kind: "details"; readonly repo?: string | undefined }
  | { readonly kind: "presence" }
  | { readonly kind: "push"; readonly pushId: string }
  | { readonly kind: "history"; readonly before: string };

/** Summaries and the live posts opt in to deltas, which also drops presence from them. */
export function teamBoardSubscribeInput(
  threadId: ScopedThreadRef["threadId"],
  request: TeamBoardRequest,
): TeamBoardSubscribeInput {
  switch (request.kind) {
    case "summary":
      return { threadId, delta: true };
    case "details":
      return request.repo === undefined
        ? { threadId, details: true, delta: true }
        : { threadId, details: true, delta: true, pushId: request.repo };
    case "presence":
      return { threadId, presenceOnly: true };
    case "push":
      return { threadId, details: true, pushId: request.pushId };
    case "history":
      return { threadId, delta: true, historyBefore: request.before };
  }
}

/**
 * Folds one subscription frame into the board. A complete frame (the first one, the first
 * after a reconnect, a new push, or any frame from a server without deltas) replaces it; a
 * delta replaces or adds its posts, drops removed ones, and keeps files unless they changed.
 * Untouched posts keep their identity, so memoized rows skip them.
 */
export function applyTeamBoardFrame(
  previous: TeamBoardSnapshot | null,
  frame: TeamBoardSnapshot,
): TeamBoardSnapshot {
  const { delta, removedPostIds, ...next } = frame;
  if (delta !== true || previous === null) return next;
  // Two pushes never mix: a delta for another push starts over instead of merging.
  if (
    next.pushId !== undefined &&
    previous.pushId !== undefined &&
    next.pushId !== previous.pushId
  ) {
    return next;
  }
  const removed = new Set(removedPostIds ?? []);
  const changed = new Map((next.posts ?? []).map((post) => [post.id, post]));
  let posts = previous.posts;
  if (removed.size > 0 || changed.size > 0) {
    const merged: TeamBoardPost[] = [];
    for (const post of previous.posts ?? []) {
      if (removed.has(post.id)) continue;
      merged.push(changed.get(post.id) ?? post);
      changed.delete(post.id);
    }
    for (const post of changed.values()) if (!removed.has(post.id)) merged.push(post);
    posts = merged;
  }
  const { latestPostId, pushId, history, historyHasMore, files } = previous;
  // `repos` is not carried over: a frame without it has fewer than two live repositories.
  return {
    ...next,
    ...(posts === undefined ? {} : { posts }),
    ...(next.files === undefined && files !== undefined ? { files } : {}),
    ...(next.latestPostId === undefined && latestPostId !== undefined && next.postCount > 0
      ? { latestPostId }
      : {}),
    ...(next.pushId === undefined && pushId !== undefined ? { pushId } : {}),
    ...(next.history === undefined && history !== undefined
      ? { history, ...(historyHasMore === undefined ? {} : { historyHasMore }) }
      : {}),
  };
}

/** Stand-in for the server in dev QA: snapshots built on the chat's own task records. */
export interface TeamBoardFixtureSource {
  readonly snapshot: (
    get: Atom.AtomContext,
    ref: ScopedThreadRef,
    subagents: ReadonlyArray<TeamBoardSubagent>,
    request: TeamBoardRequest,
  ) => TeamBoardSnapshot | null;
  /** The chat's own task records, or stand-ins so a chat without a team can show the board. */
  readonly members: (subagents: ReadonlyArray<TeamBoardMember>) => ReadonlyArray<TeamBoardMember>;
  readonly post: TeamBoardPostCommand;
  readonly canPost?: boolean;
}

/** Sync key/value storage the client already has (localStorage, the phone's kv-store). */
export interface TeamBoardSeenStorage {
  readonly read: () => string | null;
  readonly write: (value: string) => void;
}

const SEEN_LIMIT = 200;
const EMPTY_SUBAGENTS: ReadonlyArray<TeamBoardMember> = [];

/** Only local app-owned task records can share a board; remote and provider-native ones cannot. */
export function canHaveTeamBoard(subagents: ReadonlyArray<TeamBoardSubagent>): boolean {
  let count = 0;
  for (const agent of subagents) {
    if (agent.origin === "app_owned" && agent.remote === undefined && ++count >= 2) return true;
  }
  return false;
}

/**
 * What a chat view reads. Summaries subscribe only for chats that can have a board (or whose
 * board this client already saw), so ordinary chats send no RPC. Details subscribe only while a
 * reader mounts them: the popover or sheet. Presence has its own feed, only while a push is live.
 */
export function createTeamBoardViewAtoms(options: {
  readonly board: {
    readonly subscribe: (
      target: TeamBoardSubscribeTarget,
    ) => Atom.Atom<AsyncResult.AsyncResult<TeamBoardSnapshot, unknown>>;
    readonly post: TeamBoardPostCommand & {
      readonly permissionAtom: (environmentId: EnvironmentId | null) => Atom.Atom<boolean>;
    };
  };
  readonly subagentsAtom: (
    ref: ScopedThreadRef,
  ) => Atom.Atom<ReadonlyArray<TeamBoardMember> | null | undefined>;
  readonly seenStorage?: TeamBoardSeenStorage | undefined;
  readonly fixture?: TeamBoardFixtureSource | undefined;
}) {
  const { board, fixture } = options;
  // Boards this client has seen; they keep their summary when older task records page out.
  const known = new Set<string>();
  const seenState = Atom.make<Readonly<Record<string, string>>>(
    decodeSeen(options.seenStorage?.read() ?? null),
  ).pipe(Atom.keepAlive);
  const seenFamily = Atom.family((key: string) =>
    Atom.writable(
      (get) => get(seenState)[key] ?? null,
      (ctx, mark: string | TeamBoardSeenMark) => {
        const current = ctx.get(seenState);
        const marked = markTeamBoardSeen(current[key] ?? null, mark);
        if (current[key] === marked) return;
        const next = rememberSeen(current, key, marked);
        ctx.set(seenState, next);
        options.seenStorage?.write(JSON.stringify(next));
      },
    ),
  );
  const snapshotFamily: (key: string) => Atom.Atom<TeamBoardSnapshot | null> = Atom.family(
    (key: string) => {
      const [kind, scoped, extra] = key.split(KEY_SEPARATOR) as [
        TeamBoardRequest["kind"],
        string,
        string,
      ];
      const request: TeamBoardRequest =
        kind === "push"
          ? { kind, pushId: extra }
          : kind === "history"
            ? { kind, before: extra }
            : kind === "details"
              ? { kind, ...(extra === "" ? {} : { repo: extra }) }
              : { kind };
      const ref = parseThreadKey(scoped);
      return Atom.make((get): TeamBoardSnapshot | null => {
        const own = get(options.subagentsAtom(ref)) ?? EMPTY_SUBAGENTS;
        const subagents = fixture ? fixture.members(own) : own;
        if (
          !known.has(scoped) &&
          !canHaveTeamBoard(subagents) &&
          get(seenFamily(scoped)) === null
        ) {
          return null;
        }
        // Presence matters only while a push runs; an ended or idle board sends none.
        if (
          kind === "presence" &&
          get(snapshotFamily(requestKey(scoped, SUMMARY)))?.active !== true
        ) {
          return null;
        }
        let value: TeamBoardSnapshot | null;
        if (fixture) {
          value = fixture.snapshot(get, ref, subagents, request);
        } else {
          const input = teamBoardSubscribeInput(ref.threadId, request);
          value = Option.getOrNull(
            AsyncResult.value(get(board.subscribe({ environmentId: ref.environmentId, input }))),
          );
        }
        if (value !== null) known.add(scoped);
        return value;
      }).pipe(Atom.withLabel(`team-board-view:${kind}:${scoped}`));
    },
  );
  const holdsFamily = Atom.family((scoped: string) =>
    Atom.make(
      (get): ReadonlyMap<string, number> =>
        new Map(
          (get(snapshotFamily(requestKey(scoped, PRESENCE)))?.presence ?? []).map(
            ({ taskId, files }) => [taskId, files.length] as const,
          ),
        ),
    ),
  );
  const permissionAtom = (environmentId: EnvironmentId | null) =>
    fixture?.canPost === false ? Atom.make(false) : board.post.permissionAtom(environmentId);
  // The live repository picked on this client; kept while it stays live.
  const pickedRepoFamily = Atom.family((_key: string) =>
    Atom.make<string | null>(null).pipe(Atom.keepAlive),
  );
  const repoChoiceFamily = Atom.family((scoped: string) =>
    Atom.make((get) =>
      teamBoardRepoChoice(
        get(snapshotFamily(requestKey(scoped, SUMMARY))),
        get(pickedRepoFamily(scoped)),
      ),
    ),
  );
  const membersFamily = Atom.family((scoped: string) =>
    Atom.make((get): ReadonlyArray<TeamBoardMember> => {
      const own = get(options.subagentsAtom(parseThreadKey(scoped))) ?? EMPTY_SUBAGENTS;
      return fixture ? fixture.members(own) : own;
    }),
  );
  const detailsFamily = Atom.family((scoped: string) =>
    Atom.make((get) => {
      const repo = get(repoChoiceFamily(scoped))?.chosen.id;
      return get(snapshotFamily(requestKey(scoped, { kind: "details", repo })));
    }),
  );
  const historyCursorsFamily = Atom.family((_key: string) => Atom.make<ReadonlyArray<string>>([]));
  const historyListFamily = Atom.family((scoped: string) =>
    Atom.writable(
      (get) =>
        teamBoardHistoryList(
          get(snapshotFamily(requestKey(scoped, SUMMARY))),
          get(historyCursorsFamily(scoped)).map((before) =>
            get(snapshotFamily(requestKey(scoped, { kind: "history", before }))),
          ),
        ),
      (ctx, before: string) => {
        const cursors = ctx.get(historyCursorsFamily(scoped));
        if (!cursors.includes(before)) ctx.set(historyCursorsFamily(scoped), [...cursors, before]);
      },
    ),
  );
  return {
    summaryAtom: (ref: ScopedThreadRef) => snapshotFamily(requestKey(threadKey(ref), SUMMARY)),
    /** The chosen live repository's posts and files; with one live repository, its board. */
    detailsAtom: (ref: ScopedThreadRef) => detailsFamily(threadKey(ref)),
    /** The live repositories and the one shown, or null while fewer than two are live. */
    repoChoiceAtom: (ref: ScopedThreadRef) => repoChoiceFamily(threadKey(ref)),
    /** Picks a live repository's board; the pill and its unread dot stay on the whole team. */
    pickedRepoAtom: (ref: ScopedThreadRef) => pickedRepoFamily(threadKey(ref)),
    /** A past push, read-only; it never moves the live push's unread mark. */
    pushAtom: (ref: ScopedThreadRef, pushId: string) =>
      snapshotFamily(requestKey(threadKey(ref), { kind: "push", pushId })),
    /**
     * Past pushes for the header list: the summary's newest page, then each older page asked
     * for. Writing an `olderCursor` fetches the next page; closing the list forgets them.
     */
    historyListAtom: (ref: ScopedThreadRef) => historyListFamily(threadKey(ref)),
    /** The newest post id this client has opened, per environment and lead chat. */
    seenAtom: (ref: ScopedThreadRef) => seenFamily(threadKey(ref)),
    /** How many files each member holds now, for the roster; live frames carry no presence. */
    holdsAtom: (ref: ScopedThreadRef) => holdsFamily(threadKey(ref)),
    /** Who is on the board: the chat's task records, or the QA fixture's stand-ins. */
    membersAtom: (ref: ScopedThreadRef) => membersFamily(threadKey(ref)),
    post: fixture?.post ?? board.post,
    permissionAtom,
  };
}

const KEY_SEPARATOR = "\u0001";
const SUMMARY: TeamBoardRequest = { kind: "summary" };
const PRESENCE: TeamBoardRequest = { kind: "presence" };

function requestKey(scoped: string, request: TeamBoardRequest) {
  const extra =
    request.kind === "push"
      ? request.pushId
      : request.kind === "history"
        ? request.before
        : request.kind === "details"
          ? (request.repo ?? "")
          : "";
  return `${request.kind}${KEY_SEPARATOR}${scoped}${KEY_SEPARATOR}${extra}`;
}

export type TeamBoardRepo = NonNullable<TeamBoardSnapshot["repos"]>[number];

export interface TeamBoardRepoChoice {
  readonly repos: ReadonlyArray<TeamBoardRepo>;
  readonly chosen: TeamBoardRepo;
}

/**
 * With two or more live repositories, the one the board shows: the picked one while it is still
 * live, otherwise the first the server lists. Null while fewer than two are live.
 */
export function teamBoardRepoChoice(
  summary: TeamBoardSnapshot | null,
  picked: string | null,
): TeamBoardRepoChoice | null {
  const repos = summary?.active === true ? summary.repos : undefined;
  if (repos === undefined || repos.length < 2) return null;
  return { repos, chosen: repos.find((repo) => repo.id === picked) ?? repos[0]! };
}

function decodeSeen(raw: string | null): Readonly<Record<string, string>> {
  if (raw === null) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => {
        return typeof entry[1] === "string";
      }),
    );
  } catch {
    return {};
  }
}

/** Newest marks last; the oldest fall off past the cap. */
function rememberSeen(
  current: Readonly<Record<string, string>>,
  key: string,
  latestPostId: string,
): Readonly<Record<string, string>> {
  const entries = Object.entries(current).filter(([entryKey]) => entryKey !== key);
  entries.push([key, latestPostId]);
  return Object.fromEntries(entries.slice(-SEEN_LIMIT));
}

export interface TeamBoardPill {
  readonly postCount: number;
  readonly overlapCount: number;
  readonly unread: boolean;
}

/** Repositories a lead's seen mark remembers; the least recently viewed goes first. */
const SEEN_PER_BOARD = 32;
const seenEntries = (seen: string | null) => (seen === null ? [] : seen.split(" "));
const seenIds = (seen: string | null) =>
  seenEntries(seen).map((entry) => entry.slice(entry.indexOf("=") + 1));

/** The newest post a reader saw, and the repository it was open on when the lead has several. */
export interface TeamBoardSeenMark {
  readonly latestPostId: string;
  readonly repo: string | null;
}

/**
 * The seen mark is the newest post read in each repository, newest first, space separated:
 * `repo=post` per repository of a multi-repository team, or a bare post id for a single board.
 */
export function markTeamBoardSeen(seen: string | null, mark: string | TeamBoardSeenMark): string {
  const { latestPostId, repo } =
    typeof mark === "string" ? { latestPostId: mark, repo: null } : mark;
  const key = repo === null ? "" : `${encodeURIComponent(repo)}=`;
  return [
    key + latestPostId,
    ...seenEntries(seen).filter(
      (entry) =>
        !(key === "" ? !entry.includes("=") : entry.startsWith(key)) &&
        entry.slice(entry.indexOf("=") + 1) !== latestPostId,
    ),
  ]
    .slice(0, SEEN_PER_BOARD)
    .join(" ");
}

/** The newest post of the repository a reader has open, or of the board when it has one. */
export function teamBoardRepoLatestPostId(
  snapshot: TeamBoardSnapshot | null,
  repo: string | null,
): string | undefined {
  const repos = snapshot?.repos;
  // A server that predates per-repository marks names only the team's newest post.
  if (repo !== null && repos !== undefined && repos.some(({ latestPostId }) => latestPostId))
    return repos.find(({ id }) => id === repo)?.latestPostId;
  return snapshot?.latestPostId;
}

/** The composer pill shows only while a live board has posts. */
export function teamBoardPill(
  snapshot: TeamBoardSnapshot | null,
  seen: string | null,
): TeamBoardPill | null {
  if (snapshot === null || !snapshot.active || snapshot.postCount === 0) return null;
  const read = seenIds(seen);
  // A server that predates per-repository marks names only the team's newest post.
  const perRepo = (snapshot.repos ?? []).flatMap(({ latestPostId }) =>
    latestPostId === undefined ? [] : [latestPostId],
  );
  const latest =
    perRepo.length > 0
      ? perRepo
      : snapshot.latestPostId === undefined
        ? []
        : [snapshot.latestPostId];
  return {
    postCount: snapshot.postCount,
    overlapCount: snapshot.overlapCount,
    unread: latest.some((id) => !read.includes(id)),
  };
}

/**
 * What the chat header's "Team board" opens: past pushes, newest first, even while a new push
 * runs. A server without push history keeps one ended board, opened directly.
 */
export type TeamBoardHistory =
  | {
      readonly kind: "pushes";
      readonly pushes: ReadonlyArray<TeamBoardPush>;
      /** Older pushes exist beyond the summary's newest page. */
      readonly hasMore: boolean;
    }
  | { readonly kind: "ended" };

const pushEnded = (push: TeamBoardPush) => DateTime.toEpochMillis(push.endedAt);
const newestFirst = (pushes: ReadonlyArray<TeamBoardPush>) =>
  [...pushes].sort((left, right) => pushEnded(right) - pushEnded(left));

export function teamBoardHistory(snapshot: TeamBoardSnapshot | null): TeamBoardHistory | null {
  if (snapshot === null) return null;
  if (snapshot.history !== undefined) {
    if (snapshot.history.length === 0) return null;
    return {
      kind: "pushes",
      pushes: newestFirst(snapshot.history),
      hasMore: snapshot.historyHasMore === true,
    };
  }
  return !snapshot.active && snapshot.postCount > 0 ? { kind: "ended" } : null;
}

export function teamBoardHasHistory(snapshot: TeamBoardSnapshot | null): boolean {
  return teamBoardHistory(snapshot) !== null;
}

/** "3 past pushes", or "10+ past pushes" while older pages remain. */
export function teamBoardHistoryLabel(history: TeamBoardHistory, postCount: number): string {
  if (history.kind === "ended") {
    return `${postCount} ${postCount === 1 ? "post" : "posts"} · read-only`;
  }
  const count = history.pushes.length;
  return `${count}${history.hasMore ? "+" : ""} past ${count === 1 && !history.hasMore ? "push" : "pushes"}`;
}

export interface TeamBoardHistoryList {
  /** Every past push loaded so far, newest first, each once. */
  readonly pushes: ReadonlyArray<TeamBoardPush>;
  /** Pass to load the next older page; null when none is left or one is still loading. */
  readonly olderCursor: string | null;
  readonly loading: boolean;
}

/** The summary's newest page followed by the older pages asked for, in order. */
export function teamBoardHistoryList(
  summary: TeamBoardSnapshot | null,
  older: ReadonlyArray<TeamBoardSnapshot | null>,
): TeamBoardHistoryList {
  const seen = new Set<string>();
  const pushes: TeamBoardPush[] = [];
  let olderCursor: string | null = null;
  for (const page of [summary, ...older]) {
    if (page === null) return { pushes, olderCursor: null, loading: true };
    const sorted = newestFirst(page.history ?? []);
    for (const push of sorted) {
      if (seen.has(push.id)) continue;
      seen.add(push.id);
      pushes.push(push);
    }
    olderCursor = page.historyHasMore === true ? (sorted[sorted.length - 1]?.id ?? null) : null;
  }
  return { pushes, olderCursor, loading: false };
}

export function teamBoardPillLabel(pill: Pick<TeamBoardPill, "postCount" | "overlapCount">) {
  return {
    posts: `${pill.postCount} ${pill.postCount === 1 ? "post" : "posts"}`,
    overlaps:
      pill.overlapCount === 0
        ? null
        : `${pill.overlapCount} ${pill.overlapCount === 1 ? "overlap" : "overlaps"}`,
  };
}

export const TEAM_BOARD_FILTERS = [
  { id: "all", label: "All" },
  // People read what a subagent is doing; the agent-facing tool keeps "claim".
  { id: "claims", label: "Editing" },
  { id: "questions", label: "Questions" },
  { id: "overlaps", label: "Overlaps" },
  { id: "direct", label: "Direct" },
] as const;
export type TeamBoardFilter = (typeof TEAM_BOARD_FILTERS)[number]["id"];

export type TeamBoardKindTone = "claim" | "finding" | "question" | "done" | "muted" | "decision";

/** Kinds are open strings; unknown ones read as their own name in a muted chip. */
export function teamBoardKind(
  kind: string,
): { readonly label: string; readonly tone: TeamBoardKindTone } | null {
  switch (kind) {
    case "claim":
      return { label: "Editing", tone: "claim" };
    case "finding":
      return { label: "Finding", tone: "finding" };
    case "question":
      return { label: "Question", tone: "question" };
    case "done":
      return { label: "Done", tone: "done" };
    case "release":
      return { label: "Done editing", tone: "muted" };
    case "decision":
      return { label: "Decision", tone: "decision" };
    case "wait":
      return { label: "Waiting", tone: "muted" };
    case "message":
      return null;
    default: {
      const label = kind.trim();
      return label.length === 0
        ? null
        : { label: label[0]!.toUpperCase() + label.slice(1), tone: "muted" };
    }
  }
}

function matchesFilter(post: TeamBoardPost, filter: TeamBoardFilter) {
  switch (filter) {
    case "all":
      return true;
    case "claims":
      return post.kind === "claim" || post.kind === "release";
    case "questions":
      return post.kind === "question";
    case "overlaps":
      return post.conflict !== undefined;
    case "direct":
      return post.to !== undefined;
  }
}

const sameName = (left: string | undefined, right: string | undefined) =>
  left !== undefined &&
  right !== undefined &&
  left.trim().toLowerCase() === right.trim().toLowerCase();

/** One agent's posts, posts addressed to it, replies to its posts, and overlaps naming it. */
function involvesTask(
  post: TeamBoardPost,
  taskId: NodeId,
  name: string | undefined,
  byId: ReadonlyMap<string, TeamBoardPost>,
) {
  return (
    post.author.taskId === taskId ||
    post.conflict?.owner.taskId === taskId ||
    (post.toTaskId === undefined ? sameName(post.to, name) : post.toTaskId === taskId) ||
    (post.replyTo !== undefined && byId.get(post.replyTo)?.author.taskId === taskId)
  );
}

/** Who an addressed post is for: a sibling, the lead agent, or the person. */
export function teamBoardAddressee(
  post: TeamBoardPost,
): { readonly kind: "member" | "lead" | "you"; readonly name: string } | null {
  const to = post.to?.trim();
  if (!to) return null;
  if (/^(you|user)$/iu.test(to)) return { kind: "you", name: "You" };
  if (/^lead$/iu.test(to)) return { kind: "lead", name: "Lead" };
  return { kind: "member", name: to };
}

/** The member an addressed post is for: by id, or by title for posts from older servers. */
export function teamBoardAddressedMember<
  T extends { readonly id: string; readonly title: string | null },
>(members: ReadonlyArray<T>, post: Pick<TeamBoardPost, "to" | "toTaskId">): T | undefined {
  return post.toTaskId === undefined
    ? members.find((member) => sameName(member.title ?? undefined, post.to))
    : members.find((member) => member.id === post.toTaskId);
}

export interface TeamBoardRow {
  readonly post: TeamBoardPost;
  readonly replies: ReadonlyArray<TeamBoardPost>;
}

/**
 * Newest threads first; replies sit under their thread's first shown post, oldest first.
 * A reply whose thread is filtered out stands on its own.
 */
export function teamBoardRows(
  posts: ReadonlyArray<TeamBoardPost>,
  options: {
    readonly filter: TeamBoardFilter;
    readonly taskId?: NodeId | null | undefined;
    /** The selected member's name, so posts addressed to it count as its own. */
    readonly memberName?: string | undefined;
  },
): ReadonlyArray<TeamBoardRow> {
  const byId = new Map(posts.map((post) => [post.id, post]));
  // Direct shows addressed posts and every reply in their thread.
  const inAddressedThread = (post: TeamBoardPost) => {
    const visited = new Set<string>();
    for (let cursor: TeamBoardPost | undefined = post; cursor;) {
      if (cursor.to !== undefined) return true;
      if (cursor.replyTo === undefined || visited.has(cursor.id)) return false;
      visited.add(cursor.id);
      cursor = byId.get(cursor.replyTo);
    }
    return false;
  };
  const shown = posts.filter(
    (post) =>
      (options.filter === "direct"
        ? inAddressedThread(post)
        : matchesFilter(post, options.filter)) &&
      (options.taskId == null || involvesTask(post, options.taskId, options.memberName, byId)),
  );
  const shownIds = new Set(shown.map((post) => post.id));
  const rootOf = (post: TeamBoardPost) => {
    let root: TeamBoardPost | null = null;
    let cursor: TeamBoardPost | undefined = post;
    const visited = new Set<string>();
    while (cursor?.replyTo !== undefined && !visited.has(cursor.id)) {
      visited.add(cursor.id);
      cursor = byId.get(cursor.replyTo);
      if (cursor !== undefined && shownIds.has(cursor.id)) root = cursor;
    }
    return root;
  };
  const replies = new Map<string, TeamBoardPost[]>();
  const roots: TeamBoardPost[] = [];
  for (const post of shown) {
    const root = rootOf(post);
    if (root === null) {
      roots.push(post);
      continue;
    }
    const list = replies.get(root.id);
    if (list) list.push(post);
    else replies.set(root.id, [post]);
  }
  const at = (post: TeamBoardPost) => DateTime.toEpochMillis(post.at);
  return roots
    .map((post) => ({
      post,
      replies: [...(replies.get(post.id) ?? [])].sort((left, right) => at(left) - at(right)),
    }))
    .sort((left, right) => at(right.post) - at(left.post));
}

/** One row of a virtualized board: a thread's first post, or one of its replies. */
export interface TeamBoardListItem {
  readonly post: TeamBoardPost;
  /** Indented under its thread's first post, on the thread's connecting line. */
  readonly reply: boolean;
  /** The thread's last row, which draws the divider below the thread. */
  readonly endsThread: boolean;
  /** A thread's first post with replies, which can collapse them. */
  readonly hasReplies: boolean;
  /** How many replies a collapsed thread hides; 0 while open, so a new reply re-renders less. */
  readonly replyCount: number;
  readonly collapsed: boolean;
}

/**
 * Threads flattened into one row per post, so a thread with hundreds of replies still mounts
 * only the rows near the screen. A collapsed thread shows its first post with the reply count.
 */
export function teamBoardListItems(
  rows: ReadonlyArray<TeamBoardRow>,
  collapsed: ReadonlySet<string> = NO_COLLAPSED,
): ReadonlyArray<TeamBoardListItem> {
  const items: TeamBoardListItem[] = [];
  for (const row of rows) {
    const closed = row.replies.length > 0 && collapsed.has(row.post.id);
    items.push({
      post: row.post,
      reply: false,
      endsThread: row.replies.length === 0 || closed,
      hasReplies: row.replies.length > 0,
      replyCount: closed ? row.replies.length : 0,
      collapsed: closed,
    });
    if (closed) continue;
    const last = row.replies.length - 1;
    row.replies.forEach((reply, index) => {
      items.push({
        post: reply,
        reply: true,
        endsThread: index === last,
        hasReplies: false,
        replyCount: 0,
        collapsed: false,
      });
    });
  }
  return items;
}

const NO_COLLAPSED: ReadonlySet<string> = new Set();

/** Equal items render the same; a memoized row skips them between frames. */
export function sameTeamBoardListItem(left: TeamBoardListItem, right: TeamBoardListItem) {
  return (
    left.post === right.post &&
    left.reply === right.reply &&
    left.endsThread === right.endsThread &&
    left.hasReplies === right.hasReplies &&
    left.replyCount === right.replyCount &&
    left.collapsed === right.collapsed
  );
}

/** Equal rows render the same; a memoized row component skips them between frames. */
export function sameTeamBoardRow(left: TeamBoardRow, right: TeamBoardRow): boolean {
  return (
    left.post === right.post &&
    left.replies.length === right.replies.length &&
    left.replies.every((reply, index) => reply === right.replies[index])
  );
}

/** The overlap map, or one agent's share of it. */
export function teamBoardFiles(
  files: ReadonlyArray<TeamBoardFile>,
  taskId?: NodeId | null,
): ReadonlyArray<TeamBoardFile> {
  if (taskId == null) return files;
  return files.filter((file) => file.agents.some((agent) => agent.author.taskId === taskId));
}

type TeamBoardDriver = OrchestrationV2Subagent["driver"];
const DRIVER_ENTRY = "\u0001";
const DRIVER_PAIR = "\u0002";

/**
 * Authors' providers as a string that changes only when one does, so a client can memoize the
 * lookup on it and rows keep their props while the chat's task records churn.
 */
export function teamBoardDriversKey(subagents: ReadonlyArray<OrchestrationV2Subagent>): string {
  return subagents.map((task) => `${task.id}${DRIVER_PAIR}${task.driver}`).join(DRIVER_ENTRY);
}

export function teamBoardDriversFromKey(key: string): ReadonlyMap<string, TeamBoardDriver> {
  if (key.length === 0) return new Map();
  return new Map(
    key.split(DRIVER_ENTRY).map((entry) => {
      const [taskId, driver] = entry.split(DRIVER_PAIR) as [string, TeamBoardDriver];
      return [taskId, driver];
    }),
  );
}

export function teamBoardAuthorKey(author: TeamBoardPost["author"]): string {
  return author.user ? "user" : (author.taskId ?? "lead");
}

/** `path#symbol` claims show the file's name and the symbol apart. */
export function teamBoardFileLabel(file: string) {
  const hash = file.indexOf("#");
  const path = hash < 0 ? file : file.slice(0, hash);
  const symbol = hash < 0 ? null : file.slice(hash + 1) || null;
  const slash = path.lastIndexOf("/");
  return { path, symbol, name: slash < 0 ? path : path.slice(slash + 1) };
}

/** A denied claim names the agent already holding the file, never the claim's own author. */
export function teamBoardOverlapLabel(conflict: NonNullable<TeamBoardPost["conflict"]>): string {
  const file = teamBoardFileLabel(conflict.file).name;
  return conflict.owner.user
    ? `Overlap: You are already editing ${file}`
    : `Overlap: ${conflict.owner.name} is already editing ${file}`;
}

export function formatTeamBoardRanges(
  ranges: ReadonlyArray<{ readonly start: number; readonly end: number }> | undefined,
): string | null {
  if (ranges === undefined || ranges.length === 0) return null;
  return ranges
    .map((range) => (range.end > range.start ? `L${range.start}–${range.end}` : `L${range.start}`))
    .join(", ");
}

// Made on first use, so board times follow the viewer's time zone at that moment.
let localTime: Intl.DateTimeFormat | undefined;
let localDay: Intl.DateTimeFormat | undefined;
const boardTime = () =>
  (localTime ??= new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }));
const boardDay = () =>
  (localDay ??= new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }));

/** Board times on the viewer's local 12-hour clock ("9:42 PM"). */
export function formatTeamBoardTime(at: DateTime.Utc): string {
  return boardTime().format(DateTime.toEpochMillis(at));
}

/** The local date, clock and AM/PM of one instant, read from the formatters above. */
function localParts(epochMillis: number) {
  let clock = "";
  let period = "";
  for (const part of boardTime().formatToParts(epochMillis)) {
    if (part.type === "dayPeriod") period = part.value;
    else if (part.type !== "literal" || part.value === ":") clock += part.value;
  }
  return { day: boardDay().format(epochMillis), clock, period };
}

/**
 * A push's local span, sharing what both ends share: "Nov 26 · 7:16–7:21 PM",
 * "Nov 26 · 11:50 AM–12:10 PM", or "Nov 26, 11:50 PM – Nov 27, 12:30 AM" across midnight.
 */
export function formatTeamBoardPushTime(push: Pick<TeamBoardPush, "startedAt" | "endedAt">) {
  const start = localParts(DateTime.toEpochMillis(push.startedAt));
  const end = localParts(DateTime.toEpochMillis(push.endedAt));
  if (start.day !== end.day) {
    return `${start.day}, ${start.clock} ${start.period} – ${end.day}, ${end.clock} ${end.period}`;
  }
  return start.period === end.period
    ? `${start.day} · ${start.clock}–${end.clock} ${end.period}`
    : `${start.day} · ${start.clock} ${start.period}–${end.clock} ${end.period}`;
}

/** A past push's team, as the header list names it. */
export function formatTeamBoardMembers(members: ReadonlyArray<string>): string {
  return members.length === 0 ? "No subagents recorded" : members.join(", ");
}

export const TEAM_BOARD_MESSAGE_MAX = 280;
const DECISION_PREFIX = /^\/decision(?:\s+|$)/i;

/** "/decision …" posts a pinned decision; everything else is a plain message. */
export function parseTeamBoardDraft(draft: string): {
  readonly text: string;
  readonly decision: boolean;
} {
  const trimmed = draft.trim();
  if (DECISION_PREFIX.test(trimmed)) {
    return { text: trimmed.replace(DECISION_PREFIX, "").trim(), decision: true };
  }
  return { text: trimmed, decision: false };
}

export function teamBoardDraftError(draft: string): string | null {
  const { text } = parseTeamBoardDraft(draft);
  if (text.length === 0) return null;
  return text.length > TEAM_BOARD_MESSAGE_MAX
    ? `${text.length - TEAM_BOARD_MESSAGE_MAX} over ${TEAM_BOARD_MESSAGE_MAX}`
    : null;
}

/** What a post's header needs about its author, from the lead chat's own subagent records. */
export interface TeamBoardAuthorInfo {
  readonly title: string | null;
  readonly driver: OrchestrationV2Subagent["driver"] | null;
  readonly providerInstanceId: string | null;
  readonly model: string | null;
  readonly modelOptions?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
  readonly childThreadId: string | null;
}
export type TeamBoardAuthors = ReadonlyMap<string, TeamBoardAuthorInfo>;

/**
 * Authors as a string that changes only when one of their header fields does, so a client can
 * memoize the lookup on it and rows keep their props while the chat's task records churn.
 */
export type TeamBoardAuthorSource = Pick<
  OrchestrationV2Subagent,
  "id" | "title" | "driver" | "providerInstanceId" | "model" | "modelSelection" | "childThreadId"
>;
export function teamBoardAuthorsKey(subagents: ReadonlyArray<TeamBoardAuthorSource>): string {
  return JSON.stringify(
    subagents.map((task) => [
      task.id,
      task.title ?? null,
      task.driver ?? null,
      task.providerInstanceId ?? null,
      task.model ?? null,
      task.modelSelection?.options ?? null,
      task.childThreadId ?? null,
    ]),
  );
}

export function teamBoardAuthorsFromKey(key: string): TeamBoardAuthors {
  const rows = JSON.parse(key) as ReadonlyArray<
    readonly [
      string,
      string | null,
      TeamBoardAuthorInfo["driver"],
      string | null,
      string | null,
      TeamBoardAuthorInfo["modelOptions"] | null,
      string | null,
    ]
  >;
  return new Map(
    rows.map(([id, title, driver, providerInstanceId, model, modelOptions, childThreadId]) => [
      id,
      {
        title,
        driver,
        providerInstanceId,
        model,
        ...(modelOptions === null || modelOptions === undefined ? {} : { modelOptions }),
        childThreadId,
      },
    ]),
  );
}

/**
 * Who a post is from, as the lead chat's subagent rows name them: the task title, then the
 * model's short name. The lead agent and the person say so. `open` is the subagent's chat.
 */
export function teamBoardAuthorLine(
  author: TeamBoardPost["author"],
  info: TeamBoardAuthorInfo | undefined,
  modelLabel: string | null,
): { readonly name: string; readonly model: string | null; readonly open: string | null } {
  if (author.user) return { name: "You", model: null, open: null };
  if (author.taskId === undefined) return { name: "Lead", model: null, open: null };
  return {
    name: info?.title?.trim() || author.name,
    model: modelLabel === null || modelLabel === "Not reported" ? null : modelLabel,
    open: info?.childThreadId ?? null,
  };
}

export type TeamBoardMemberState = "working" | "done" | "failed";

/** One chip at the top of the board: who, what state, and what it holds. */
export interface TeamBoardRosterChip {
  readonly member: TeamBoardMember;
  readonly name: string;
  readonly state: TeamBoardMemberState;
  readonly holds: number;
}

/**
 * The board's members in the chat's own task order, so chips keep their places as members come
 * and go. A member shows once it is on the board (posts, files, presence) or is running.
 */
export function teamBoardRoster(
  members: ReadonlyArray<TeamBoardMember>,
  snapshot: TeamBoardSnapshot | null,
): ReadonlyArray<TeamBoardRosterChip> {
  if (snapshot === null) return [];
  const onBoard = new Set<string>([
    ...(snapshot.posts ?? []).flatMap(({ author }) => (author.taskId ? [author.taskId] : [])),
    ...(snapshot.files ?? []).flatMap((file) =>
      file.agents.flatMap(({ author }) => (author.taskId ? [author.taskId] : [])),
    ),
    ...snapshot.presence.map(({ taskId }) => taskId),
  ]);
  const repoMembers = snapshot.repos?.find(({ id }) => id === snapshot.pushId)?.members;
  const local = members.filter(
    (member) =>
      member.origin === "app_owned" &&
      member.remote === undefined &&
      (repoMembers === undefined || repoMembers.includes(member.id)),
  );
  const nameOf = (taskId: string) => {
    const member = local.find(({ id }) => id === taskId);
    return (
      member?.title?.trim() ||
      snapshot.posts?.find(({ author }) => author.taskId === taskId)?.author.name ||
      "Subagent"
    );
  };
  return local
    .filter(
      (member) =>
        onBoard.has(member.id) ||
        (snapshot.active && ["pending", "running", "waiting"].includes(member.status)),
    )
    .map((member) => {
      const state: TeamBoardMemberState =
        member.status === "failed" ||
        member.status === "cancelled" ||
        member.status === "interrupted"
          ? "failed"
          : member.status === "completed" || member.status === "idle"
            ? "done"
            : "working";
      return {
        member,
        name: nameOf(member.id),
        state,
        holds: snapshot.presence.find(({ taskId }) => taskId === member.id)?.files.length ?? 0,
      };
    });
}

/** "3 files" for a roster chip, or null while it holds none. */
export function teamBoardHoldsLabel(holds: number): string | null {
  return holds === 0 ? null : `${holds} ${holds === 1 ? "file" : "files"}`;
}
