import * as ReviewSchema from "effect/Schema";
import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  TeamBoardPost as PostContract,
  TeamBoardSnapshot as SnapshotContract,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type AuthSessionState,
  type TeamBoardPost,
  type TeamBoardPostInput,
  type TeamBoardSnapshot,
  type TeamBoardSubscribeInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { threadKey } from "./entities.ts";
import {
  applyTeamBoardFrame,
  canHaveTeamBoard,
  createTeamBoardAtoms,
  createTeamBoardViewAtoms,
  formatTeamBoardMembers,
  formatTeamBoardPushTime,
  formatTeamBoardRanges,
  formatTeamBoardTime,
  parseTeamBoardDraft,
  sameTeamBoardListItem,
  sameTeamBoardRow,
  teamBoardDraftError,
  teamBoardFiles,
  teamBoardHasHistory,
  teamBoardHistory,
  teamBoardHistoryLabel,
  teamBoardHistoryList,
  teamBoardRepoChoice,
  teamBoardKind,
  teamBoardListItems,
  teamBoardOverlapLabel,
  teamBoardPill,
  teamBoardAddressee,
  teamBoardAddressedMember,
  teamBoardHoldsLabel,
  teamBoardRoster,
  teamBoardAuthorLine,
  teamBoardAuthorsFromKey,
  teamBoardAuthorsKey,
  markTeamBoardSeen,
  teamBoardRepoLatestPostId,
  teamBoardRows,
  type TeamBoardSeenStorage,
  type TeamBoardMember,
} from "./teamBoard.ts";
import {
  buildTeamBoardFixture,
  buildTeamBoardFixtureHistoryPage,
  buildTeamBoardFixturePush,
  buildTeamBoardFixtureSite,
  createTeamBoardFixtureSource,
  teamBoardFixtureMembers,
} from "./teamBoardFixture.ts";

// Board times use the viewer's zone; pin one so the expected clock text holds on any machine.
vi.stubEnv("TZ", "America/New_York");

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const home = EnvironmentId.make("home");
const lead = ThreadId.make("lead");
const ref = { environmentId: home, threadId: lead };
const sol = NodeId.make("task-sol");
const neon = NodeId.make("task-neon");
const opus = NodeId.make("task-opus");
const task = (
  id: NodeId,
  title: string,
  extra: Partial<TeamBoardMember> = {},
): TeamBoardMember => ({
  id,
  origin: "app_owned",
  title,
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: ProviderInstanceId.make("codex"),
  model: null,
  childThreadId: null,
  status: "running",
  ...extra,
});
const team = [task(sol, "Sol"), task(neon, "Neon"), task(opus, "Opus")];
const now = DateTime.makeUnsafe("2026-11-27T02:42:00Z");

const memoryStorage = (): TeamBoardSeenStorage & { value: string | null } => {
  const storage = {
    value: null as string | null,
    read: () => storage.value,
    write: (value: string) => {
      storage.value = value;
    },
  };
  return storage;
};

type Feed =
  | "summary"
  | "details"
  | "presence"
  | `push:${string}`
  | `repo:${string}`
  | `history:${string}`;
const feedOf = (input: TeamBoardSubscribeInput): Feed =>
  input.historyBefore !== undefined
    ? `history:${input.historyBefore}`
    : input.pushId !== undefined
      ? input.delta
        ? `repo:${input.pushId}`
        : `push:${input.pushId}`
      : input.presenceOnly
        ? "presence"
        : input.details
          ? "details"
          : "summary";
const fixture = (feed: Feed) =>
  feed.startsWith("push:")
    ? buildTeamBoardFixturePush({ pushId: feed.slice(5), phase: "active", subagents: team, now })!
    : buildTeamBoardFixture({
        phase: "active",
        subagents: team,
        now,
        details: feed === "details",
        presence: feed === "presence",
      })!;

const harness = Effect.fn(function* (
  storage?: TeamBoardSeenStorage,
  /** More server feeds, each with its first frame. */
  extra: Partial<Record<Feed, TeamBoardSnapshot>> = {},
) {
  const calls: TeamBoardSubscribeInput[] = [];
  const posts: TeamBoardPostInput[] = [];
  // One server feed per request. A new subscription starts from the feed's latest frame, as a
  // fresh server subscription starts from a complete one.
  const feeds = new Map<Feed, SubscriptionRef.SubscriptionRef<TeamBoardSnapshot>>();
  const first: Array<[Feed, TeamBoardSnapshot]> = [
    ...(["summary", "details", "presence", "push:fx-push-earlier"] as const).map(
      (name): [Feed, TeamBoardSnapshot] => [name, fixture(name)],
    ),
    ...(Object.entries(extra) as Array<[Feed, TeamBoardSnapshot]>),
  ];
  for (const [name, frame] of first) {
    feeds.set(name, yield* SubscriptionRef.make(frame));
  }
  const feed = (name: Feed) => feeds.get(name)!;
  const emit = (name: Feed, frame: TeamBoardSnapshot) => SubscriptionRef.set(feed(name), frame);
  const session = {
    client: {
      [WS_METHODS.teamBoardSubscribe]: (input: TeamBoardSubscribeInput) => {
        calls.push(input);
        return SubscriptionRef.changes(feed(feedOf(input)));
      },
      [WS_METHODS.teamBoardPost]: (input: TeamBoardPostInput) =>
        Effect.sync(() => {
          posts.push(input);
        }),
    },
  } as unknown as RpcSession;
  const supervisor = {
    target: { environmentId: home, label: "home" },
    session: yield* SubscriptionRef.make(Option.some(session)),
  } as unknown as EnvironmentSupervisor["Service"];
  const run: EnvironmentRegistry["Service"]["run"] = (_id, effect) =>
    effect.pipe(Effect.provideService(EnvironmentSupervisor, supervisor));
  const followStream: EnvironmentRegistry["Service"]["followStream"] = (_id, stream) =>
    stream.pipe(Stream.provideService(EnvironmentSupervisor, supervisor));
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, { run, followStream } as EnvironmentRegistry["Service"]),
  );
  const subagents = Atom.family((_key: string) =>
    Atom.make<ReadonlyArray<TeamBoardMember>>([]).pipe(Atom.keepAlive),
  );
  const view = createTeamBoardViewAtoms({
    board: createTeamBoardAtoms(runtime),
    subagentsAtom: (target) => subagents(threadKey(target)),
    seenStorage: storage,
  });
  const registry = AtomRegistry.make();
  registry.mount(sessions(home));
  registry.set(
    sessions(home),
    AsyncResult.success({
      authenticated: true,
      auth: {
        policy: "remote-reachable",
        bootstrapMethods: [],
        sessionMethods: [],
        sessionCookieName: "test",
      },
      scopes: [AuthOrchestrationReadScope],
      permissions: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
    }),
  );
  const setSubagents = (value: ReadonlyArray<TeamBoardMember>) =>
    registry.set(subagents(threadKey(ref)), value);
  const until = <A>(atom: Atom.Atom<A>, done: (value: A) => boolean) =>
    Effect.callback<A>((resume) => {
      const unsubscribe = registry.subscribe(
        atom,
        (value) => {
          if (done(value)) resume(Effect.succeed(value));
        },
        { immediate: true },
      );
      return Effect.sync(unsubscribe);
    });
  return { view, registry, calls, posts, emit, setSubagents, until };
});

describe("team board view", () => {
  it("needs two local app-owned tasks", () => {
    expect(canHaveTeamBoard([])).toBe(false);
    expect(canHaveTeamBoard([task(sol, "Sol")])).toBe(false);
    expect(
      canHaveTeamBoard([task(sol, "Sol"), task(neon, "Neon", { origin: "provider_native" })]),
    ).toBe(false);
    expect(
      canHaveTeamBoard([task(sol, "Sol"), task(neon, "Neon", { remote: { environmentId: home } })]),
    ).toBe(false);
    expect(canHaveTeamBoard([task(sol, "Sol"), task(neon, "Neon")])).toBe(true);
  });

  it.effect("sends no RPC for ordinary chats", () =>
    Effect.gen(function* () {
      const { view, registry, calls, setSubagents } = yield* harness();
      const unmount = registry.mount(view.summaryAtom(ref));
      try {
        expect(registry.get(view.summaryAtom(ref))).toBeNull();
        setSubagents([task(sol, "Sol"), task(neon, "Neon", { origin: "provider_native" })]);
        expect(registry.get(view.summaryAtom(ref))).toBeNull();
        expect(registry.get(view.holdsAtom(ref)).size).toBe(0);
        expect(calls).toEqual([]);
      } finally {
        unmount();
      }
    }),
  );

  it.effect("subscribes summaries for a team and details only while read", () =>
    Effect.gen(function* () {
      const { view, registry, calls, setSubagents, until } = yield* harness();
      setSubagents(team);
      const unmount = registry.mount(view.summaryAtom(ref));
      try {
        const summary = yield* until(view.summaryAtom(ref), (value) => value !== null);
        expect(summary?.postCount).toBe(6);
        expect(summary?.posts).toBeUndefined();
        expect(calls).toEqual([{ threadId: lead, delta: true }]);

        const closeDetails = registry.mount(view.detailsAtom(ref));
        yield* until(view.detailsAtom(ref), (value) => value !== null);
        expect(calls).toEqual([
          { threadId: lead, delta: true },
          { threadId: lead, details: true, delta: true },
        ]);
        closeDetails();

        // Older task records page out of the window; the board this view saw stays.
        setSubagents([]);
        expect(registry.get(view.summaryAtom(ref))?.postCount).toBe(6);
      } finally {
        unmount();
      }
    }),
  );

  it.effect("folds delta frames into the live posts, keeping untouched ones", () =>
    Effect.gen(function* () {
      const { view, registry, emit, setSubagents, until } = yield* harness();
      setSubagents(team);
      const unmount = registry.mount(view.detailsAtom(ref));
      try {
        const first = (yield* until(view.detailsAtom(ref), (value) => value !== null))!;
        const [fx1, , , , fx5] = first.posts!;
        yield* emit("details", {
          active: true,
          postCount: 6,
          overlapCount: 1,
          latestPostId: "fx-7",
          presence: [],
          delta: true,
          posts: [
            { ...fx5!, text: "The cache key also ignores the locale." },
            {
              id: "fx-7",
              author: { name: "Sol", taskId: sol },
              kind: "done",
              text: "Done.",
              at: now,
            },
          ],
          removedPostIds: ["fx-6"],
        });
        const next = (yield* until(
          view.detailsAtom(ref),
          (value) => value?.latestPostId === "fx-7",
        ))!;
        expect(next.posts!.map((post) => post.id)).toEqual([
          "fx-1",
          "fx-2",
          "fx-3",
          "fx-4",
          "fx-5",
          "fx-7",
        ]);
        expect(next.posts![4]!.text).toBe("The cache key also ignores the locale.");
        // Same objects for what the frame did not touch; files stay until they change.
        expect(next.posts![0]).toBe(fx1);
        expect(next.files).toBe(first.files);
        expect(next.delta).toBeUndefined();
        expect(next.removedPostIds).toBeUndefined();
      } finally {
        unmount();
      }
    }),
  );

  it.effect("counts each member's held files from the presence feed for the roster", () =>
    Effect.gen(function* () {
      const { view, registry, emit, setSubagents, until } = yield* harness();
      setSubagents(team);
      const unmountSummary = registry.mount(view.summaryAtom(ref));
      const unmountHolds = registry.mount(view.holdsAtom(ref));
      try {
        // Live summary and delta frames carry no presence; holds come from the presence feed.
        yield* until(view.holdsAtom(ref), (holds) => holds.get(opus) === 1);
        yield* emit("presence", {
          ...fixture("presence"),
          presence: [{ taskId: opus, files: ["src/api/cache.ts", "src/api/client.ts"] }],
        });
        yield* until(view.holdsAtom(ref), (holds) => holds.get(opus) === 2);
        expect(registry.get(view.holdsAtom(ref)).get(sol)).toBeUndefined();
      } finally {
        unmountHolds();
        unmountSummary();
      }
    }),
  );

  it.effect("keeps presence on its own feed while a push is live", () =>
    Effect.gen(function* () {
      const { view, registry, calls, emit, setSubagents, until } = yield* harness();
      setSubagents(team);
      const unmountSummary = registry.mount(view.summaryAtom(ref));
      const unmountPresence = registry.mount(view.holdsAtom(ref));
      try {
        yield* until(view.holdsAtom(ref), (holds) => holds.get(opus) === 1);
        expect(calls).toEqual([
          { threadId: lead, delta: true },
          { threadId: lead, presenceOnly: true },
        ]);
        const holds = registry.get(view.holdsAtom(ref));
        // Summaries carry no presence; a new summary leaves the roster's counts alone.
        yield* emit("summary", { ...fixture("summary"), postCount: 7, latestPostId: "fx-7" });
        yield* until(view.summaryAtom(ref), (value) => value?.postCount === 7);
        expect(registry.get(view.holdsAtom(ref))).toBe(holds);
        // Presence moves without a summary frame.
        yield* emit("presence", {
          ...fixture("presence"),
          presence: [{ taskId: opus, files: ["src/api/cache.ts", "src/api/client.ts"] }],
        });
        yield* until(view.holdsAtom(ref), (counts) => counts.get(opus) === 2);
        expect(registry.get(view.summaryAtom(ref))?.postCount).toBe(7);
      } finally {
        unmountPresence();
        unmountSummary();
      }
    }),
  );

  it.effect("reads a past push without touching the live one", () =>
    Effect.gen(function* () {
      const storage = memoryStorage();
      const { view, registry, calls, setSubagents, until } = yield* harness(storage);
      setSubagents(team);
      registry.set(view.seenAtom(ref), "fx-6");
      const unmountSummary = registry.mount(view.summaryAtom(ref));
      const unmountPush = registry.mount(view.pushAtom(ref, "fx-push-earlier"));
      try {
        const summary = yield* until(view.summaryAtom(ref), (value) => value !== null);
        const past = (yield* until(
          view.pushAtom(ref, "fx-push-earlier"),
          (value) => value !== null,
        ))!;
        expect(calls).toContainEqual({ threadId: lead, details: true, pushId: "fx-push-earlier" });
        expect(past).toMatchObject({
          active: false,
          pushId: "fx-push-earlier",
          latestPostId: "fx-7",
        });
        // The live push's counts, unread mark and posts are its own.
        expect(teamBoardPill(summary, registry.get(view.seenAtom(ref)))).toEqual({
          postCount: 6,
          overlapCount: 1,
          unread: false,
        });
        expect(registry.get(view.seenAtom(ref))).toBe("fx-6");
        expect(calls.some((input) => input.details && input.pushId === undefined)).toBe(false);
      } finally {
        unmountPush();
        unmountSummary();
      }
    }),
  );

  it.effect("shows the chosen live repository's board and keeps the pill on the whole team", () =>
    Effect.gen(function* () {
      const repos = [
        { id: "push-a", name: "sshcode" },
        { id: "push-b", name: "site" },
      ];
      const aggregate = {
        ...fixture("summary"),
        postCount: 8,
        latestPostId: "b-2",
        repos,
      };
      const site = {
        ...buildTeamBoardFixtureSite({ subagents: team, now, details: true })!,
        pushId: "push-b",
      };
      const { view, registry, calls, emit, setSubagents, until } = yield* harness(undefined, {
        "repo:push-a": { ...fixture("details"), pushId: "push-a" },
        "repo:push-b": site,
      });
      setSubagents(team);
      registry.set(view.seenAtom(ref), "fx-6");
      yield* emit("summary", aggregate);
      const unmountSummary = registry.mount(view.summaryAtom(ref));
      const unmountDetails = registry.mount(view.detailsAtom(ref));
      try {
        yield* until(view.summaryAtom(ref), (value) => value?.repos !== undefined);
        // Two live repositories: the first listed shows until another is picked.
        expect(registry.get(view.repoChoiceAtom(ref))?.chosen).toEqual(repos[0]);
        yield* until(view.detailsAtom(ref), (value) => value?.pushId === "push-a");
        registry.set(view.pickedRepoAtom(ref), "push-b");
        const picked = yield* until(view.detailsAtom(ref), (value) => value?.pushId === "push-b");
        expect(picked?.posts?.map((post) => post.id)).toEqual(["fx-site-1", "fx-site-2"]);
        expect(calls).toContainEqual({
          threadId: lead,
          details: true,
          delta: true,
          pushId: "push-b",
        });
        // The pill counts both repositories and reads unread from the newest post anywhere.
        const pill = teamBoardPill(
          registry.get(view.summaryAtom(ref)),
          registry.get(view.seenAtom(ref)),
        );
        expect(pill).toEqual({ postCount: 8, overlapCount: 1, unread: true });
        expect(registry.get(view.seenAtom(ref))).toBe("fx-6");

        // The picked repository ends: the first remaining one shows; one left, no picker.
        yield* emit("summary", {
          ...aggregate,
          repos: [repos[0]!, { id: "push-c", name: "docs" }],
        });
        yield* until(view.repoChoiceAtom(ref), (choice) => choice?.repos[1]?.id === "push-c");
        expect(registry.get(view.repoChoiceAtom(ref))?.chosen.id).toBe("push-a");
        const { repos: _repos, ...single } = aggregate;
        yield* emit("summary", single);
        yield* until(view.repoChoiceAtom(ref), (choice) => choice === null);
        yield* until(view.detailsAtom(ref), (value) => value?.pushId === "fx-push-live");
        expect(calls).toContainEqual({ threadId: lead, details: true, delta: true });
      } finally {
        unmountDetails();
        unmountSummary();
      }
    }),
  );

  it.effect("loads older pushes on demand, after the summary's newest 10", () =>
    Effect.gen(function* () {
      const page = buildTeamBoardFixtureHistoryPage({
        phase: "active",
        subagents: team,
        now,
        before: "fx-push-old-7",
      })!;
      const { view, registry, calls, setSubagents, until } = yield* harness(undefined, {
        "history:fx-push-old-7": page,
      });
      setSubagents(team);
      registry.set(view.seenAtom(ref), "fx-6");
      const list = view.historyListAtom(ref);
      const unmountSummary = registry.mount(view.summaryAtom(ref));
      const unmount = registry.mount(list);
      try {
        const first = yield* until(list, (value) => value.pushes.length > 0);
        expect(first.pushes).toHaveLength(10);
        expect(first.olderCursor).toBe("fx-push-old-7");
        // Nothing older is fetched until asked for.
        expect(calls.some((input) => input.historyBefore !== undefined)).toBe(false);
        registry.set(list, first.olderCursor!);
        const all = yield* until(list, (value) => value.pushes.length === 12);
        expect(calls).toContainEqual({
          threadId: lead,
          delta: true,
          historyBefore: "fx-push-old-7",
        });
        expect(all.pushes.slice(-2).map((push) => push.id)).toEqual([
          "fx-push-old-8",
          "fx-push-old-9",
        ]);
        expect(all.olderCursor).toBeNull();
        // Paging history leaves the live pill and its unread mark alone.
        expect(
          teamBoardPill(registry.get(view.summaryAtom(ref)), registry.get(view.seenAtom(ref))),
        ).toEqual({ postCount: 6, overlapCount: 1, unread: false });
      } finally {
        unmount();
        unmountSummary();
      }
    }),
  );

  it("posts to the chosen repository in the QA board", async () => {
    const source = createTeamBoardFixtureSource("repos", { postDelayMs: 0 });
    const registry = AtomRegistry.make();
    const read = (request: Parameters<typeof source.snapshot>[3]) =>
      registry.get(Atom.make((get) => source.snapshot(get, ref, team, request)));
    const summary = read({ kind: "summary" })!;
    expect(summary.repos?.map((repo) => repo.name)).toEqual(["sshcode", "site"]);
    expect(summary).toMatchObject({ postCount: 8, overlapCount: 1, latestPostId: "fx-site-2" });
    await source.post.run(registry, {
      environmentId: home,
      input: { threadId: lead, text: "Ship the smaller hero.", repo: "fx-push-site" },
    });
    expect(
      read({ kind: "details", repo: "fx-push-site" })!.posts!.map((post) => post.text),
    ).toContain("Ship the smaller hero.");
    expect(read({ kind: "details", repo: "fx-push-live" })!.posts).toHaveLength(6);
  });

  it.effect("posts through the board command for the destination chat", () =>
    Effect.gen(function* () {
      const { view, registry, posts } = yield* harness();
      expect(registry.get(view.permissionAtom(home))).toBe(true);
      const result = yield* Effect.promise(() =>
        view.post.run(registry, {
          environmentId: home,
          input: { threadId: lead, text: "Merge Sol first.", decision: true },
        }),
      );
      expect(result._tag).toBe("Success");
      expect(posts).toEqual([{ threadId: lead, text: "Merge Sol first.", decision: true }]);
    }),
  );

  it.effect("remembers the last opened post across restarts", () =>
    Effect.gen(function* () {
      const storage = memoryStorage();
      const first = yield* harness(storage);
      expect(first.registry.get(first.view.seenAtom(ref))).toBeNull();
      first.registry.set(first.view.seenAtom(ref), "fx-6");
      expect(JSON.parse(storage.value!)).toEqual({ [threadKey(ref)]: "fx-6" });

      // A new client start reads the mark back; a known board subscribes without task records.
      const second = yield* harness(storage);
      const unmount = second.registry.mount(second.view.summaryAtom(ref));
      try {
        const summary = yield* second.until(
          second.view.summaryAtom(ref),
          (value) => value !== null,
        );
        const seen = second.registry.get(second.view.seenAtom(ref));
        expect(seen).toBe("fx-6");
        expect(teamBoardPill(summary, seen)?.unread).toBe(false);
        yield* second.emit("summary", { ...summary!, postCount: 7, latestPostId: "fx-7" });
        const next = yield* second.until(
          second.view.summaryAtom(ref),
          (value) => value?.latestPostId === "fx-7",
        );
        expect(teamBoardPill(next, seen)).toEqual({ postCount: 7, overlapCount: 1, unread: true });
      } finally {
        unmount();
      }
    }),
  );
});

describe("team board presentation", () => {
  const active = buildTeamBoardFixture({ phase: "active", subagents: team, now, details: true })!;
  const ended = buildTeamBoardFixture({ phase: "ended", subagents: team, now, details: true })!;

  it("shows the pill only while a live board has posts", () => {
    expect(teamBoardPill(null, null)).toBeNull();
    expect(teamBoardPill({ ...active, postCount: 0 }, null)).toBeNull();
    expect(teamBoardPill(active, null)).toEqual({ postCount: 6, overlapCount: 1, unread: true });
    expect(teamBoardPill(active, "fx-6")?.unread).toBe(false);
    expect(teamBoardPill(ended, null)).toBeNull();
    expect(ended.presence).toEqual([]);
  });

  it("keeps the dot while any live repository has an unseen post", () => {
    const multi = {
      ...active,
      latestPostId: "s-3",
      repos: [
        { id: "web", name: "Web", latestPostId: "w-2" },
        { id: "srv", name: "Server", latestPostId: "s-3" },
      ],
    };
    // Reading Server marks only Server seen; Web's post keeps the dot.
    const afterServer = markTeamBoardSeen(null, { latestPostId: "s-3", repo: "srv" });
    expect(teamBoardPill(multi, afterServer)?.unread).toBe(true);
    const afterBoth = markTeamBoardSeen(afterServer, { latestPostId: "w-2", repo: "web" });
    expect(teamBoardPill(multi, afterBoth)?.unread).toBe(false);
    const newer = {
      ...multi,
      repos: [multi.repos[0]!, { ...multi.repos[1]!, latestPostId: "s-4" }],
    };
    expect(teamBoardPill(newer, afterBoth)?.unread).toBe(true);
    expect(teamBoardRepoLatestPostId(multi, "web")).toBe("w-2");
    expect(teamBoardRepoLatestPostId(active, null)).toBe(active.latestPostId);
    // A value saved before repositories were tracked still reads.
    expect(teamBoardPill(active, "fx-6")?.unread).toBe(false);
  });

  it("opening an empty repository leaves another repository's news unread", () => {
    const multi = {
      ...active,
      latestPostId: "s-1",
      repos: [
        { id: "web", name: "Web" },
        { id: "srv", name: "Server", latestPostId: "s-1" },
      ],
    };
    expect(teamBoardRepoLatestPostId(multi, "web")).toBeUndefined();
    expect(teamBoardPill(multi, null)?.unread).toBe(true);
  });

  it("keeps a repository's seen mark however many posts another repository gets", () => {
    const multi = {
      ...active,
      latestPostId: "b8",
      repos: [
        { id: "a", name: "A", latestPostId: "a1" },
        { id: "b", name: "B", latestPostId: "b8" },
      ],
    };
    let seen = markTeamBoardSeen(null, { latestPostId: "a1", repo: "a" });
    for (let index = 1; index <= 8; index++)
      seen = markTeamBoardSeen(seen, { latestPostId: `b${index}`, repo: "b" });
    expect(teamBoardPill(multi, seen)?.unread).toBe(false);
  });

  it("lists past pushes for the header, even while a new push runs", () => {
    const live = teamBoardHistory(active);
    const ids = (history: ReturnType<typeof teamBoardHistory>) =>
      history?.kind === "pushes" ? history.pushes.map((push) => push.id) : [];
    // The summary carries the newest 10 and says more are older.
    expect(ids(live)).toHaveLength(10);
    expect(ids(live).slice(0, 3)).toEqual(["fx-push-earlier", "fx-push-thread", "fx-push-big"]);
    expect(live).toMatchObject({ hasMore: true });
    const after = teamBoardHistory(ended);
    expect(ids(after)[0]).toBe("fx-push-live");
    expect(teamBoardHistoryLabel(after!, ended.postCount)).toBe("10+ past pushes");
    expect(
      teamBoardHistoryLabel(
        {
          kind: "pushes",
          pushes: after!.kind === "pushes" ? after!.pushes.slice(0, 1) : [],
          hasMore: false,
        },
        0,
      ),
    ).toBe("1 past push");
    expect(teamBoardHasHistory({ ...active, history: [] })).toBe(false);
    // A server without push history: the ended board itself, and nothing while live.
    const { history: _history, ...legacyEnded } = ended;
    const { history: _live, ...legacyActive } = active;
    expect(teamBoardHistory(legacyEnded)).toEqual({ kind: "ended" });
    expect(teamBoardHistoryLabel({ kind: "ended" }, 7)).toBe("7 posts · read-only");
    expect(teamBoardHistory(legacyActive)).toBeNull();
    expect(teamBoardHistory({ ...legacyEnded, postCount: 0 })).toBeNull();
  });

  it("labels a past push by its local times and team, sharing what both ends share", () => {
    const at = (iso: string) => DateTime.makeUnsafe(iso);
    const span = (start: string, end: string) =>
      formatTeamBoardPushTime({ startedAt: at(start), endedAt: at(end) });
    expect(span("2026-11-27T00:16:00Z", "2026-11-27T00:21:00Z")).toBe("Nov 26 · 7:16–7:21 PM");
    expect(span("2026-11-26T16:50:00Z", "2026-11-26T17:10:00Z")).toBe("Nov 26 · 11:50 AM–12:10 PM");
    expect(span("2026-11-27T04:50:00Z", "2026-11-27T05:30:00Z")).toBe(
      "Nov 26, 11:50 PM – Nov 27, 12:30 AM",
    );
    expect(formatTeamBoardMembers(["Sol", "Neon", "Opus"])).toBe("Sol, Neon, Opus");
    expect(formatTeamBoardMembers([])).toBe("No subagents recorded");
  });

  it("names the holder of the file in a denied claim, not the claimant", () => {
    const denied = active.posts!.find((post) => post.conflict !== undefined)!;
    expect(denied.author.name).toBe("Neon");
    expect(teamBoardOverlapLabel(denied.conflict!)).toBe(
      "Overlap: Sol is already editing settings.ts",
    );
    expect(
      teamBoardOverlapLabel({
        file: "src/api/client.ts#cacheKey",
        owner: { name: "You", user: true },
      }),
    ).toBe("Overlap: You are already editing client.ts");
  });

  it("picks a live repository only with two or more live", () => {
    const repos = [
      { id: "a", name: "sshcode" },
      { id: "b", name: "site" },
    ];
    expect(teamBoardRepoChoice(null, null)).toBeNull();
    expect(teamBoardRepoChoice({ ...active, repos: [repos[0]!] }, null)).toBeNull();
    expect(teamBoardRepoChoice({ ...ended, repos }, "b")).toBeNull();
    expect(teamBoardRepoChoice({ ...active, repos }, null)?.chosen.id).toBe("a");
    expect(teamBoardRepoChoice({ ...active, repos }, "b")?.chosen.id).toBe("b");
    expect(teamBoardRepoChoice({ ...active, repos }, "gone")?.chosen.id).toBe("a");
  });

  it("joins history pages in order, once each, and waits on a loading page", () => {
    const push = (id: string, hoursAgo: number) => ({
      id,
      startedAt: DateTime.subtract(now, { hours: hoursAgo + 1 }),
      endedAt: DateTime.subtract(now, { hours: hoursAgo }),
      members: ["Sol"],
    });
    const first = { ...active, history: [push("p1", 1), push("p2", 2)], historyHasMore: true };
    expect(teamBoardHistoryList(first, [])).toEqual({
      pushes: first.history,
      olderCursor: "p2",
      loading: false,
    });
    expect(teamBoardHistoryList(first, [null])).toMatchObject({
      olderCursor: null,
      loading: true,
    });
    const second = { ...active, history: [push("p2", 2), push("p3", 3)], historyHasMore: false };
    expect(teamBoardHistoryList(first, [second]).pushes.map((entry) => entry.id)).toEqual([
      "p1",
      "p2",
      "p3",
    ]);
    expect(teamBoardHistoryList(first, [second]).olderCursor).toBeNull();
  });

  it("replaces on complete frames and never mixes two pushes", () => {
    const base = { ...active, pushId: "push-a" };
    const delta = (extra: Partial<TeamBoardSnapshot>) =>
      applyTeamBoardFrame(base, {
        active: true,
        postCount: 6,
        overlapCount: 1,
        presence: [],
        delta: true,
        ...extra,
      });
    // Optional fields a delta leaves out keep their last value.
    const quiet = delta({});
    expect(quiet.posts).toBe(base.posts);
    expect(quiet.files).toBe(base.files);
    expect(quiet).toMatchObject({ pushId: "push-a", latestPostId: "fx-6" });
    expect(quiet.history).toBe(base.history);
    // Repository choices are never carried: a frame without them has one live repository.
    const multi = {
      ...base,
      repos: [
        { id: "a", name: "sshcode" },
        { id: "b", name: "site" },
      ],
      historyHasMore: true,
    };
    const next = applyTeamBoardFrame(multi, {
      active: true,
      postCount: 6,
      overlapCount: 1,
      presence: [],
      delta: true,
    });
    expect(next.repos).toBeUndefined();
    expect(next.historyHasMore).toBe(true);
    // A reconnect, or a server without deltas, sends complete frames; each replaces.
    const fresh = applyTeamBoardFrame(base, { ...active, posts: [active.posts![0]!] });
    expect(fresh.posts!.map((post) => post.id)).toEqual(["fx-1"]);
    // A new push starts over even if its first frame claims to be a delta.
    const other = delta({ pushId: "push-b", posts: [active.posts![5]!] });
    expect(other.posts!.map((post) => post.id)).toEqual(["fx-6"]);
    expect(other.files).toBeUndefined();
    // Nothing to merge into: the frame stands as sent.
    expect(applyTeamBoardFrame(null, { ...base, delta: true }).posts).toBe(base.posts);
  });

  it("renders 300 posts as threads and re-renders only what a delta changed", () => {
    const big = buildTeamBoardFixturePush({
      pushId: "fx-push-big",
      phase: "ended",
      subagents: team,
      now,
    })!;
    expect(big.posts).toHaveLength(300);
    const rows = teamBoardRows(big.posts!, { filter: "all" });
    // Every fifth post replies to the one before; replies stay nested, never lost.
    expect(rows).toHaveLength(240);
    expect(rows.reduce((count, row) => count + 1 + row.replies.length, 0)).toBe(300);
    expect(rows.find((row) => row.post.id === "fx-big-4")?.replies.map((post) => post.id)).toEqual([
      "fx-big-5",
    ]);
    const edited = { ...big.posts![150]!, text: "Edited." };
    const { posts: _posts, files: _files, ...scalars } = big;
    const next = applyTeamBoardFrame(big, { ...scalars, delta: true, posts: [edited] });
    const nextRows = teamBoardRows(next.posts!, { filter: "all" });
    const changed = nextRows.filter((row, index) => !sameTeamBoardRow(rows[index]!, row));
    expect(changed.map((row) => row.post.id)).toEqual([edited.id]);
  });

  it("flattens a 300-post thread into one row per reply, on the thread's line", () => {
    const at = (index: number) => DateTime.add(now, { seconds: index });
    const posts: TeamBoardPost[] = Array.from({ length: 300 }, (_, index) => ({
      id: `t${index}`,
      author: { name: "Sol", taskId: sol },
      kind: index === 0 ? "question" : "message",
      text: `Reply ${index}`,
      at: at(index),
      ...(index === 0 ? {} : { replyTo: index === 1 ? "t0" : `t${index - 1}` }),
    }));
    const items = teamBoardListItems(teamBoardRows(posts, { filter: "all" }));
    expect(items).toHaveLength(300);
    expect(items[0]).toMatchObject({ reply: false, endsThread: false });
    expect(items.slice(1).every((item) => item.reply)).toBe(true);
    expect(items.filter((item) => item.endsThread).map((item) => item.post.id)).toEqual(["t299"]);
    // A new reply moves the thread's end: the new row and the old last row change, nothing else.
    const next = teamBoardListItems(
      teamBoardRows([...posts, { ...posts[299]!, id: "t300", replyTo: "t299", at: at(300) }], {
        filter: "all",
      }),
    );
    const changed = next.filter((item, index) => {
      const before = items[index];
      return before === undefined || !sameTeamBoardListItem(before, item);
    });
    expect(changed.map((item) => item.post.id)).toEqual(["t299", "t300"]);
  });

  it("nests replies under their thread, newest threads first", () => {
    const rows = teamBoardRows(active.posts!, { filter: "all" });
    expect(rows.map((row) => row.post.id)).toEqual(["fx-6", "fx-5", "fx-4", "fx-2", "fx-1"]);
    expect(rows.find((row) => row.post.id === "fx-1")?.replies.map((post) => post.id)).toEqual([
      "fx-3",
    ]);
  });

  it("filters by kind and by agent, keeping orphaned replies visible", () => {
    const ids = (rows: ReturnType<typeof teamBoardRows>) =>
      rows.flatMap((row) => [row.post.id, ...row.replies.map((post) => post.id)]);
    expect(ids(teamBoardRows(active.posts!, { filter: "claims" }))).toEqual(["fx-2", "fx-1"]);
    expect(ids(teamBoardRows(active.posts!, { filter: "questions" }))).toEqual(["fx-3"]);
    expect(ids(teamBoardRows(active.posts!, { filter: "overlaps" }))).toEqual(["fx-2"]);
    // Sol's own posts, the overlap naming Sol as the owner, and Neon's question replying to Sol.
    expect(ids(teamBoardRows(active.posts!, { filter: "all", taskId: sol }))).toEqual([
      "fx-2",
      "fx-1",
      "fx-3",
    ]);
    expect(ids(teamBoardRows(active.posts!, { filter: "all", taskId: neon }))).toEqual([
      "fx-3",
      "fx-2",
    ]);
    expect(teamBoardFiles(active.files!, opus).map((file) => file.path)).toEqual([
      "src/api/client.ts",
    ]);
    expect(teamBoardFiles(active.files!, neon).map((file) => file.path)).toEqual([
      "src/settings.ts",
    ]);
  });

  it("reads open kinds, ranges, presence, and local times", () => {
    expect(teamBoardKind("claim")).toEqual({ label: "Editing", tone: "claim" });
    expect(teamBoardKind("release")).toEqual({ label: "Done editing", tone: "muted" });
    expect(teamBoardKind("message")).toBeNull();
    expect(teamBoardKind("handoff")).toEqual({ label: "Handoff", tone: "muted" });
    expect(
      formatTeamBoardRanges([
        { start: 40, end: 80 },
        { start: 7, end: 7 },
      ]),
    ).toBe("L40–80, L7");
    expect(formatTeamBoardRanges(undefined)).toBeNull();
    expect(formatTeamBoardTime(now)).toBe("9:42 PM");
    expect(formatTeamBoardTime(DateTime.makeUnsafe("2026-07-01T13:05:00Z"))).toBe("9:05 AM");
  });

  it("parses /decision posts and the length limit", () => {
    expect(parseTeamBoardDraft("  /decision  Use E_SETTINGS_INVALID ")).toEqual({
      text: "Use E_SETTINGS_INVALID",
      decision: true,
    });
    expect(parseTeamBoardDraft("/decisions are hard")).toEqual({
      text: "/decisions are hard",
      decision: false,
    });
    expect(teamBoardDraftError("x".repeat(280))).toBeNull();
    expect(teamBoardDraftError("x".repeat(283))).toBe("3 over 280");
  });

  it("builds the QA fixture on the chat's own tasks", () => {
    const posts = active.posts! as ReadonlyArray<TeamBoardPost>;
    expect(posts).toHaveLength(6);
    expect(posts.filter((post) => post.replyTo !== undefined)).toHaveLength(1);
    expect(posts.filter((post) => post.kind === "decision" && post.pinned)).toHaveLength(1);
    expect(posts.filter((post) => post.author.user)).toHaveLength(1);
    expect(posts.filter((post) => post.conflict !== undefined)).toHaveLength(1);
    expect(active.files!.map((file) => file.willConflict)).toEqual([true, false]);
    expect(active.presence.map((entry) => entry.taskId)).toEqual([sol, neon, opus]);
    expect(posts[0]!.author).toEqual({ name: "Sol", taskId: sol });
    expect(
      buildTeamBoardFixture({ phase: "active", subagents: [team[0]!], now, details: true }),
    ).toBeNull();
    const summary = buildTeamBoardFixture({
      phase: "ended",
      subagents: team,
      now,
      details: false,
    })!;
    expect(summary).toMatchObject({ active: false, postCount: 7, latestPostId: "fx-7" });
    expect(summary.posts).toBeUndefined();
  });
});

describe("team board authors", () => {
  it("names each post's sender as the chat's subagent rows do", () => {
    const authors = teamBoardAuthorsFromKey(
      teamBoardAuthorsKey([
        {
          id: team[0]!.id,
          title: "Fix the parser",
          driver: ProviderDriverKind.make("acpRegistry"),
          providerInstanceId: ProviderInstanceId.make("devin"),
          model: "swe-2.1",
          modelSelection: { instanceId: ProviderInstanceId.make("devin"), model: "swe-2.1" },
          childThreadId: ThreadId.make("child-1"),
        },
      ]),
    );
    const info = authors.get(team[0]!.id);
    expect(info).toMatchObject({
      title: "Fix the parser",
      driver: "acpRegistry",
      childThreadId: "child-1",
    });
    expect(teamBoardAuthorLine({ name: "Sol", taskId: team[0]!.id }, info, "SWE-2.1")).toEqual({
      name: "Fix the parser",
      model: "SWE-2.1",
      open: "child-1",
    });
    // A member whose record paged out keeps its posted name and has nothing to open.
    expect(teamBoardAuthorLine({ name: "Sol", taskId: team[1]!.id }, undefined, null)).toEqual({
      name: "Sol",
      model: null,
      open: null,
    });
    expect(teamBoardAuthorLine({ name: "Lead" }, undefined, null).name).toBe("Lead");
    expect(teamBoardAuthorLine({ name: "Sam", user: true }, undefined, null).name).toBe("You");
  });
});

describe("team board conversations and roster", () => {
  const board = buildTeamBoardFixture({ phase: "team", subagents: team, now, details: true })!;
  const posts = board.posts!;

  it("says whom an addressed post is for", () => {
    expect(teamBoardAddressee(posts.find(({ id }) => id === "fx-3")!)).toEqual({
      kind: "member",
      name: "Sol",
    });
    expect(teamBoardAddressee({ ...posts[0]!, to: "you" })).toEqual({ kind: "you", name: "You" });
    expect(teamBoardAddressee({ ...posts[0]!, to: "lead" })?.name).toBe("Lead");
    expect(teamBoardAddressee(posts[0]!)).toBeNull();
  });

  it("shows only addressed posts and their threads under Direct", () => {
    const rows = teamBoardRows(posts, { filter: "direct" });
    // fx-1 is not addressed, but its replies are: they stand on their own under Direct.
    expect(rows.map(({ post }) => post.id).sort()).toEqual(["fx-3", "fx-8", "fx-9"]);
    expect(rows.every(({ post }) => teamBoardAddressee(post) !== null)).toBe(true);
  });

  it("filters to posts from or to one member", () => {
    const rows = teamBoardRows(posts, { filter: "all", taskId: sol, memberName: "Sol" });
    const ids = rows.flatMap(({ post, replies }) => [post.id, ...replies.map(({ id }) => id)]);
    // Its own claim and reply, Neon's two questions to it, and an overlap naming it.
    expect(ids).toEqual(expect.arrayContaining(["fx-1", "fx-2", "fx-3", "fx-8", "fx-9"]));
  });

  it("tells members with the same title apart by id", () => {
    const reviewers = [
      { ...team[0]!, title: "Reviewer" },
      { ...team[1]!, title: "Reviewer" },
    ];
    const second = reviewers[1]!.id;
    const question = (id: string, to: string, toTaskId: NodeId) => ({
      ...posts[0]!,
      id,
      kind: "question",
      to,
      toTaskId,
    });
    const asked = [
      question("q-1", "Reviewer", reviewers[0]!.id),
      question("q-2", "Reviewer #2", second),
    ];
    expect(teamBoardAddressedMember(reviewers, asked[1]!)?.id).toBe(second);
    const rows = teamBoardRows(asked, { filter: "all", taskId: second, memberName: "Reviewer" });
    expect(rows.map(({ post }) => post.id)).toEqual(["q-2"]);
  });

  it("puts only the selected repository's members on the roster", () => {
    const other = { ...team[2]!, status: "running" as const };
    const roster = teamBoardRoster([team[0]!, other], {
      active: true,
      postCount: 0,
      overlapCount: 0,
      presence: [],
      pushId: "web",
      repos: [
        { id: "web", name: "Web", members: [team[0]!.id] },
        { id: "server", name: "Server", members: [other.id] },
      ],
    });
    expect(roster.map(({ member }) => member.id)).toEqual([team[0]!.id]);
  });

  it("collapses a thread to its first post and reply count", () => {
    const rows = teamBoardRows(posts, { filter: "all" });
    const open = teamBoardListItems(rows);
    const thread = open.find(({ post }) => post.id === "fx-1")!;
    expect(thread).toMatchObject({ hasReplies: true, collapsed: false, endsThread: false });
    const closed = teamBoardListItems(rows, new Set(["fx-1"]));
    expect(closed.find(({ post }) => post.id === "fx-1")).toMatchObject({
      replyCount: 2,
      collapsed: true,
      endsThread: true,
    });
    expect(closed.some(({ post }) => post.replyTo === "fx-1")).toBe(false);
    expect(closed.length).toBe(open.length - 2);
  });

  it("lists the roster in task order with each member's state and what it holds", () => {
    const roster = teamBoardRoster(
      [...team.slice(0, 2), { ...team[2]!, status: "completed" }],
      board,
    );
    expect(roster.map(({ name, state, holds }) => [name, state, holds])).toEqual([
      ["Sol", "working", 2],
      ["Neon", "working", 3],
      ["Opus", "done", 1],
    ]);
    expect(teamBoardHoldsLabel(3)).toBe("3 files");
    expect(teamBoardHoldsLabel(1)).toBe("1 file");
    expect(teamBoardHoldsLabel(0)).toBeNull();
  });

  it("shows the QA board in a chat without subagents, with only what a shipped server sends", () => {
    const members = teamBoardFixtureMembers([]);
    expect(members.length).toBe(3);
    const solo = buildTeamBoardFixture({ phase: "team", subagents: members, now, details: true })!;
    expect(Object.keys(solo)).not.toEqual(
      expect.arrayContaining(["waits", "mergePlan", "questionsForYou"]),
    );
    expect(solo.posts?.some(({ kind, to }) => kind === "wait" || to === "you")).toBe(false);
    expect(buildTeamBoardFixtureSite({ subagents: members, now, details: true })).not.toBeNull();
  });
});

describe("seen marks and the wire shape", () => {
  it("the previous build's bare seen id survives upgrade and a second repository", () => {
    const single = {
      active: true,
      postCount: 1,
      overlapCount: 0,
      presence: [],
      latestPostId: "a-1",
    };
    const saved = JSON.parse(JSON.stringify({ thread: "a-1" })).thread as string;
    expect(teamBoardPill(single, saved)?.unread).toBe(false);
    const added = {
      ...single,
      postCount: 2,
      latestPostId: "b-1",
      repos: [
        { id: "A", name: "A", latestPostId: "a-1" },
        { id: "B", name: "B", latestPostId: "b-1" },
      ],
    };
    expect(teamBoardPill(added, saved)?.unread).toBe(true);
    const seen = markTeamBoardSeen(saved, { latestPostId: "b-1", repo: "B" });
    expect(teamBoardPill(added, seen)?.unread).toBe(false);
  });

  it("reading nine live repositories can clear the unread dot", () => {
    const repos = Array.from({ length: 9 }, (_, index) => ({
      id: "repo-" + index,
      name: "Repo " + index,
      latestPostId: "post-" + index,
    }));
    let seen: string | null = null;
    for (const { id, latestPostId } of repos) {
      seen = markTeamBoardSeen(seen, { repo: id, latestPostId });
    }
    expect(
      teamBoardPill(
        {
          active: true,
          postCount: repos.length,
          overlapCount: 0,
          presence: [],
          latestPostId: repos.at(-1)!.latestPostId,
          repos,
        },
        seen,
      )?.unread,
    ).toBe(false);
  });

  it("older board wire shape and the current wire shape decode each other's snapshots", () => {
    const prior = ReviewSchema.Struct({
      ...SnapshotContract.fields,
      posts: ReviewSchema.optionalKey(
        ReviewSchema.Array(
          PostContract.mapFields((fields) => {
            const { toTaskId: _newField, ...oldFields } = fields;
            return oldFields;
          }),
        ),
      ),
      repos: ReviewSchema.optionalKey(
        ReviewSchema.Array(
          ReviewSchema.Struct({
            id: ReviewSchema.String,
            name: ReviewSchema.String,
          }),
        ),
      ),
    });
    const legacy = {
      active: true,
      postCount: 1,
      overlapCount: 0,
      presence: [],
      posts: [
        {
          id: "post",
          author: { name: "Lead" },
          kind: "question",
          text: "Ready?",
          at: DateTime.makeUnsafe("2026-11-27T00:00:00.000Z"),
          to: "Neon",
        },
      ],
      repos: [{ id: "one", name: "One" }],
    };
    const task = NodeId.make("neon");
    const current = {
      ...legacy,
      posts: [{ ...legacy.posts[0], toTaskId: task }],
      repos: [{ ...legacy.repos[0], members: [task] }],
    };
    const upgraded = ReviewSchema.decodeUnknownSync(SnapshotContract)(legacy);
    const downgraded = ReviewSchema.decodeUnknownSync(prior)(current);
    expect(upgraded.posts?.[0]?.to).toBe("Neon");
    expect(upgraded.posts?.[0]?.toTaskId).toBeUndefined();
    expect(downgraded.posts?.[0]?.to).toBe("Neon");
    expect(downgraded.repos?.[0]?.id).toBe("one");
  });

  it("keeps a mark for each of 32 repositories, dropping the least recently viewed", () => {
    let seen: string | null = null;
    for (let index = 0; index < 33; index++)
      seen = markTeamBoardSeen(seen, { repo: `repo-${index}`, latestPostId: `post-${index}` });
    // Viewing repo-1 again keeps it; repo-0, viewed least recently, is the one dropped.
    seen = markTeamBoardSeen(seen, { repo: "repo-1", latestPostId: "post-1" });
    const marks = seen!.split(" ");
    expect(marks).toHaveLength(32);
    expect(marks[0]).toBe("repo-1=post-1");
    expect(marks).not.toContain("repo-0=post-0");
  });
});
