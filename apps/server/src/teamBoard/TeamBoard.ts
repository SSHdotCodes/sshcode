import * as Crypto from "effect/Crypto";
import {
  TeamBoardError,
  TeamBoardFile,
  TeamBoardMessage,
  TeamBoardPost,
  TeamBoardSnapshot,
  type NodeId,
  type RunId,
  type TeamBoardPostInput,
  type TeamBoardSubscribeInput,
  type ThreadId,
} from "@t3tools/contracts";
import { SubagentsEnabled } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as TeamBoardJournal from "./TeamBoardJournal.ts";
import * as TeamBoardMailbox from "./TeamBoardMailbox.ts";
import { taskReference } from "../orchestration-v2/taskReference.ts";
import {
  boardSnapshot,
  compactBoardState,
  EMPTY_BOARD_READ,
  EMPTY_BOARD_STATE,
  emptyStats,
  foldLedger,
  jsonBytes,
  NO_BOARD_SIBLINGS,
  normalizePaths,
  pathOf,
  pathsOverlap,
  PINNED_BYTES,
  pruneLedger,
  readPosts,
  similarFinding,
  toolPost,
  NOTICE_BATCH_MS,
  PRESENCE_MS,
  TEAM_BOARD_CLAUSE,
  type BoardActor,
  type BoardConflict,
  type BoardMember,
  type BoardPair,
  type BoardReceipt,
  type BoardStats,
  type BoardTarget,
  type BoardTeam,
  type EndedMember,
  type EditState,
  type Ledger,
  type LedgerEntry,
  type OpenPush,
} from "./model.ts";

const ToolPost = Schema.Struct({
  kind: Schema.Literals(["claim", "finding", "question", "done", "release", "decision"]),
  text: TeamBoardMessage,
  files: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(10))),
  to: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(48))),
  commit: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f\d]{7,64}$/i))),
});
export const TeamBoardToolInput = Schema.Struct({
  post: Schema.optionalKey(ToolPost),
  replyTo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  repo: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(128))),
});
type TeamBoardToolInput = typeof TeamBoardToolInput.Type;

export interface BoardTeamObservation extends BoardTeam {
  readonly pushId: string;
  readonly participants: ReadonlyArray<BoardMember>;
  readonly previousEdits: ReadonlyMap<ThreadId, EditState>;
}

export type TeamBoardNotice = TeamBoardJournal.TeamBoardNotice;
type NoticeOptions = Pick<
  TeamBoardNotice,
  "from" | "late" | "guidance" | "fallbackText" | "batchAt" | "postIds"
> & { readonly user?: true; readonly crossChat?: true; readonly leadTeam?: Team };

interface Team {
  readonly leadId: ThreadId;
  readonly repo: string;
  readonly repoName: string;
  readonly cohort: string;
  readonly startedAt: number;
  members: ReadonlyArray<BoardMember>;
  pendingMembers: ReadonlyMap<NodeId, string>;
  readonly participants: Map<NodeId, BoardMember>;
  namesByThread: Record<string, string>;
  readonly finalClaims: Map<NodeId, ReadonlyArray<string>>;
  readonly edits: Map<ThreadId, EditState>;
  pairs: ReadonlyArray<BoardPair>;
  readonly noticeSeverity: Map<string, number>;
  readonly implicitNotices: Map<string, number>;
  leadGuided: boolean;
}

const takeText = (input: string, length: number) => Array.from(input).slice(0, length).join("");
const lineText = (input: string, length: number) =>
  takeText(input.replace(/\s+/gu, " ").trim(), length);
const noticeText = (prefix: string, input: string) => {
  const full = prefix + input.replace(/\s+/gu, " ").trim();
  if (Buffer.byteLength(full) <= TeamBoardMailbox.BOARD_NOTICE_BYTES)
    return { text: full, complete: true };
  let bytes = Buffer.byteLength("…");
  let offset = 0;
  for (const character of full) {
    bytes += Buffer.byteLength(character);
    if (bytes > TeamBoardMailbox.BOARD_NOTICE_BYTES) break;
    offset += character.length;
  }
  return { text: `${full.slice(0, offset)}…`, complete: false };
};
const groupKey = (leadId: ThreadId, repo: string) => `${leadId.length}:${leadId}${repo}`;
const unavailable = () =>
  new TeamBoardError({ message: "Team board needs two live subagents in the same repository." });
const sameSnapshot = Schema.toEquivalence(TeamBoardSnapshot);
const samePost = Schema.toEquivalence(TeamBoardPost);
const sameFiles = Schema.toEquivalence(Schema.Array(TeamBoardFile));
const MAX_CLAIMS_PER_RUN = 40;
const MAX_CACHED_BOARDS = 64;
const pushPosts = (ledger: Ledger, team: Team) =>
  ledger.posts.filter(({ pushId }) => pushId === team.cohort);
const pairKey = (pair: BoardPair) => [pair.a, pair.b, pair.path].join("\0");
const identifiedMember = (
  member: BoardMember,
  members: Record<string, string>,
  namesByThread: Record<string, string>,
): BoardMember => {
  let name = namesByThread[member.threadId] ?? members[member.taskId];
  if (name === undefined) {
    const used = new Set(Object.values(members).map((name) => name.toLowerCase()));
    name = member.name;
    for (let i = 2; used.has(name.toLowerCase()); i++) {
      const suffix = ` #${i}`;
      name = `${member.name.slice(0, 48 - suffix.length)}${suffix}`;
    }
  }
  members[member.taskId] = name;
  namesByThread[member.threadId] = name;
  return { ...member, name };
};

export class TeamBoard extends Context.Service<
  TeamBoard,
  {
    readonly available: (threadId: ThreadId) => boolean;
    readonly toolListed: (threadId: ThreadId) => boolean;
    readonly isSubagent: (threadId: ThreadId) => boolean;
    readonly registerSubagent: (threadId: ThreadId) => void;
    readonly tracksRepo: (leadId: ThreadId, repo: string) => boolean;
    readonly needsGuidance: (threadId: ThreadId, runId: RunId) => boolean;
    readonly queueGuidance: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
    readonly needsLeadGuidance: (threadId: ThreadId) => boolean;
    readonly queueLeadGuidance: (threadId: ThreadId, runId: RunId) => Effect.Effect<void>;
    readonly endRunNotices: (threadId: ThreadId, runId: RunId) => void;
    readonly hasNotices: (threadId: ThreadId) => boolean;
    readonly noticeIsLive: (notice: TeamBoardNotice) => boolean;
    readonly reserveNotices: (
      threadId: ThreadId,
      runId?: RunId,
    ) => TeamBoardMailbox.NoticeDelivery | undefined;
    readonly reserveSteer: (
      threadId: ThreadId,
      messageId: string,
    ) => TeamBoardMailbox.NoticeDelivery | undefined;
    readonly memberAvailable: (threadId: ThreadId) => boolean;
    readonly availabilityChanges: Stream.Stream<ReadonlyArray<ThreadId>>;
    readonly toolListChanges: Stream.Stream<ReadonlyArray<ThreadId>>;
    readonly editRefreshes: Stream.Stream<ThreadId>;
    readonly refreshAfterTool: (threadId: ThreadId) => Effect.Effect<void>;
    readonly access: (
      threadId: ThreadId,
      input: TeamBoardToolInput,
    ) => Effect.Effect<BoardReceipt, TeamBoardError>;
    readonly postUser: (input: TeamBoardPostInput) => Effect.Effect<void, TeamBoardError>;
    readonly subscribe: (
      input: TeamBoardSubscribeInput,
    ) => Stream.Stream<TeamBoardSnapshot, TeamBoardError>;
    readonly updateTeam: (team: BoardTeam) => Effect.Effect<void, TeamBoardError>;
    readonly endRun: (target: BoardTarget) => Effect.Effect<void, TeamBoardError>;
    readonly completion: (leadId: ThreadId, taskId: NodeId) => string;
    readonly activeTeams: () => ReadonlyArray<BoardTeamObservation>;
    readonly restorableRepos: ReadonlyMap<ThreadId, ReadonlySet<string>>;
    readonly recoverRepos: (leadId: ThreadId) => Effect.Effect<ReadonlySet<string>, TeamBoardError>;
    readonly observeTeam: (threadId: ThreadId) => BoardTeamObservation | undefined;
    readonly finalScan: (target: BoardTarget) => Effect.Effect<void>;
    readonly prepareChild: (leadId: ThreadId, threadId: ThreadId) => Effect.Effect<void>;
    readonly registerChildPreparation: (
      listener: (leadId: ThreadId, threadId: ThreadId) => Effect.Effect<void>,
    ) => void;
    readonly registerFinalScan: (scan: (target: BoardTarget) => Effect.Effect<void>) => void;
    readonly updateEdits: (input: {
      readonly team: BoardTeam & { readonly pushId?: string };
      readonly edits: ReadonlyMap<ThreadId, EditState>;
      readonly pairs: ReadonlyArray<BoardPair>;
    }) => Effect.Effect<void, TeamBoardError>;
    readonly claimsFor: (leadId: ThreadId) => Ledger["claims"];
    readonly notices: Stream.Stream<TeamBoardNotice>;
    readonly lateNotice: (
      notice: NonNullable<TeamBoardNotice["late"]>,
    ) => Effect.Effect<void, TeamBoardError>;
    readonly queueNotice: (
      target: BoardTarget,
      text: string,
    ) => Effect.Effect<void, TeamBoardError>;
    readonly tick: Effect.Effect<void, TeamBoardError>;
  }
>()("t3/teamBoard/TeamBoard") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const enabled = yield* SubagentsEnabled;
  let onChildPrepared: (leadId: ThreadId, threadId: ThreadId) => Effect.Effect<void> = () =>
    Effect.void;
  let scanFinal: (target: BoardTarget) => Effect.Effect<void> = () => Effect.void;
  const newId = crypto.randomUUIDv4().pipe(Effect.orDie);
  const journal = yield* TeamBoardJournal.TeamBoardJournal;
  const mailbox = yield* TeamBoardMailbox.make(journal);
  const restorableRepos = new Map(
    yield* journal.checkpointOnRestart.pipe(
      Effect.orElseSucceed(() => new Map<ThreadId, ReadonlySet<string>>()),
    ),
  );
  const knownBoards = new Set(restorableRepos.keys());
  const subagents = new Set<ThreadId>();
  const lock = yield* Semaphore.make(1);
  const ledgers = yield* Ref.make(new Map<ThreadId, Ledger>());
  const teams = new Map<string, Team>();
  const activeByLead = new Map<ThreadId, Set<Team>>();
  const leadRuns = new Map<ThreadId, RunId>();
  const activeByMember = new Map<ThreadId, Team>();
  const terminalNoticeRuns = new Map<ThreadId, RunId>();
  const completionNotes = new Map<string, string>();
  const completionKey = (leadId: ThreadId, taskId: NodeId) => `${leadId}\0${taskReference(taskId)}`;
  const trackedThreads = new Map<ThreadId, Team>();
  const endedRuns = new Set<RunId>();
  const boardChanges = yield* PubSub.sliding<ThreadId>(128);
  const availabilityChanges = yield* PubSub.sliding<ReadonlyArray<ThreadId>>(32);
  const toolListChanges = yield* PubSub.sliding<ReadonlyArray<ThreadId>>(32);
  const notices = yield* Queue.sliding<TeamBoardNotice>(512);
  const editRefreshes = yield* PubSub.sliding<ThreadId>(64);
  const expiredEdits = new Map<ThreadId, string>();
  const batches = new Map<ThreadId, { readonly runId: RunId; due: number; pending: boolean }>();
  const observe = (team: Team): BoardTeamObservation => ({
    pushId: team.cohort,
    leadId: team.leadId,
    repo: team.repo,
    repoName: team.repoName,
    members: team.members,
    participants: [...team.participants.values()],
    previousEdits: new Map(team.edits),
  });
  const activeMembers = (team: Team) =>
    team.members.filter((member) => member.runId !== undefined && !endedRuns.has(member.runId));
  const activeTeams = () =>
    [...teams.values()]
      .filter((team) => activeMembers(team).length > 0 && enabled(team.leadId))
      .map(observe);
  const teamFor = (threadId: ThreadId) =>
    activeByLead.get(threadId)?.values().next().value ?? activeByMember.get(threadId);
  const liveChoices = (leadId: ThreadId) => {
    const used = new Set<string>();
    return [...(activeByLead.get(leadId) ?? [])].map((team) => {
      const base = lineText(team.repoName, 48) || team.repo;
      let name = base;
      for (let suffix = 2; used.has(name.toLowerCase()); suffix++) name = `${base} #${suffix}`;
      used.add(name.toLowerCase());
      return { id: team.cohort, name, team };
    });
  };
  const chooseRepository = (
    choices: ReturnType<typeof liveChoices>,
    ledger: Ledger,
    input: Pick<TeamBoardToolInput, "repo" | "replyTo">,
  ) => {
    if (input.repo !== undefined) {
      const repo = input.repo.trim().toLowerCase();
      return choices.find(({ id, name }) => id === input.repo || name.toLowerCase() === repo)?.team;
    }
    if (input.replyTo !== undefined)
      return choices.find(({ id }) =>
        ledger.posts.some(({ pushId, post }) => pushId === id && post.id === input.replyTo),
      )?.team;
    return choices.length === 1 ? choices[0]?.team : undefined;
  };
  const repositoryRequired = (choices: ReturnType<typeof liveChoices>, replyTo?: string) =>
    new TeamBoardError({
      message:
        replyTo === undefined
          ? `Choose a repository: ${choices.map(({ name }) => name).join(", ")}.`
          : "That board post is no longer available.",
    });
  const available = (threadId: ThreadId) => {
    const team = teamFor(threadId);
    return (
      team !== undefined &&
      enabled(team.leadId) &&
      enabled(threadId) &&
      (team.leadId === threadId ||
        targetFor(team.members.find((member) => member.threadId === threadId)) !== undefined)
    );
  };
  const publish = (id: ThreadId) => PubSub.publish(boardChanges, id);
  const toolListed = (id: ThreadId) => subagents.has(id) || knownBoards.has(id);
  const cache = (leadId: ThreadId, ledger: Ledger) =>
    Ref.update(ledgers, (current) => {
      current.delete(leadId);
      current.set(leadId, ledger);
      if (current.size > MAX_CACHED_BOARDS) {
        for (const id of current.keys()) {
          if ([...teams.values()].some((team) => team.leadId === id)) continue;
          current.delete(id);
          break;
        }
      }
      return current;
    });
  const load = Effect.fnUntraced(function* (leadId: ThreadId, now: number) {
    const ledger = Ref.getUnsafe(ledgers).get(leadId);
    if (ledger !== undefined) return ledger;
    const saved = pruneLedger(yield* journal.load(leadId), now);
    yield* cache(leadId, saved);
    return saved;
  });
  const recoverRepos = (leadId: ThreadId) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const indexed = restorableRepos.get(leadId);
        if (indexed?.size || journal.isIndexed(leadId) || !knownBoards.has(leadId))
          return indexed ?? new Set<string>();
        // Journals created before the open-push index are read only for a lead
        // with work to resume, or when its history is explicitly opened.
        const ledger = yield* load(leadId, yield* Clock.currentTimeMillis);
        const repos = new Set(Object.values(ledger.open ?? {}).map(({ repo }) => repo));
        restorableRepos.set(leadId, repos);
        return repos;
      }),
    );
  const persist = Effect.fnUntraced(function* (
    leadId: ThreadId,
    previous: Ledger,
    entries: ReadonlyArray<LedgerEntry>,
    now: number,
  ) {
    const next = pruneLedger(entries.reduce(foldLedger, previous), now);
    yield* journal.append(leadId, entries, next);
    if (!knownBoards.has(leadId)) {
      knownBoards.add(leadId);
      yield* PubSub.publish(toolListChanges, [leadId]);
    }
    yield* cache(leadId, next);
  });
  const recordStats = (ledger: Ledger, team: Team, delta: Partial<BoardStats>): LedgerEntry => {
    const old = ledger.stats[team.cohort] ?? emptyStats;
    return {
      type: "stats",
      cohort: team.cohort,
      stats: {
        claims: old.claims + (delta.claims ?? 0),
        conflicts: old.conflicts + (delta.conflicts ?? 0),
        postsWritten: old.postsWritten + (delta.postsWritten ?? 0),
        postsRead: old.postsRead + (delta.postsRead ?? 0),
        lateNotices: old.lateNotices + (delta.lateNotices ?? 0),
      },
    };
  };
  const targetFor = (member: BoardMember | undefined): BoardTarget | undefined =>
    member?.runId === undefined || endedRuns.has(member.runId)
      ? undefined
      : { threadId: member.threadId, runId: member.runId };
  const send = Effect.fnUntraced(function* (
    target: BoardTarget,
    text: string,
    options: NoticeOptions = {},
  ) {
    const { user, crossChat, leadTeam, fallbackText, postIds, ...metadata } = options;
    const prefix = user
      ? TeamBoardMailbox.BOARD_USER_PREFIX
      : crossChat
        ? TeamBoardMailbox.BOARD_CROSS_CHAT_PREFIX
        : TeamBoardMailbox.BOARD_NOTICE_PREFIX;
    const team = leadTeam ?? activeByMember.get(target.threadId);
    if (
      team === undefined ||
      terminalNoticeRuns.get(target.threadId) === target.runId ||
      (leadTeam === undefined &&
        !activeMembers(team).some(
          ({ threadId, runId }) => threadId === target.threadId && runId === target.runId,
        ))
    )
      return;
    const formatted = noticeText(prefix, text);
    const fallback = fallbackText === undefined ? undefined : noticeText(prefix, fallbackText);
    const notice: TeamBoardNotice = {
      ...target,
      ...metadata,
      text: formatted.text,
      pushId: team.cohort,
      ...(leadTeam === undefined ? {} : { leadGuidance: true }),
      ...(fallback === undefined ? {} : { fallbackText: fallback.text }),
      ...(postIds === undefined || !formatted.complete || fallback !== undefined
        ? {}
        : { postIds }),
      id: yield* newId,
      at: yield* Clock.currentTimeMillis,
    };
    if (yield* mailbox.enqueue(notice)) yield* Queue.offer(notices, notice);
  });
  const batch = Effect.fnUntraced(function* (
    target: BoardTarget,
    text: string,
    now: number,
    options?: NoticeOptions,
  ) {
    const previous = batches.get(target.threadId);
    if (previous?.runId !== target.runId || (previous.due <= now && !previous.pending)) {
      batches.set(target.threadId, {
        runId: target.runId,
        due: now + NOTICE_BATCH_MS,
        pending: false,
      });
      yield* send(target, text, options);
      return;
    }
    if (previous.due <= now) previous.due = now + NOTICE_BATCH_MS;
    previous.pending = true;
    yield* send(target, text, { ...options, batchAt: previous.due });
  });
  const indexTeam = (team: Team) => {
    const changes: ThreadId[] = [];
    const leadTeams = activeByLead.get(team.leadId) ?? new Set<Team>();
    const leadWasActive = leadTeams.size > 0;
    if (team.members.length > 0 || team.pendingMembers.size > 0) {
      leadTeams.add(team);
      activeByLead.set(team.leadId, leadTeams);
    } else if (leadTeams.delete(team) && leadTeams.size === 0) {
      activeByLead.delete(team.leadId);
      leadRuns.delete(team.leadId);
    }
    if (leadWasActive !== leadTeams.size > 0) changes.push(team.leadId);
    const live = new Set(activeMembers(team).map(({ threadId }) => threadId));
    for (const [id, candidate] of activeByMember) {
      if (candidate === team && !live.has(id)) activeByMember.delete(id);
    }
    for (const id of live) {
      if (activeByMember.get(id) !== team) changes.push(id);
      activeByMember.set(id, team);
    }
    return changes;
  };
  const mergePlan = (team: Team, ledger: Ledger) => {
    const repoPosts = pushPosts(ledger, team).map(({ post }) => post);
    const handoffIds = [
      ...new Set(
        repoPosts.flatMap((post) =>
          post.commit && post.author.taskId ? [post.author.taskId] : [],
        ),
      ),
    ];
    const claimOwners = repoPosts.flatMap((post) =>
      post.kind === "claim" && post.files?.length && post.author.taskId ? [post.author.taskId] : [],
    );
    const order = [
      ...new Set([...handoffIds, ...claimOwners, ...team.participants.keys()]),
    ].flatMap((id) => {
      const name = team.participants.get(id)?.name ?? ledger.open?.[team.cohort]?.members[id];
      return name === undefined ? [] : [name];
    });
    const collisions = team.pairs
      .filter((pair) => pair.confirmed)
      .slice(0, 5)
      .map(
        (pair) =>
          `${team.participants.get(pair.a)?.name}/${team.participants.get(pair.b)?.name} ${pair.path}`,
      );
    const decisions = repoPosts.filter((post) => post.pinned).map((post) => post.text);
    return lineText(
      `Board merge plan: ${order.join(" → ")}.${collisions.length ? ` Conflicts: ${collisions.join(", ")}.` : ""}${decisions.length ? ` Check: ${decisions.join(" / ")}.` : ""}`,
      420,
    );
  };
  const saveCompletion = (team: Team, member: BoardMember, ledger: Ledger, last: boolean) => {
    const claims = team.finalClaims.get(member.taskId) ?? [];
    const handoffs = pushPosts(ledger, team).flatMap(({ post }) =>
      post.author.taskId === member.taskId && post.commit ? [post.commit] : [],
    );
    const overlaps = team.pairs
      .filter((pair) => pair.severity > 0 && (pair.a === member.taskId || pair.b === member.taskId))
      .map((pair) => pair.path);
    const summary =
      claims.length + handoffs.length + overlaps.length === 0
        ? ""
        : lineText(
            `Board: claims ${claims.join(", ") || "—"}; handoffs ${handoffs.join(", ") || "—"}; overlaps ${overlaps.join(", ") || "—"}.`,
            228,
          );
    const key = completionKey(team.leadId, member.taskId);
    completionNotes.delete(key);
    completionNotes.set(
      key,
      last ? [summary, mergePlan(team, ledger)].filter(Boolean).join("\n") : summary,
    );
    if (completionNotes.size > 256) {
      const oldest = completionNotes.keys().next().value;
      if (oldest !== undefined) completionNotes.delete(oldest);
    }
  };
  const endedMembers = (team: Team): ReadonlyArray<EndedMember> =>
    [...team.finalClaims].flatMap(([id, claims]) => {
      const member = team.participants.get(id);
      if (member === undefined) return [];
      const edit = team.edits.get(member.threadId);
      return [
        {
          member,
          claims,
          ...(edit === undefined ? {} : { edit: { ...edit, committed: [...edit.committed] } }),
        },
      ];
    });
  const checkpoint = (team: Team, names: OpenPush["members"]): OpenPush => ({
    repo: team.repo,
    repoName: team.repoName,
    startedAt: team.startedAt,
    members: names,
    namesByThread: team.namesByThread,
    implicitNotices: Object.fromEntries(team.implicitNotices),
    ended: endedMembers(team),
    liveEdits: [...team.members].flatMap(({ taskId, threadId }) => {
      const edit = team.edits.get(threadId);
      return edit === undefined || team.finalClaims.has(taskId)
        ? []
        : [{ threadId, edit: { ...edit, committed: [...edit.committed] } }];
    }),
    pairs: team.pairs,
  });
  const queueImplicit = Effect.fnUntraced(function* (
    team: Team,
    target: BoardTarget,
    text: string,
    now: number,
    options: NoticeOptions,
  ) {
    const count = team.implicitNotices.get(target.threadId) ?? 0;
    if (count >= 2) return;
    const ledger = yield* load(team.leadId, now);
    const open = ledger.open?.[team.cohort];
    if (open === undefined) return;
    yield* persist(
      team.leadId,
      ledger,
      [
        {
          type: "open",
          id: team.cohort,
          push: {
            ...checkpoint(team, open.members),
            implicitNotices: { ...open.implicitNotices, [target.threadId]: count + 1 },
          },
        },
      ],
      now,
    );
    team.implicitNotices.set(target.threadId, count + 1);
    yield* batch(target, text, now, options);
  });
  const archivePush = Effect.fnUntraced(function* (team: Team, ledger: Ledger, now: number) {
    yield* journal.finish(team.leadId, team.cohort, ledger.stats[team.cohort] ?? emptyStats);
    const posts = pushPosts(ledger, team);
    const retained = endedMembers(team).flatMap(({ member, claims }) => {
      const runId = member.runId;
      return runId === undefined
        ? []
        : claims.map((file) => ({
            file,
            repo: team.repo,
            post: "",
            memberId: member.taskId,
            runId,
          }));
    });
    const summary = boardSnapshot(
      {
        ledger: { ...ledger, posts, claims: retained },
        members: [...team.participants.values()],
        edits: team.edits,
        pairs: team.pairs,
        active: true,
      },
      true,
    );
    const entries: ReadonlyArray<LedgerEntry> = [
      {
        type: "archive",
        push: {
          id: team.cohort,
          repo: team.repo,
          repoName: team.repoName,
          startedAt: team.startedAt,
          endedAt: now,
          members: {
            ...ledger.open?.[team.cohort]?.members,
            ...Object.fromEntries([...team.participants].map(([id, member]) => [id, member.name])),
          },
          posts,
          files: (summary.files ?? []).slice(0, 128),
          overlapCount: summary.overlapCount,
        },
      },
      { type: "stats", cohort: team.cohort },
    ];
    return entries;
  });
  const updateTeam: TeamBoard["Service"]["updateTeam"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const key = groupKey(input.leadId, input.repo);
        const existing = teams.get(key);
        const missing = input.pendingMembers ?? new Map<NodeId, string>();
        const pending = new Map([...missing].filter(([id]) => existing?.participants.has(id)));
        if (
          existing === undefined &&
          input.members.length < 2 &&
          !restorableRepos.get(input.leadId)?.has(input.repo)
        )
          return;
        if (
          existing !== undefined &&
          existing.pendingMembers.size === pending.size &&
          [...pending].every(([id, name]) => existing.pendingMembers.get(id) === name) &&
          existing.members.length === input.members.length &&
          input.members.every((member) =>
            existing.members.some(
              (old) =>
                old.taskId === member.taskId &&
                old.runId === member.runId &&
                old.cwd === member.cwd,
            ),
          )
        )
          return;
        const now = yield* Clock.currentTimeMillis;
        const ledger = yield* load(input.leadId, now);
        const compatible = Object.entries(ledger.open ?? {}).filter(
          ([, push]) => push.repo === input.repo,
        );
        for (const [id, name] of missing)
          if (compatible.some(([, push]) => id in push.members)) pending.set(id, name);
        const recovered =
          compatible.find(
            ([, push]) =>
              input.members.some(({ taskId }) => taskId in push.members) ||
              [...pending.keys()].some((taskId) => taskId in push.members),
          ) ?? (input.members.length === 0 && pending.size === 0 ? compatible[0] : undefined);
        if (existing === undefined && input.members.length < 2 && recovered === undefined) return;
        const cohort = existing?.cohort ?? recovered?.[0] ?? `${input.repo}:${yield* newId}`;
        const startedAt = existing?.startedAt ?? recovered?.[1].startedAt ?? now;
        const names = {
          ...recovered?.[1].members,
          ...Object.fromEntries(
            Array.from(existing?.participants.values() ?? [], ({ taskId, name }) => [taskId, name]),
          ),
        };
        const restored = recovered?.[1].ended ?? [];
        const namesByThread = {
          ...Object.fromEntries(restored.map(({ member }) => [member.threadId, member.name])),
          ...recovered?.[1].namesByThread,
          ...existing?.namesByThread,
        };
        const members = input.members.map((member) =>
          identifiedMember(member, names, namesByThread),
        );
        const restoredPairs = recovered?.[1].pairs ?? [];
        const team: Team = existing ?? {
          leadId: input.leadId,
          repo: input.repo,
          repoName: input.repoName ?? recovered?.[1].repoName ?? input.repo,
          cohort,
          startedAt,
          members: [],
          pendingMembers: new Map(),
          participants: new Map(restored.map(({ member }) => [member.taskId, member])),
          namesByThread,
          finalClaims: new Map(restored.map(({ member, claims }) => [member.taskId, claims])),
          edits: new Map(
            [
              ...(recovered?.[1].liveEdits ?? []),
              ...restored.flatMap(({ member, edit }) =>
                edit === undefined ? [] : [{ threadId: member.threadId, edit }],
              ),
            ].map(({ threadId, edit }) => [
              threadId,
              { ...edit, committed: new Set(edit.committed) },
            ]),
          ),
          pairs: restoredPairs,
          noticeSeverity: new Map(
            restoredPairs
              .filter(({ severity }) => severity > 0)
              .map((pair) => [pairKey(pair), pair.severity]),
          ),
          leadGuided: false,
          implicitNotices: new Map(Object.entries(recovered?.[1].implicitNotices ?? {})),
        };
        const departed = team.members.filter(
          (member) => !members.some((current) => current.taskId === member.taskId),
        );
        const currentRuns = new Map(members.map((member) => [member.taskId, member]));
        const kept = ledger.claims.flatMap((claim) => {
          if (claim.repo !== team.repo) return [claim];
          const current = currentRuns.get(claim.memberId);
          if (current === undefined && pending.has(claim.memberId)) return [claim];
          if (current?.runId === claim.runId) return [claim];
          return current?.runId !== undefined && current.resumedFrom?.includes(claim.runId)
            ? [{ ...claim, runId: current.runId }]
            : [];
        });
        const entries: LedgerEntry[] =
          kept.length === ledger.claims.length &&
          kept.every((claim, index) => claim === ledger.claims[index])
            ? []
            : [{ type: "claims", claims: kept }];
        if (existing === undefined) {
          for (const [id, stale] of compatible) {
            if (id === cohort) continue;
            const posts = ledger.posts.filter(({ pushId }) => pushId === id);
            entries.push(
              {
                type: "archive",
                push: {
                  repo: stale.repo,
                  startedAt: stale.startedAt,
                  members: stale.members,
                  id,
                  endedAt: now,
                  posts,
                  files: [],
                  overlapCount: new Set(
                    posts.flatMap(({ post }) =>
                      post.conflict ? [pathOf(post.conflict.file)] : [],
                    ),
                  ).size,
                },
              },
              { type: "stats", cohort: id },
            );
          }
        }
        if (existing === undefined && ledger.stats[cohort] === undefined)
          entries.push({ type: "stats", cohort, stats: emptyStats });
        for (const member of departed) {
          if (!team.finalClaims.has(member.taskId))
            team.finalClaims.set(
              member.taskId,
              ledger.claims
                .filter((claim) => claim.memberId === member.taskId)
                .map(({ file }) => file),
            );
        }
        const closed = members.length === 0 && pending.size === 0;
        if (!closed)
          entries.push({
            type: "open",
            id: cohort,
            push: { ...checkpoint(team, names), namesByThread },
          });
        if (closed) entries.push(...(yield* archivePush(team, ledger, now)));
        yield* persist(input.leadId, ledger, entries, now);
        for (const member of members) {
          subagents.add(member.threadId);
          const prior = team.participants.get(member.taskId);
          if (prior?.runId !== undefined && prior.runId !== member.runId) {
            endedRuns.delete(prior.runId);
            if (terminalNoticeRuns.get(member.threadId) === prior.runId)
              terminalNoticeRuns.delete(member.threadId);
          }
          team.participants.set(member.taskId, member);
          trackedThreads.set(member.threadId, team);
        }
        team.members = members;
        team.namesByThread = namesByThread;
        team.pendingMembers = pending;
        for (const member of departed) {
          if (member.runId) endedRuns.delete(member.runId);
          if (terminalNoticeRuns.get(member.threadId) === member.runId)
            terminalNoticeRuns.delete(member.threadId);
          if (!members.some((current) => current.threadId === member.threadId))
            trackedThreads.delete(member.threadId);
          expiredEdits.delete(member.threadId);
          if (
            !pending.has(member.taskId) &&
            !completionNotes.has(completionKey(team.leadId, member.taskId))
          )
            saveCompletion(team, member, ledger, false);
        }
        if (closed) teams.delete(key);
        else teams.set(key, team);
        const changed = indexTeam(team);
        if (existing === undefined && !closed && !changed.includes(team.leadId))
          changed.push(team.leadId);
        if (changed.length > 0) yield* PubSub.publish(availabilityChanges, changed);
        yield* publish(input.leadId);
      }).pipe(Effect.uninterruptible),
    );

  const endRun: TeamBoard["Service"]["endRun"] = (target) => {
    if (!trackedThreads.has(target.threadId)) return Effect.void;
    return lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const team = trackedThreads.get(target.threadId);
        const member = team?.members.find(
          (item) => item.threadId === target.threadId && item.runId === target.runId,
        );
        if (team !== undefined && member !== undefined && !endedRuns.has(target.runId)) {
          const ledger = yield* load(team.leadId, now);
          const held = ledger.claims
            .filter((claim) => claim.runId === target.runId)
            .map(({ file }) => file);
          const claims = ledger.claims.filter((claim) => claim.runId !== target.runId);
          const claimed = pushPosts(ledger, team).flatMap(({ post }) =>
            post.author.taskId === member.taskId && post.kind === "claim" ? (post.files ?? []) : [],
          );
          team.finalClaims.set(member.taskId, [...new Set([...held, ...claimed])]);
          const last =
            team.pendingMembers.size === 0 &&
            team.members.every(
              (item) =>
                item.runId === target.runId ||
                (item.runId !== undefined && endedRuns.has(item.runId)),
            );
          const entries: LedgerEntry[] = held.length > 0 ? [{ type: "claims", claims }] : [];
          const open = ledger.open?.[team.cohort];
          if (last) entries.push(...(yield* archivePush(team, ledger, now)));
          else if (open !== undefined)
            entries.push({
              type: "open",
              id: team.cohort,
              push: checkpoint(team, open.members),
            });
          yield* persist(team.leadId, ledger, entries, now);
          endedRuns.add(target.runId);
          if (last) {
            for (const { threadId, runId } of team.members) {
              trackedThreads.delete(threadId);
              expiredEdits.delete(threadId);
              if (runId !== undefined) endedRuns.delete(runId);
            }
            team.members = [];
            teams.delete(groupKey(team.leadId, team.repo));
          }
          const changed = indexTeam(team);
          if (terminalNoticeRuns.get(target.threadId) === target.runId)
            terminalNoticeRuns.delete(target.threadId);
          if (changed.length > 0) yield* PubSub.publish(availabilityChanges, changed);
          saveCompletion(team, member, ledger, last);
          yield* publish(team.leadId);
        }
      }).pipe(Effect.uninterruptible),
    );
  };

  const execute = Effect.fnUntraced(function* (
    team: Team,
    actor: BoardActor,
    input: TeamBoardToolInput,
    now: number,
    user?: TeamBoardPostInput,
  ) {
    const ledger = yield* load(actor.leadId, now);
    const repoPosts = pushPosts(ledger, team).map(({ post }) => post);
    const reader = `${team.cohort}:${actor.author.taskId ?? "lead"}`;
    const entries: LedgerEntry[] = [];
    const requested = input.post;
    let conflicts: BoardConflict[] = [];
    const conflictRecipients = new Map<NodeId, BoardConflict>();
    let duplicate: string | undefined;
    let claimCount = 0;
    let write: TeamBoardPost | undefined;
    let claimFiles: ReadonlyArray<string> | undefined;
    if (requested !== undefined || user !== undefined) {
      const files = normalizePaths(requested?.files ?? []);
      if (files === undefined)
        return yield* new TeamBoardError({
          message: "Use up to ten short repository-relative paths or path#symbol values.",
        });
      const kind = user === undefined ? requested!.kind : user.decision ? "decision" : "message";
      const parent =
        input.replyTo === undefined
          ? undefined
          : repoPosts.find((post) => post.id === input.replyTo);
      if (input.replyTo !== undefined && parent === undefined)
        return yield* new TeamBoardError({ message: "That board post is no longer available." });
      const memberId = actor.author.taskId;
      const hasRun = memberId !== undefined && actor.runId !== undefined;
      if (
        (kind === "claim" || kind === "release") &&
        (!hasRun || (kind === "claim" && files.length === 0))
      )
        return yield* new TeamBoardError({
          message:
            "Only a running subagent can claim or release files. Claims need at least one file or symbol.",
        });
      if (requested?.commit !== undefined && kind !== "done")
        return yield* new TeamBoardError({ message: "Only a done post can carry a commit." });
      const postId = (yield* newId).replaceAll("-", "").slice(0, 16);
      const own = ledger.claims.filter(
        (claim) => claim.memberId === memberId && claim.runId === actor.runId,
      );
      if (
        kind === "decision" &&
        hasRun &&
        (files.length === 0 ||
          !files.every((file) =>
            own.some((claim) =>
              claim.file === pathOf(claim.file) ? pathOf(file) === claim.file : claim.file === file,
            ),
          ))
      )
        return yield* new TeamBoardError({
          message: "A subagent can pin a decision about files or symbols it currently claims.",
        });
      const blocked =
        kind === "claim"
          ? ledger.claims.flatMap((claim) => {
              if (claim.memberId === memberId || claim.repo !== team.repo) return [];
              const pendingName = team.pendingMembers.get(claim.memberId);
              const owner =
                team.participants.get(claim.memberId) ??
                (pendingName === undefined
                  ? undefined
                  : { taskId: claim.memberId, name: pendingName });
              return owner === undefined
                ? []
                : files
                    .filter((file) => pathsOverlap(file, claim.file))
                    .map((file) => ({ file, claim, owner }));
            })
          : [];
      conflicts = blocked.map(({ file, claim, owner }) => {
        const conflict = { file, owner: owner.name, claim: claim.post };
        if (!conflictRecipients.has(owner.taskId)) conflictRecipients.set(owner.taskId, conflict);
        return conflict;
      });
      const first = blocked[0];
      const granted =
        kind === "claim"
          ? files.filter((file) => !blocked.some((denied) => denied.file === file))
          : files;
      const text = user?.text ?? requested!.text;
      const to = requested?.to?.replace(/\p{Cc}/gu, "").trim();
      write = {
        id: postId,
        author: actor.author,
        kind,
        text,
        at: DateTime.makeUnsafe(now),
        ...(granted.length === 0 ? {} : { files: granted }),
        ...(to ? { to } : {}),
        ...(parent === undefined ? {} : { replyTo: parent.id }),
        ...(requested?.commit === undefined ? {} : { commit: requested.commit }),
        ...(kind === "decision" ? { pinned: true } : {}),
        ...(first === undefined
          ? {}
          : {
              conflict: {
                file: first.file,
                owner: { name: first.owner.name, taskId: first.owner.taskId },
              },
            }),
      };
      const replaces = kind === "decision" && parent?.pinned ? parent.id : undefined;
      if (kind === "decision") {
        const pins = repoPosts.filter((post) => post.pinned && post.id !== replaces);
        if (jsonBytes([...pins, write].map(toolPost)) > PINNED_BYTES)
          return yield* new TeamBoardError({
            message: "Pinned decisions are full. Reply to one with an updated decision.",
          });
      }
      if (kind === "claim") claimFiles = files;
      if (kind === "finding") {
        const repeat = repoPosts.find(
          (post) =>
            post.kind === "finding" &&
            post.author.taskId !== memberId &&
            post.files?.some((a) => files.some((b) => pathsOverlap(a, b))) &&
            similarFinding(post.text, text),
        );
        if (repeat)
          duplicate = `Looks like ${repeat.author.name}'s finding: ${lineText(repeat.text, 100)}`;
      }
      if (kind === "claim" && first !== undefined && files.length > 1) {
        const denied = [
          ...new Set(
            conflicts.map(({ file, owner, claim }) => `${file} (${owner} holds it: ${claim})`),
          ),
        ];
        duplicate = `Claimed ${granted.length === 0 ? "none" : granted.join(", ")}. Not granted: ${denied.join(", ")}.`;
      }
      let claims = ledger.claims;
      if (kind === "claim" && memberId !== undefined && actor.runId !== undefined) {
        const additions = granted.filter((file) => !own.some((claim) => claim.file === file));
        if (own.length + additions.length > MAX_CLAIMS_PER_RUN)
          return yield* new TeamBoardError({ message: "Release some files before claiming more." });
        const runId = actor.runId;
        claims = [
          ...claims,
          ...additions.map((file) => ({ repo: actor.repo, file, memberId, runId, post: postId })),
        ];
        claimCount = additions.length;
      } else if ((kind === "done" || kind === "release") && hasRun) {
        claims = claims.filter(
          (claim) =>
            claim.memberId !== memberId ||
            claim.runId !== actor.runId ||
            (kind === "release" &&
              files.length > 0 &&
              !files.some((file) => pathsOverlap(file, claim.file))),
        );
      }
      entries.push({
        type: "post",
        stored: {
          repo: actor.repo,
          pushId: team.cohort,
          post: write,
          ...(replaces === undefined ? {} : { replaces }),
          ...(user?.clientRequestId === undefined ? {} : { requestId: user.clientRequestId }),
        },
        claims,
      });
    }
    const readerFiles = [
      ...ledger.claims
        .filter((claim) => claim.memberId === actor.author.taskId)
        .map(({ file }) => file),
      ...(write?.files ?? []),
    ];
    const previousRead = new Set(ledger.reads[reader]);
    const {
      result: receipt,
      delivered,
      completed,
    } = readPosts({
      actor,
      posts: write?.pinned
        ? [
            ...repoPosts.filter(
              (post) => post.id !== entries.find((entry) => entry.type === "post")?.stored.replaces,
            ),
            write,
          ]
        : repoPosts,
      read: previousRead,
      files: readerFiles,
      ...(claimFiles === undefined ? {} : { claimFiles }),
      conflicts,
      ...(requested?.kind === "claim" && conflicts.length > 0 && (requested.files?.length ?? 0) > 1
        ? { claimed: write?.files ?? [] }
        : {}),
      ...(duplicate === undefined ? {} : { notice: duplicate }),
    });
    const result =
      requested === undefined &&
      user === undefined &&
      receipt.posts.length === 0 &&
      receipt.more === undefined
        ? { ...receipt, notice: EMPTY_BOARD_READ }
        : receipt;
    if (user === undefined && delivered.length > 0)
      entries.push({ type: "read", reader, read: [...previousRead, ...delivered] });
    if (write || (delivered.length > 0 && user === undefined))
      entries.push(
        recordStats(ledger, team, {
          claims: claimCount,
          conflicts: conflicts.length,
          postsWritten: write ? 1 : 0,
          postsRead: user === undefined ? completed : 0,
        }),
      );
    if (entries.length > 0) yield* persist(actor.leadId, ledger, entries, now);
    if (write === undefined) return result;
    yield* publish(actor.leadId);
    const currentPost = write;
    const replyAuthor = repoPosts.find((post) => post.id === input.replyTo)?.author;
    const replyThreadId =
      replyAuthor?.taskId === undefined
        ? undefined
        : team.participants.get(replyAuthor.taskId)?.threadId;
    const fromLead = actor.author.taskId === undefined;
    for (const member of team.members) {
      const target = targetFor(member);
      if (target === undefined || member.taskId === actor.author.taskId) continue;
      const conflict = conflictRecipients.get(member.taskId);
      if (conflict)
        yield* send(target, `${actor.author.name} also wants ${conflict.file}.`, {
          late: { leadId: actor.leadId, repo: actor.repo, file: pathOf(conflict.file) },
        });
      if (user !== undefined) {
        yield* send(target, user.text, { user: true, postIds: [currentPost.id] });
        continue;
      }
      const relevantHandoff =
        currentPost.commit &&
        currentPost.files?.some(
          (file) =>
            ledger.claims.some(
              (claim) => claim.memberId === member.taskId && pathsOverlap(file, claim.file),
            ) || team.edits.get(member.threadId)?.files.some((edit) => edit.path === pathOf(file)),
        );
      if (relevantHandoff) {
        yield* batch(
          target,
          `${actor.author.name} fixed ${lineText(currentPost.text, 120)} in ${currentPost.commit} (${currentPost.files?.join(", ")}); merge it instead of redoing it.`,
          now,
          {
            from:
              team.members.find(({ taskId }) => taskId === actor.author.taskId)?.threadId ??
              team.leadId,
            fallbackText: `${actor.author.name} handed off ${currentPost.commit} (${currentPost.files?.join(", ")}).`,
          },
        );
      } else if (
        currentPost.pinned ||
        fromLead ||
        currentPost.to?.toLowerCase() === member.name.toLowerCase() ||
        replyAuthor?.taskId === member.taskId ||
        replyThreadId === member.threadId
      ) {
        const verb = currentPost.pinned
          ? "pinned a decision"
          : currentPost.kind === "question"
            ? "asked you"
            : input.replyTo !== undefined
              ? "replied"
              : "posted";
        const files = currentPost.files?.join(", ");
        const commit = currentPost.commit === undefined ? "" : ` in ${currentPost.commit}`;
        yield* batch(
          target,
          `${actor.author.name} ${verb}${files === undefined ? "" : ` about ${files}`}${commit} (reply ${currentPost.id}). ${currentPost.text}`,
          now,
          { postIds: [currentPost.id] },
        );
      }
    }
    return result;
  });

  const noActiveBoard = (id: ThreadId) =>
    toolListed(id) && enabled(id)
      ? Effect.succeed({ posts: [], notice: NO_BOARD_SIBLINGS })
      : Effect.fail(unavailable());
  const readLeadBoards = Effect.fnUntraced(function* (
    choices: ReturnType<typeof liveChoices>,
    ledger: Ledger,
    now: number,
  ) {
    const repos = new Map<string, string>();
    const postsByPush = new Map<string, Set<string>>();
    const previous = new Set<string>();
    const posts = choices.flatMap(({ team, name }) => {
      const posts = pushPosts(ledger, team).map(({ post }) => post);
      for (const post of posts) repos.set(post.id, name);
      postsByPush.set(team.cohort, new Set(posts.map(({ id }) => id)));
      for (const id of ledger.reads[`${team.cohort}:lead`] ?? []) previous.add(id);
      return posts;
    });
    const leadId = choices[0]!.team.leadId;
    const { result, delivered } = readPosts({
      posts,
      actor: { leadId, repo: "", author: { name: "Lead" } },
      read: previous,
      repos,
      conflicts: [],
      files: [],
    });
    const entries: LedgerEntry[] = [];
    for (const { team } of choices) {
      const ids = postsByPush.get(team.cohort)!;
      const read = delivered.filter((id) => ids.has(id.split("/", 1)[0]!));
      if (read.length === 0) continue;
      const reader = `${team.cohort}:lead`;
      entries.push(
        { type: "read", reader, read: [...(ledger.reads[reader] ?? []), ...read] },
        recordStats(ledger, team, { postsRead: read.filter((id) => ids.has(id)).length }),
      );
    }
    if (entries.length > 0) yield* persist(leadId, ledger, entries, now);
    return result.posts.length === 0 && result.more === undefined
      ? { ...result, notice: EMPTY_BOARD_READ }
      : result;
  });
  const access: TeamBoard["Service"]["access"] = (threadId, input) =>
    Effect.suspend(() =>
      !available(threadId)
        ? noActiveBoard(threadId)
        : lock.withPermits(1)(
            Effect.gen(function* () {
              let team = teamFor(threadId);
              if (team === undefined || !enabled(team.leadId) || !enabled(threadId))
                return yield* noActiveBoard(threadId);
              const now = yield* Clock.currentTimeMillis;
              if (team.leadId === threadId) {
                const choices = liveChoices(threadId);
                if (choices.length > 1 || (input.post !== undefined && input.repo !== undefined)) {
                  const ledger = yield* load(threadId, now);
                  if (input.post === undefined) return yield* readLeadBoards(choices, ledger, now);
                  const chosen = chooseRepository(choices, ledger, input);
                  if (chosen === undefined)
                    return yield* repositoryRequired(choices, input.replyTo);
                  team = chosen;
                }
              }
              const member = team.members.find((candidate) => candidate.threadId === threadId);
              if (team.leadId !== threadId && targetFor(member) === undefined)
                return yield* unavailable();
              const author =
                member === undefined
                  ? { name: "Lead" }
                  : { name: member.name, taskId: member.taskId };
              return yield* execute(
                team,
                {
                  leadId: team.leadId,
                  repo: team.repo,
                  author,
                  ...(member?.runId === undefined ? {} : { runId: member.runId }),
                },
                input,
                now,
              );
            }).pipe(Effect.uninterruptible),
          ),
    );

  const postUser: TeamBoard["Service"]["postUser"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const choices = liveChoices(input.threadId);
        if (choices.length === 0 || !enabled(input.threadId)) return yield* unavailable();
        const now = yield* Clock.currentTimeMillis;
        const ledger = yield* load(input.threadId, now);
        const team = chooseRepository(choices, ledger, input);
        if (team === undefined) return yield* repositoryRequired(choices, input.replyTo);
        if (
          input.clientRequestId !== undefined &&
          ledger.posts.some(
            (item) => item.pushId === team.cohort && item.requestId === input.clientRequestId,
          )
        )
          return;
        yield* execute(
          team,
          { leadId: input.threadId, repo: team.repo, author: { name: "User", user: true } },
          input.replyTo === undefined ? {} : { replyTo: input.replyTo },
          now,
          input,
        );
      }).pipe(Effect.uninterruptible),
    );

  const liveSnapshot = (active: Team, ledger: Ledger, now: number, details: boolean) => {
    const live = new Set(activeMembers(active).map(({ taskId }) => taskId));
    const retainedClaims = [...active.finalClaims].flatMap(([taskId, files]) => {
      const runId = active.participants.get(taskId)?.runId;
      return live.has(taskId) || runId === undefined
        ? []
        : files.map((file) => ({
            file,
            memberId: taskId,
            runId,
            repo: active.repo,
            post: "",
          }));
    });
    return boardSnapshot(
      {
        ledger: {
          ...ledger,
          posts: pushPosts(ledger, active),
          claims: [...ledger.claims.filter(({ repo }) => repo === active.repo), ...retainedClaims],
        },
        members: [...active.participants.values()],
        edits: active.edits,
        pairs: active.pairs,
        active: true,
        presenceMembers: live,
        presenceCutoff: now - PRESENCE_MS,
      },
      details,
    );
  };
  const snapshot = Effect.fnUntraced(function* (
    input: TeamBoardSubscribeInput,
  ): Effect.fn.Return<TeamBoardSnapshot | undefined, TeamBoardError> {
    const choices = enabled(input.threadId) ? liveChoices(input.threadId) : [];
    const active = choices.find(
      ({ id }) => input.pushId === undefined || input.pushId === id,
    )?.team;
    if (active === undefined && !knownBoards.has(input.threadId)) return undefined;
    if (active === undefined && input.presenceOnly)
      return { active: false, postCount: 0, overlapCount: 0, presence: [] };
    const now = yield* Clock.currentTimeMillis;
    const ledger = pruneLedger(yield* load(input.threadId, now), now);
    const legacy = ledger.closed;
    const legacyPosts = ledger.posts.filter(({ pushId }) => pushId === undefined);
    const archives = [
      ...(legacy === undefined
        ? []
        : [
            {
              id: `legacy:${legacy.at}`,
              startedAt: legacy.at,
              endedAt: legacy.at,
              posts: legacyPosts,
              members: Object.fromEntries(
                legacyPosts.flatMap(({ post }) =>
                  post.author.taskId === undefined ? [] : [[post.author.taskId, post.author.name]],
                ),
              ),
              files: legacy.files,
              overlapCount: legacy.files.filter((file) => file.willConflict).length,
            },
          ]),
      ...(ledger.history ?? []),
    ];
    const ordered = archives.toReversed();
    const before =
      input.historyBefore === undefined
        ? -1
        : ordered.findIndex(({ id }) => id === input.historyBefore);
    const from = before + 1;
    const history =
      input.historyBefore !== undefined && before < 0
        ? []
        : ordered.slice(from, from + 10).map((push) => ({
            id: push.id,
            startedAt: DateTime.makeUnsafe(push.startedAt),
            endedAt: DateTime.makeUnsafe(push.endedAt),
            members: [...new Set(Object.values(push.members))],
            postCount: push.posts.length,
            overlapCount: push.overlapCount,
          }));
    const historyPage = {
      history,
      ...(history.length > 0 && ordered.length > from + history.length
        ? { historyHasMore: true }
        : {}),
    };
    if (active === undefined) {
      const closed =
        input.pushId === undefined
          ? archives.at(-1)
          : archives.find(({ id }) => id === input.pushId);
      if (closed === undefined)
        return input.pushId !== undefined
          ? undefined
          : {
              active: false,
              postCount: 0,
              overlapCount: 0,
              presence: [],
              ...historyPage,
            };
      const latest = closed.posts.at(-1)?.post.id;
      return {
        active: false,
        pushId: closed.id,
        postCount: closed.posts.length,
        overlapCount: closed.overlapCount,
        presence: [],
        ...(latest === undefined ? {} : { latestPostId: latest }),
        ...(input.details
          ? { posts: closed.posts.toReversed().map(({ post }) => post), files: closed.files }
          : historyPage),
      };
    }
    if (input.presenceOnly) {
      return {
        active: true,
        ...(choices.length === 1 ? { pushId: active.cohort } : {}),
        postCount: 0,
        overlapCount: 0,
        presence: choices.flatMap(({ team }) => liveSnapshot(team, ledger, now, false).presence),
      };
    }
    const state = liveSnapshot(active, ledger, now, input.details === true);
    const repos = choices.length < 2 ? undefined : choices.map(({ id, name }) => ({ id, name }));
    if (!input.details && input.pushId === undefined && choices.length > 1) {
      const boards = choices.map(({ team }) =>
        team === active ? state : liveSnapshot(team, ledger, now, false),
      );
      const activeIds = new Set(choices.map(({ id }) => id));
      const latest = ledger.posts.findLast(
        ({ pushId }) => pushId !== undefined && activeIds.has(pushId),
      );
      return {
        active: true,
        postCount: boards.reduce((sum, board) => sum + board.postCount, 0),
        overlapCount: boards.reduce((sum, board) => sum + board.overlapCount, 0),
        presence: input.delta ? [] : boards.flatMap((board) => board.presence),
        ...(latest === undefined ? {} : { latestPostId: latest.post.id }),
        ...(repos === undefined ? {} : { repos }),
        ...historyPage,
      };
    }
    return {
      ...state,
      pushId: active.cohort,
      ...(repos === undefined ? {} : { repos }),
      ...(input.delta ? { presence: [] } : {}),
      ...(!input.details ? historyPage : {}),
    };
  });
  const subscribe: TeamBoard["Service"]["subscribe"] = (input) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const changes = yield* PubSub.subscribe(boardChanges);
        let previous: TeamBoardSnapshot | undefined;
        return Stream.concat(Stream.make(input.threadId), Stream.fromSubscription(changes)).pipe(
          Stream.filter((id) => id === input.threadId),
          Stream.mapEffect(() => lock.withPermits(1)(snapshot(input))),
          Stream.filter((state): state is TeamBoardSnapshot => state !== undefined),
          Stream.changesWith(sameSnapshot),
          Stream.map((state) => {
            const before = previous;
            previous = state;
            if (!input.delta || !input.details || !before || before.pushId !== state.pushId)
              return state;
            const { posts, files, ...summary } = state;
            const prior = new Map(before.posts?.map((post) => [post.id, post]));
            const changed = (posts ?? []).filter((post) => {
              const old = prior.get(post.id);
              prior.delete(post.id);
              return old === undefined || (post !== old && !samePost(post, old));
            });
            return {
              ...summary,
              delta: true,
              ...(changed.length === 0 ? {} : { posts: changed }),
              ...(prior.size === 0 ? {} : { removedPostIds: [...prior.keys()] }),
              ...(files === undefined || sameFiles(before.files ?? [], files) ? {} : { files }),
            };
          }),
        );
      }),
    );

  const updateEdits: TeamBoard["Service"]["updateEdits"] = ({ team: input, edits, pairs }) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const team = teams.get(groupKey(input.leadId, input.repo));
        if (team === undefined || (input.pushId !== undefined && input.pushId !== team.cohort))
          return;
        team.pairs = pairs;
        for (const { threadId } of team.members)
          if (!edits.has(threadId)) team.edits.delete(threadId);
        for (const [threadId, edit] of edits) team.edits.set(threadId, edit);
        for (const pair of pairs) {
          if (pair.confirmed === false) continue;
          const key = pairKey(pair);
          if (pair.severity <= (team.noticeSeverity.get(key) ?? 0)) continue;
          if (!team.noticeSeverity.has(key) && team.noticeSeverity.size >= 2_048) continue;
          team.noticeSeverity.set(key, pair.severity);
          const left = team.participants.get(pair.a);
          const right = team.participants.get(pair.b);
          if (left === undefined || right === undefined) continue;
          for (const [recipient, other] of [
            [left, right],
            [right, left],
          ] as const) {
            const target = targetFor(
              team.members.find((member) => member.taskId === recipient.taskId),
            );
            if (target === undefined) continue;
            const range = team.edits
              .get(other.threadId)
              ?.files.find((edit) => edit.path === pair.path)?.ranges[0];
            const location = `${pair.path}${range === undefined ? "" : ` (lines ${range.start}–${range.end})`}`;
            const description =
              pair.confirmed === true
                ? `will conflict in ${pair.path}`
                : `is also changing ${location}`;
            yield* queueImplicit(
              team,
              target,
              `${other.name} ${description}. Coordinate before continuing.`,
              yield* Clock.currentTimeMillis,
              {
                late: { leadId: team.leadId, repo: team.repo, file: pair.path },
              },
            );
          }
        }
        yield* publish(team.leadId);
      }),
    );

  let lastPrune = 0;
  const tick = lock.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      for (const [threadId, batch] of batches) {
        if (batch.due > now) continue;
        if (!batch.pending) {
          batches.delete(threadId);
          continue;
        }
        batch.pending = false;
        batch.due = now + NOTICE_BATCH_MS;
      }
      for (const notice of mailbox.due(now)) yield* Queue.offer(notices, notice);
      yield* mailbox.flushRemoved;
      for (const team of teams.values()) {
        let expired = false;
        for (const [threadId, edit] of team.edits) {
          if (edit.changedAt > now - PRESENCE_MS || edit.files.length === 0) continue;
          if (expiredEdits.get(threadId) === edit.signature) continue;
          expiredEdits.set(threadId, edit.signature);
          expired = true;
        }
        if (expired) yield* publish(team.leadId);
      }
      if (now - lastPrune >= 24 * 60 * 60_000) {
        yield* journal.sweep(new Set([...teams.values()].map((team) => team.leadId)));
        yield* mailbox.prune;
        lastPrune = now;
      }
    }),
  );

  const needsGuidance = (threadId: ThreadId, runId: RunId) =>
    activeByMember.has(threadId) &&
    available(threadId) &&
    !mailbox.usedGuidance.has(runId) &&
    !endedRuns.has(runId);
  const kickoffState = (team: Team) => {
    const ledger = Ref.getUnsafe(ledgers).get(team.leadId);
    if (ledger === undefined) return EMPTY_BOARD_STATE;
    const posts = pushPosts(ledger, team).map(({ post }) => post);
    const claims = ledger.claims.filter(({ repo }) => repo === team.repo);
    if (posts.length === 0 && claims.length === 0) return EMPTY_BOARD_STATE;
    const pinned = posts
      .filter(({ pinned }) => pinned)
      .map(({ author, text }) => `${author.name}: ${lineText(text, 280)}`);
    const namedClaims = claims.map(
      ({ file, memberId }) =>
        `${team.participants.get(memberId)?.name ?? team.pendingMembers.get(memberId) ?? "Sibling"} holds ${file}`,
    );
    const remaining =
      TeamBoardMailbox.BOARD_NOTICE_BYTES -
      Buffer.byteLength(`${TeamBoardMailbox.BOARD_NOTICE_PREFIX}${TEAM_BOARD_CLAUSE}  `);
    const pinnedBudget = Math.floor(remaining * 0.58);
    return (
      [
        compactBoardState("Pinned decisions", pinned, pinnedBudget),
        compactBoardState("Live claims", namedClaims, remaining - pinnedBudget),
      ]
        .filter(Boolean)
        .join(" ") || "No live claims or pinned decisions."
    );
  };
  const lateNotice = (notice: NonNullable<TeamBoardNotice["late"]>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const team = teams.get(groupKey(notice.leadId, notice.repo));
        if (team === undefined) return;
        const now = yield* Clock.currentTimeMillis;
        const ledger = yield* load(notice.leadId, now);
        yield* persist(notice.leadId, ledger, [recordStats(ledger, team, { lateNotices: 1 })], now);
      }),
    );
  const markDeliveredPosts = (notices: ReadonlyArray<TeamBoardNotice>) => {
    const destination = notices[0]?.threadId;
    if (destination === undefined || !notices.some(({ postIds }) => postIds?.length))
      return Effect.void;
    return lock
      .withPermits(1)(
        Effect.gen(function* () {
          const team = activeByMember.get(destination);
          const member = team?.members.find(({ threadId }) => threadId === destination);
          if (team === undefined || member === undefined) return;
          const ids = new Set(
            notices.flatMap(({ postIds, pushId }) =>
              pushId === team.cohort ? (postIds ?? []) : [],
            ),
          );
          if (ids.size === 0) return;
          const now = yield* Clock.currentTimeMillis;
          const ledger = yield* load(team.leadId, now);
          const reader = `${team.cohort}:${member.taskId}`;
          const previous = new Set(ledger.reads[reader]);
          const seen = pushPosts(ledger, team).flatMap(({ post }) =>
            !post.pinned && ids.has(post.id) && !previous.has(post.id) ? [post.id] : [],
          );
          if (seen.length === 0) return;
          yield* persist(
            team.leadId,
            ledger,
            [
              { type: "read", reader, read: [...previous, ...seen] },
              recordStats(ledger, team, { postsRead: seen.length }),
            ],
            now,
          );
        }),
      )
      .pipe(Effect.catch(() => Effect.logWarning("Could not record delivered team board posts")));
  };
  const trackDelivery = (
    delivery: TeamBoardMailbox.NoticeDelivery | undefined,
  ): TeamBoardMailbox.NoticeDelivery | undefined =>
    delivery === undefined
      ? undefined
      : {
          ...delivery,
          finish: (accepted) =>
            Effect.gen(function* () {
              yield* delivery.finish(accepted);
              if (!accepted) return;
              yield* markDeliveredPosts(delivery.notices);
              for (const { late, threadId, pushId, leadGuidance } of delivery.notices) {
                if (leadGuidance) {
                  for (const live of activeByLead.get(threadId) ?? [])
                    if (live.cohort === pushId) live.leadGuided = true;
                }
                const team = teamFor(threadId);
                if (
                  late !== undefined &&
                  team?.cohort === pushId &&
                  team?.edits.get(threadId)?.committed.has(late.file)
                )
                  yield* lateNotice(late).pipe(
                    Effect.catch(() =>
                      Effect.logWarning("Could not record team board delivery statistics"),
                    ),
                  );
              }
            }),
        };
  const noticeIsLive = (notice: TeamBoardNotice) => {
    if (terminalNoticeRuns.get(notice.threadId) === notice.runId) return false;
    if (notice.leadGuidance)
      return (
        enabled(notice.threadId) &&
        leadRuns.get(notice.threadId) === notice.runId &&
        [...(activeByLead.get(notice.threadId) ?? [])].some((team) => team.cohort === notice.pushId)
      );
    const team = activeByMember.get(notice.threadId);
    return (
      team !== undefined &&
      team.cohort === notice.pushId &&
      enabled(team.leadId) &&
      enabled(notice.threadId) &&
      activeMembers(team).some(
        (member) => member.threadId === notice.threadId && member.runId === notice.runId,
      )
    );
  };
  const needsLeadGuidance = (threadId: ThreadId) => {
    const groups = activeByLead.get(threadId);
    if (groups === undefined || !enabled(threadId)) return false;
    for (const team of groups) if (!team.leadGuided) return true;
    return false;
  };
  return TeamBoard.of({
    available,
    toolListed,
    isSubagent: (id) => subagents.has(id),
    registerSubagent: (id) => {
      subagents.add(id);
    },
    tracksRepo: (leadId, repo) => teams.has(groupKey(leadId, repo)),
    needsGuidance,
    needsLeadGuidance,
    queueLeadGuidance: (threadId, runId) =>
      Effect.suspend(() => {
        if (!needsLeadGuidance(threadId)) return Effect.void;
        leadRuns.set(threadId, runId);
        return Effect.forEach(
          activeByLead.get(threadId) ?? [],
          (team) =>
            team.leadGuided || mailbox.pendingLeadGuidance(threadId, runId, team.cohort)
              ? Effect.void
              : send(
                  { threadId, runId },
                  "The team board is open. Use team_board to read or post when needed.",
                  { leadTeam: team },
                ),
          { discard: true },
        );
      }),
    endRunNotices: (threadId, runId) => {
      if (leadRuns.get(threadId) === runId) leadRuns.delete(threadId);
      if (
        activeByMember
          .get(threadId)
          ?.members.some((member) => member.threadId === threadId && member.runId === runId)
      )
        terminalNoticeRuns.set(threadId, runId);
    },
    queueGuidance: (threadId, runId) =>
      Effect.suspend(() => {
        const team = activeByMember.get(threadId);
        if (
          team === undefined ||
          !needsGuidance(threadId, runId) ||
          mailbox.pendingGuidance(threadId, runId)
        )
          return Effect.void;
        return send({ threadId, runId }, `${TEAM_BOARD_CLAUSE} ${kickoffState(team)}`, {
          guidance: true,
        });
      }),
    hasNotices: mailbox.pending,
    noticeIsLive,
    reserveNotices: (threadId, runId) =>
      trackDelivery(mailbox.reserve(threadId, noticeIsLive, undefined, runId)),
    reserveSteer: (threadId, messageId) =>
      messageId.startsWith("team-board:")
        ? trackDelivery(
            mailbox.reserve(threadId, noticeIsLive, messageId.slice("team-board:".length)),
          )
        : undefined,
    memberAvailable: (threadId) => activeByMember.has(threadId) && available(threadId),
    availabilityChanges: Stream.fromPubSub(availabilityChanges),
    toolListChanges: Stream.fromPubSub(toolListChanges),
    editRefreshes: Stream.fromPubSub(editRefreshes),
    refreshAfterTool: (threadId) =>
      activeByMember.has(threadId)
        ? Effect.asVoid(PubSub.publish(editRefreshes, threadId))
        : Effect.void,
    access,
    postUser,
    subscribe,
    updateTeam,
    endRun,
    activeTeams,
    restorableRepos,
    recoverRepos,
    prepareChild: (leadId, threadId) =>
      Effect.suspend(() => (enabled(leadId) ? onChildPrepared(leadId, threadId) : Effect.void)),
    registerChildPreparation: (listener) => {
      onChildPrepared = listener;
    },
    observeTeam: (threadId) => {
      const team = trackedThreads.get(threadId);
      return team === undefined ? undefined : observe(team);
    },
    finalScan: (target) =>
      Effect.suspend(() => {
        if (!trackedThreads.has(target.threadId)) return Effect.void;
        return scanFinal(target);
      }),
    registerFinalScan: (scan) => {
      scanFinal = scan;
    },
    completion: (leadId, taskId) => completionNotes.get(completionKey(leadId, taskId)) ?? "",
    updateEdits,
    claimsFor: (leadId) => Ref.getUnsafe(ledgers).get(leadId)?.claims ?? [],
    notices: Stream.fromQueue(notices),
    lateNotice,
    queueNotice: (target, text) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const team = activeByMember.get(target.threadId);
          if (
            team === undefined ||
            !activeMembers(team).some(({ runId }) => runId === target.runId)
          )
            return;
          yield* queueImplicit(team, target, text, yield* Clock.currentTimeMillis, {
            crossChat: true,
          });
        }),
      ),
    tick,
  });
});

export const layer = Layer.effect(TeamBoard, make).pipe(Layer.provide(TeamBoardJournal.layer));
