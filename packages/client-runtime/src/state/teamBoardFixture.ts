import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  type TeamBoardFile,
  type TeamBoardPost,
  type TeamBoardPush,
  type TeamBoardSnapshot,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom } from "effect/reactivity";
import { threadKey } from "./entities.ts";
import type {
  TeamBoardFixtureSource,
  TeamBoardMember,
  TeamBoardPostCommand,
  TeamBoardRequest,
  TeamBoardSubagent,
} from "./teamBoard.ts";

/**
 * "repos" is "active" with a second live repository, so the board offers a repository picker.
 * "team" is "repos" with an addressed thread and its replies. Everything in it is something a
 * shipped server sends: no waits, merge plans or question counts.
 */
export type TeamBoardFixturePhase = "active" | "ended" | "readonly" | "repos" | "team";

const FIXTURE_MEMBERS: ReadonlyArray<TeamBoardMember> = (
  [
    ["fx-task-sol", "Settings migration", "codex", "GPT-5.5", "running"],
    ["fx-task-neon", "Theme default", "claudeAgent", "Opus 5.5", "running"],
    ["fx-task-opus", "API cache key", "antigravity", "Gemini 3 Pro", "completed"],
  ] as const
).map(([id, title, driver, model, status]) => ({
  id: NodeId.make(id),
  origin: "app_owned" as const,
  title,
  driver: ProviderDriverKind.make(driver),
  providerInstanceId: ProviderInstanceId.make(`fx-${driver}`),
  model,
  childThreadId: null,
  status,
}));

/** The chat's own team, or three stand-ins so a chat without subagents can show the board. */
export function teamBoardFixtureMembers(
  subagents: ReadonlyArray<TeamBoardMember>,
): ReadonlyArray<TeamBoardMember> {
  return fixtureTasks(subagents).length >= 2 ? subagents : FIXTURE_MEMBERS;
}

type Author = TeamBoardPost["author"];
const LEAD: Author = { name: "Lead" };
const USER: Author = { name: "You", user: true };

/**
 * Three subagents sharing a board, for QA without the server: 6 posts with a reply, a pinned
 * decision, a user post and a denied claim; two shared files, one that will conflict and one with
 * a stale range; presence. "ended" adds a handoff and drops presence; "readonly" is "active" for
 * a client that cannot post. Every phase has 12 past pushes, paged 10 at a time; one has 300
 * posts and one a single 300-post thread.
 */
export function buildTeamBoardFixture(input: {
  readonly phase: TeamBoardFixturePhase;
  readonly subagents: ReadonlyArray<TeamBoardSubagent>;
  readonly now: DateTime.Utc;
  readonly details: boolean;
  /** Only the presence feed carries presence; summaries and posts leave it empty. */
  readonly presence?: boolean;
  readonly extraPosts?: ReadonlyArray<TeamBoardPost>;
}): TeamBoardSnapshot | null {
  const tasks = fixtureTasks(input.subagents);
  if (tasks.length < 2) return null;
  const author = (index: number, fallback: string): Author => {
    const task = tasks[index % tasks.length]!;
    return { name: task.title?.trim() || fallback, taskId: task.id };
  };
  const sol = author(0, "Sol");
  const neon = author(1, "Neon");
  const opus = author(2, "Opus");
  const at = (minutesAgo: number) => DateTime.subtract(input.now, { minutes: minutesAgo });
  const posts: TeamBoardPost[] = [
    {
      id: "fx-1",
      author: sol,
      kind: "claim",
      text: "Taking the settings schema migration in loadSettings.",
      at: at(14),
      files: ["src/settings.ts#loadSettings"],
    },
    {
      id: "fx-2",
      author: neon,
      kind: "claim",
      text: "Claiming settings.ts to fix the default theme.",
      at: at(12),
      files: ["src/settings.ts"],
      conflict: { file: "src/settings.ts", owner: sol },
    },
    {
      id: "fx-3",
      author: neon,
      kind: "question",
      text: "Can I change the theme default once your migration lands?",
      at: at(11),
      to: sol.name,
      replyTo: "fx-1",
    },
    {
      id: "fx-4",
      author: LEAD,
      kind: "decision",
      text: "Every schema failure returns E_SETTINGS_INVALID.",
      at: at(9),
      pinned: true,
    },
    {
      id: "fx-5",
      author: opus,
      kind: "finding",
      text: "The cache key in api/client.ts ignores the user id; both settings fixes read it.",
      at: at(6),
      files: ["src/api/client.ts#cacheKey", "src/api/client.test.ts"],
    },
    {
      id: "fx-6",
      author: USER,
      kind: "message",
      text: "Keep the migration backward compatible with v1 settings files.",
      at: at(3),
    },
  ];
  const rich = input.phase === "team";
  if (rich) {
    posts.push(
      {
        id: "fx-8",
        author: neon,
        kind: "question",
        text: "Can I start the theme fix from your migration?",
        at: at(10),
        to: sol.name,
        files: ["src/settings.ts"],
      },
      {
        id: "fx-9",
        author: sol,
        kind: "message",
        text: "Yes, once abc1234 lands I'll post done.",
        at: at(8),
        to: neon.name,
        replyTo: "fx-1",
      },
    );
  }
  if (input.phase === "ended") {
    posts.push({
      id: "fx-7",
      author: sol,
      kind: "done",
      text: "Migration done; merge it before touching settings.ts.",
      at: at(1),
      files: ["src/settings.ts"],
      commit: "abc1234",
    });
  }
  const all = [...posts, ...(input.extraPosts ?? [])];
  const files: TeamBoardFile[] = [
    {
      path: "src/settings.ts",
      agents: [
        { author: sol, claims: ["src/settings.ts#loadSettings"], ranges: [{ start: 40, end: 80 }] },
        { author: neon, ranges: [{ start: 62, end: 75 }] },
      ],
      willConflict: true,
    },
    {
      path: "src/api/client.ts",
      agents: [
        { author: opus, claims: ["src/api/client.ts#cacheKey"], ranges: [{ start: 12, end: 30 }] },
        { author: sol, ranges: [{ start: 88, end: 96 }], stale: true },
      ],
      willConflict: false,
    },
  ];
  const active = input.phase !== "ended";
  const presence: Array<{ taskId: NodeId; files: string[] }> = active
    ? [
        { taskId: sol.taskId!, files: ["src/settings.ts#loadSettings", "src/settings.test.ts"] },
        { taskId: neon.taskId!, files: ["src/theme.ts", "src/theme.test.ts", "src/settings.ts"] },
        { taskId: opus.taskId!, files: ["src/api/client.ts"] },
      ].filter((entry, index) => index < tasks.length)
    : [];
  // Phones have no toSorted.
  const latest = [...all].sort(
    (left, right) => DateTime.toEpochMillis(left.at) - DateTime.toEpochMillis(right.at),
  )[all.length - 1];
  return {
    active,
    postCount: all.length,
    overlapCount: 1,
    ...(latest ? { latestPostId: latest.id } : {}),
    presence: input.presence === false ? [] : presence,
    ...(input.details ? { posts: all, files } : {}),
    pushId: LIVE_PUSH,
    ...fixtureHistoryPage(teamBoardFixtureHistory(input.phase, input.subagents, input.now), null),
  };
}

const HISTORY_PAGE = 10;

/** The page after `before` (the newest page when null), as the server sends it. */
function fixtureHistoryPage(all: ReadonlyArray<TeamBoardPush>, before: string | null) {
  const start = before === null ? 0 : all.findIndex((push) => push.id === before) + 1;
  if (start === 0 && before !== null) return { history: [], historyHasMore: false };
  return {
    history: all.slice(start, start + HISTORY_PAGE),
    historyHasMore: start + HISTORY_PAGE < all.length,
  };
}

/** An older page of past pushes: the summary's shape, with the next entries in `history`. */
export function buildTeamBoardFixtureHistoryPage(input: {
  readonly phase: TeamBoardFixturePhase;
  readonly subagents: ReadonlyArray<TeamBoardSubagent>;
  readonly now: DateTime.Utc;
  readonly before: string;
}): TeamBoardSnapshot | null {
  const summary = buildTeamBoardFixture({ ...input, details: false, presence: false });
  if (summary === null) return null;
  return {
    ...summary,
    ...fixtureHistoryPage(
      teamBoardFixtureHistory(input.phase, input.subagents, input.now),
      input.before,
    ),
  };
}

const SITE_PUSH = "fx-push-site";
const SITE_REPO = { id: SITE_PUSH, name: "site" } as const;
const MAIN_REPO = { id: "fx-push-live", name: "sshcode" } as const;

/** The second live repository in the "repos" phase: a small board of its own. */
export function buildTeamBoardFixtureSite(input: {
  readonly subagents: ReadonlyArray<TeamBoardSubagent>;
  readonly now: DateTime.Utc;
  readonly details: boolean;
  readonly extraPosts?: ReadonlyArray<TeamBoardPost>;
}): TeamBoardSnapshot | null {
  const tasks = fixtureTasks(input.subagents);
  if (tasks.length < 2) return null;
  const named = (index: number): Author => {
    const task = tasks[index % tasks.length]!;
    return { name: task.title?.trim() || NAMES[index]!, taskId: task.id };
  };
  const at = (minutes: number) => DateTime.subtract(input.now, { minutes });
  const posts: TeamBoardPost[] = [
    {
      id: "fx-site-1",
      author: named(2),
      kind: "claim",
      text: "Taking the pricing table on the landing page.",
      at: at(5),
      files: ["site/pricing.tsx"],
    },
    {
      id: "fx-site-2",
      author: named(1),
      kind: "finding",
      text: "The hero image is 4 MB; resizing it before the copy change.",
      at: at(1),
      files: ["site/hero.webp"],
    },
    ...(input.extraPosts ?? []),
  ];
  return {
    active: true,
    postCount: posts.length,
    overlapCount: 0,
    latestPostId: posts[posts.length - 1]!.id,
    presence: [],
    ...(input.details ? { posts, files: [] } : {}),
    pushId: SITE_PUSH,
  };
}

/** Both live repositories in one summary: counts added up, the newest post, and the choices. */
function fixtureAggregate(main: TeamBoardSnapshot, site: TeamBoardSnapshot): TeamBoardSnapshot {
  const last = (board: TeamBoardSnapshot) => board.posts?.[board.posts.length - 1];
  const mainLast = last(main);
  const siteLast = last(site);
  const newest =
    mainLast === undefined ||
    (siteLast !== undefined &&
      DateTime.toEpochMillis(siteLast.at) >= DateTime.toEpochMillis(mainLast.at))
      ? siteLast
      : mainLast;
  const { pushId: _pushId, posts: _posts, files: _files, ...rest } = main;
  return {
    ...rest,
    postCount: main.postCount + site.postCount,
    overlapCount: main.overlapCount + site.overlapCount,
    ...(newest === undefined ? {} : { latestPostId: newest.id }),
    repos: [MAIN_REPO, SITE_REPO],
  };
}

const LIVE_PUSH = "fx-push-live";
const EARLIER_PUSH = "fx-push-earlier";
const THREAD_PUSH = "fx-push-thread";
const BIG_PUSH = "fx-push-big";
const BIG_TEAM = ["Kite", "Moss", "Lark"] as const;
const BIG_POST_COUNT = 300;

/** The newest three local tasks, so presence lands on the team a re-run lead just delegated. */
function fixtureTasks(subagents: ReadonlyArray<TeamBoardSubagent>) {
  return subagents
    .filter((agent) => agent.origin === "app_owned" && agent.remote === undefined)
    .slice(-3);
}

const NAMES = ["Sol", "Neon", "Opus"] as const;

/** Past pushes, newest first; an ended live push joins them. */
export function teamBoardFixtureHistory(
  phase: TeamBoardFixturePhase,
  subagents: ReadonlyArray<TeamBoardSubagent>,
  now: DateTime.Utc,
): ReadonlyArray<TeamBoardPush> {
  const members = fixtureTasks(subagents).map((task, index) => task.title?.trim() || NAMES[index]!);
  const ago = (minutes: number) => DateTime.subtract(now, { minutes });
  // Nine more, a day apart, so history needs a second page.
  const older = Array.from({ length: 9 }, (_, index) => {
    const end = (2 + index) * 24 * 60;
    return {
      id: `fx-push-old-${index + 1}`,
      startedAt: ago(end + 50),
      endedAt: ago(end),
      members: index % 2 === 0 ? members : [...BIG_TEAM].slice(0, 2),
    };
  });
  return [
    ...(phase === "ended" ? [{ id: LIVE_PUSH, startedAt: ago(16), endedAt: ago(1), members }] : []),
    { id: EARLIER_PUSH, startedAt: ago(190), endedAt: ago(131), members },
    { id: THREAD_PUSH, startedAt: ago(7 * 60), endedAt: ago(6 * 60), members: members.slice(0, 2) },
    { id: BIG_PUSH, startedAt: ago(26 * 60), endedAt: ago(24 * 60 + 35), members: [...BIG_TEAM] },
    ...older,
  ];
}

/**
 * A past push, read-only: the ended board, 300 posts with replies, or one question with 299
 * replies, for list checks.
 */
export function buildTeamBoardFixturePush(input: {
  readonly pushId: string;
  readonly phase: TeamBoardFixturePhase;
  readonly subagents: ReadonlyArray<TeamBoardSubagent>;
  readonly now: DateTime.Utc;
}): TeamBoardSnapshot | null {
  const push = teamBoardFixtureHistory(input.phase, input.subagents, input.now).find(
    (entry) => entry.id === input.pushId,
  );
  if (push === undefined) return null;
  if (push.id === THREAD_PUSH) return fixtureThread(push, fixtureTasks(input.subagents));
  if (push.id !== BIG_PUSH) {
    const ended = buildTeamBoardFixture({
      phase: "ended",
      subagents: input.subagents,
      now: push.endedAt,
      details: true,
      presence: false,
    });
    return ended === null ? null : { ...ended, pushId: push.id, history: [] };
  }
  const authors = BIG_TEAM.map((name) => ({
    name,
    taskId: NodeId.make(`fx-${name.toLowerCase()}`),
  }));
  const kinds = ["claim", "finding", "question", "done", "release", "message"] as const;
  const posts: TeamBoardPost[] = [];
  for (let index = 0; index < BIG_POST_COUNT; index++) {
    const author = authors[index % authors.length]!;
    const reply = index % 5 === 4;
    posts.push({
      id: `fx-big-${index + 1}`,
      author: index % 23 === 0 ? LEAD : author,
      kind: reply ? "message" : kinds[index % kinds.length]!,
      text: `Step ${index + 1}: ${reply ? "following up on that" : "checking the parser and its tests"}.`,
      at: DateTime.add(push.startedAt, { seconds: index * 5 }),
      ...(reply ? { replyTo: `fx-big-${index}` } : {}),
      ...(index % 7 === 0 ? { files: [`src/parser/part${index % 9}.ts`] } : {}),
    });
  }
  return {
    active: false,
    postCount: posts.length,
    overlapCount: 0,
    latestPostId: posts[posts.length - 1]!.id,
    presence: [],
    posts,
    files: [
      {
        path: "src/parser/part0.ts",
        agents: [
          { author: authors[0]!, ranges: [{ start: 1, end: 40 }] },
          { author: authors[1]!, ranges: [{ start: 30, end: 52 }], stale: true },
        ],
        willConflict: false,
      },
    ],
    pushId: push.id,
    history: [],
  };
}

/** A local board: user posts land after a short wait, so pending states can be seen. */
export function createTeamBoardFixtureSource(
  phase: TeamBoardFixturePhase,
  options: { readonly postDelayMs?: number } = {},
): TeamBoardFixtureSource {
  const userPosts = Atom.family((_key: string) =>
    Atom.make<ReadonlyArray<TeamBoardPost>>([]).pipe(Atom.keepAlive),
  );
  // One clock read per board, so snapshots stay equal between reads.
  const startedAt = new Map<string, DateTime.Utc>();
  const post: TeamBoardPostCommand = {
    label: "message the team",
    run: (registry, target) =>
      new Promise((resolve) => {
        // @effect-diagnostics-next-line globalTimers:off - QA fixture outside an Effect runtime.
        setTimeout(() => {
          const scoped = threadKey({
            environmentId: target.environmentId,
            threadId: target.input.threadId,
          });
          const repo = target.input.repo;
          const atom = userPosts(
            repo === undefined || repo === LIVE_PUSH ? scoped : `${scoped}|${repo}`,
          );
          const current = registry.get(atom);
          registry.set(atom, [
            ...current,
            {
              id: `fx-user-${current.length + 1}`,
              author: USER,
              kind: target.input.decision ? "decision" : "message",
              text: target.input.text,
              at: DateTime.nowUnsafe(),
              ...(target.input.replyTo ? { replyTo: target.input.replyTo } : {}),
              ...(target.input.decision ? { pinned: true } : {}),
            },
          ]);
          resolve(AsyncResult.success(undefined));
        }, options.postDelayMs ?? 900);
      }),
  };
  const repos = phase === "repos" || phase === "team";
  return {
    members: teamBoardFixtureMembers,
    snapshot: (get, ref, subagents, request: TeamBoardRequest) => {
      const key = threadKey(ref);
      let now = startedAt.get(key);
      if (now === undefined) {
        now = DateTime.nowUnsafe();
        startedAt.set(key, now);
      }
      if (request.kind === "push") {
        return buildTeamBoardFixturePush({ pushId: request.pushId, phase, subagents, now });
      }
      if (request.kind === "history") {
        return buildTeamBoardFixtureHistoryPage({ phase, subagents, now, before: request.before });
      }
      const site = (details: boolean) =>
        buildTeamBoardFixtureSite({
          subagents,
          now,
          details,
          extraPosts: get(userPosts(`${key}|${SITE_PUSH}`)),
        });
      if (repos && request.kind === "details" && request.repo === SITE_PUSH) {
        return site(true);
      }
      const aggregate = repos && request.kind === "summary";
      const main = buildTeamBoardFixture({
        phase,
        subagents,
        now,
        details: request.kind === "details" || aggregate,
        presence: request.kind === "presence",
        extraPosts: get(userPosts(key)),
      });
      const siteBoard = aggregate ? site(true) : null;
      return main !== null && siteBoard !== null ? fixtureAggregate(main, siteBoard) : main;
    },
    post,
    canPost: phase !== "readonly",
  };
}

/** One question and 299 replies down a chain, alternating between two subagents. */
function fixtureThread(
  push: TeamBoardPush,
  tasks: ReadonlyArray<TeamBoardSubagent>,
): TeamBoardSnapshot {
  const authors = [0, 1].map((index): Author => {
    const task = tasks[index];
    return task
      ? { name: task.title?.trim() || NAMES[index]!, taskId: task.id }
      : { name: NAMES[index]! };
  });
  const posts: TeamBoardPost[] = [];
  for (let index = 0; index < BIG_POST_COUNT; index++) {
    posts.push({
      id: `fx-thread-${index + 1}`,
      author: authors[index % 2]!,
      kind: index === 0 ? "question" : "message",
      text:
        index === 0
          ? "Which of us owns the parser's error recovery?"
          : `Reply ${index}: ${index % 2 === 0 ? "agreed, keep going" : "one more case to check"}.`,
      at: DateTime.add(push.startedAt, { seconds: index * 10 }),
      ...(index === 0 ? {} : { replyTo: `fx-thread-${index}` }),
    });
  }
  return {
    active: false,
    postCount: posts.length,
    overlapCount: 0,
    latestPostId: posts[posts.length - 1]!.id,
    presence: [],
    posts,
    files: [],
    pushId: push.id,
    history: [],
  };
}
