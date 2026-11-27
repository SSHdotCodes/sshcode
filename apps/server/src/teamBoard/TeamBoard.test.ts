import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { NodeId, RunId, TeamBoardSnapshot, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as ServerConfig from "../config.ts";
import { taskReference } from "../orchestration-v2/taskReference.ts";
import { writeAgentQualityArtifact } from "../orchestration-v2/testkit/AgentQualityRecorder.ts";
import * as TeamBoard from "./TeamBoard.ts";
import { BOARD_NOTICE_BYTES, BOARD_NOTICE_PREFIX, BOARD_USER_PREFIX } from "./TeamBoardMailbox.ts";
import {
  emptyLedger,
  EMPTY_BOARD_READ,
  TEAM_BOARD_CLAUSE,
  foldLedger,
  jsonBytes,
  POST_LIMIT,
  pruneLedger,
  RETENTION_MS,
  type BoardMember,
  type BoardTeam,
  type EditState,
} from "./model.ts";

const fixture = ServerConfig.layerTest(process.cwd(), { prefix: "team-board-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const layer = TeamBoard.layer.pipe(Layer.provideMerge(fixture));
const leadId = ThreadId.make("lead");
const member = (name: string): BoardMember & { readonly runId: RunId } => ({
  name,
  threadId: ThreadId.make(name),
  taskId: NodeId.make(`task-${name}`),
  runId: RunId.make(`run-${name}`),
  cwd: `/worktrees/${name}`,
  worktree: true,
});
const sol = member("Sol");
const neon = member("Neon");
const opus = member("Opus");
const team: BoardTeam = { leadId, repo: "waymark", members: [sol, neon, opus] };
const claim = (board: TeamBoard.TeamBoard["Service"], who: BoardMember, ...files: string[]) =>
  board.access(who.threadId, { post: { kind: "claim", text: "I will fix this", files } });
const history = (board: TeamBoard.TeamBoard["Service"]) =>
  board.subscribe({ threadId: leadId, details: true }).pipe(Stream.runHead);

it("keeps a pinned decision within the retention window when the journal reaches its post cap", () => {
  const at = DateTime.makeUnsafe(0);
  const author = { name: "User", user: true };
  let ledger = foldLedger(emptyLedger, {
    type: "post",
    stored: {
      repo: team.repo,
      post: {
        id: "decision",
        author,
        kind: "decision",
        text: "Use one error code",
        at,
        pinned: true,
      },
    },
    claims: [],
  });
  for (let i = 0; i < POST_LIMIT; i++) {
    ledger = foldLedger(ledger, {
      type: "post",
      stored: {
        repo: team.repo,
        post: { id: `note-${i}`, author, kind: "finding", text: "Note", at },
      },
      claims: [],
    });
  }
  expect(ledger.posts).toHaveLength(POST_LIMIT);
  expect(ledger.posts[0]?.post.id).toBe("decision");
  expect(ledger.posts[1]?.post.id).toBe("note-1");
  expect(pruneLedger(ledger, RETENTION_MS).posts).toEqual([]);
});

it.effect("requires two live siblings in a repository and leaves a single task off disk", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    yield* board.updateTeam({ ...team, members: [sol] });
    yield* board.updateTeam({ ...team, repo: "different", members: [neon] });
    expect(board.available(leadId)).toBe(false);
    expect(board.available(sol.threadId)).toBe(false);
    expect(board.needsGuidance(sol.threadId, sol.runId)).toBe(false);
    expect(yield* fs.exists(`${config.stateDir}/boards`)).toBe(false);
    yield* board.updateTeam(team);
    expect(board.available(leadId)).toBe(true);
    expect(board.needsGuidance(sol.threadId, sol.runId)).toBe(true);
    expect(board.needsGuidance(leadId, sol.runId)).toBe(false);
    yield* board.updateTeam({ ...team, members: [sol] });
    expect(board.available(leadId)).toBe(true);
    expect(board.available(sol.threadId)).toBe(true);
    yield* board.endRun(sol);
    expect(board.available(leadId)).toBe(false);
    expect(board.available(sol.threadId)).toBe(false);
  }).pipe(Effect.provide(layer)),
);

it.effect("serializes claims, preserves disjoint symbols, and releases only the recorded run", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    const results = yield* Effect.all(
      [claim(board, sol, "./settings.ts#first"), claim(board, neon, "settings.ts")],
      { concurrency: "unbounded" },
    );
    expect(results.filter((result) => result.conflicts)).toHaveLength(1);
    const owner = results[0].conflicts === undefined ? sol : neon;
    const other = owner === sol ? neon : sol;
    const notice = yield* Stream.runHead(board.notices);
    expect(notice._tag === "Some" && notice.value.threadId).toBe(owner.threadId);
    if (owner === sol)
      expect((yield* claim(board, other, "settings.ts#other")).conflicts).toBeUndefined();
    yield* board.endRun({ threadId: owner.threadId, runId: RunId.make("stale-run") });
    expect((yield* claim(board, other, "settings.ts#first")).conflicts).toHaveLength(1);
    yield* board.endRun(owner);
    expect((yield* claim(board, other, "settings.ts#first")).conflicts).toBeUndefined();
    yield* board.access(other.threadId, {
      post: { kind: "release", text: "Released", files: ["settings.ts#first"] },
    });
    expect(board.claimsFor(leadId).some((entry) => entry.file === "settings.ts#first")).toBe(false);
    expect(board.completion(leadId, owner.taskId)).toContain("settings.ts");
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps denied claims and delivers every byte of a large handoff across reads", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    const owner = { ...sol, name: "主".repeat(48) };
    yield* board.updateTeam({ ...team, members: [owner, neon, opus] });
    yield* board.postUser({ threadId: leadId, text: "例".repeat(130), decision: true });
    const file = `lib/${"名".repeat(130)}.ts`;
    yield* claim(board, owner, file);
    const denied = yield* claim(board, neon, file);
    expect(jsonBytes(denied)).toBeLessThanOrEqual(1_200);
    expect(denied.conflicts?.[0]).toMatchObject({ file, owner: owner.name });
    const text = "🎲".repeat(130);
    yield* board.access(owner.threadId, {
      post: { kind: "done", text, files: [file], commit: "abcdef123456" },
    });

    const pieces = [];
    for (let read = 0; read < 10; read++) {
      const page = yield* board.access(opus.threadId, {});
      expect(jsonBytes(page)).toBeLessThanOrEqual(1_200);
      expect(page.posts[0]?.pinned).toBe(true);
      pieces.push(...page.posts.filter((post) => post.kind === "done"));
      if (page.more === undefined) break;
    }
    expect(pieces.map(({ text }) => text).join("")).toBe(text);
    expect(pieces.flatMap(({ files }) => files ?? [])).toEqual([file]);
    expect(pieces[0]?.commit).toBe("abcdef123456");
    expect((yield* board.access(opus.threadId, {})).posts.map(({ kind }) => kind)).toEqual([
      "decision",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "prioritizes a targeted reply and lead posts while retaining unread rows under the byte cap",
  () =>
    Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      yield* board.updateTeam(team);
      yield* board.access(sol.threadId, { post: { kind: "finding", text: "my own row" } });
      const original = (yield* board.access(neon.threadId, {})).posts[0]!;
      for (let i = 0; i < 7; i += 1) {
        yield* board.access(opus.threadId, {
          post: { kind: "finding", text: `old ${i} ${"x".repeat(260)}` },
        });
      }
      yield* board.access(leadId, { post: { kind: "finding", text: "Lead precedence" } });
      yield* board.access(neon.threadId, {
        post: { kind: "question", text: "Targeted reply" },
        replyTo: original.id,
      });
      const first = yield* board.access(sol.threadId, {});
      expect(first.posts.slice(0, 2).map(({ text }) => text)).toEqual([
        "Targeted reply",
        "Lead precedence",
      ]);
      expect(first.more).toBeGreaterThan(0);
      expect(jsonBytes(first)).toBeLessThanOrEqual(1200);
      const all = [...first.posts];
      let next = first;
      while (next.more !== undefined) {
        next = yield* board.access(sol.threadId, {});
        expect(jsonBytes(next)).toBeLessThanOrEqual(1200);
        all.push(...next.posts);
      }
      expect(new Set(all.map(({ id }) => id)).size).toBe(9);
      expect(yield* board.access(sol.threadId, {})).toEqual({
        posts: [],
        notice: EMPTY_BOARD_READ,
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("batches targeted questions for two minutes and sends user posts at once", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    yield* board.access(sol.threadId, { post: { kind: "finding", text: "General information" } });
    yield* board.access(sol.threadId, {
      post: { kind: "question", text: "A question", to: neon.name, files: ["index.ts"] },
    });
    const notice = yield* Stream.runHead(board.notices);
    expect(notice._tag === "Some" && notice.value).toMatchObject({
      threadId: neon.threadId,
      text: expect.stringMatching(
        /^SSHCode team board .*Sol asked you about index\.ts \(reply [a-f0-9]+\)\. A question$/u,
      ),
    });
    yield* board.access(sol.threadId, {
      post: { kind: "question", text: "Another question", to: neon.name, files: ["other.ts"] },
    });
    yield* TestClock.adjust("119 seconds");
    yield* board.tick;
    yield* board.postUser({
      threadId: leadId,
      text: "Keep the file format",
      clientRequestId: "format",
    });
    yield* board.postUser({
      threadId: leadId,
      text: "Keep the file format",
      clientRequestId: "format",
    });
    const users = yield* board.notices.pipe(Stream.take(3), Stream.runCollect);
    expect(users.map(({ threadId }) => threadId)).toEqual([
      sol.threadId,
      neon.threadId,
      opus.threadId,
    ]);
    expect(users.every(({ text }) => text === BOARD_USER_PREFIX + "Keep the file format")).toBe(
      true,
    );
    yield* TestClock.adjust("1 second");
    yield* board.tick;
    const after = yield* Stream.runHead(board.notices);
    expect(after._tag === "Some" && after.value).toMatchObject({
      threadId: neon.threadId,
      text: expect.stringMatching(
        /^SSHCode team board .*Sol asked you about other\.ts \(reply [a-f0-9]+\)\. Another question$/u,
      ),
    });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "pins owned decisions, suggests duplicate findings, and routes a commit to affected siblings",
  () =>
    Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      yield* board.updateTeam(team);
      yield* claim(board, sol, "rules.ts#tags");
      yield* claim(board, neon, "rules.ts#ranges");
      const forbidden = yield* Effect.result(
        board.access(sol.threadId, {
          post: { kind: "decision", text: "Use a shared error", files: ["rules.ts"] },
        }),
      );
      expect(forbidden._tag).toBe("Failure");
      const first = yield* board.access(sol.threadId, {
        post: { kind: "decision", text: "Use lowercase tags", files: ["rules.ts#tags"] },
      });
      const pinned = first.posts.find((post) => post.pinned)!;
      yield* board.access(sol.threadId, {
        post: { kind: "decision", text: "Use upper case tags", files: ["rules.ts#tags"] },
        replyTo: pinned.id,
      });
      expect((yield* board.access(neon.threadId, {})).posts[0]).toMatchObject({
        text: "Use upper case tags",
        pinned: true,
      });
      expect((yield* board.access(neon.threadId, {})).posts.map(({ text }) => text)).toEqual([
        "Use upper case tags",
      ]);
      yield* board.access(sol.threadId, {
        post: { kind: "finding", text: "Parsing ignores duplicate tags", files: ["rules.ts"] },
      });
      expect(
        (yield* board.access(neon.threadId, {
          post: {
            kind: "finding",
            text: "Parsing ignores duplicate tags in output",
            files: ["rules.ts#ranges"],
          },
        })).notice,
      ).toContain("Looks like Sol's finding");
      yield* board.access(sol.threadId, {
        post: { kind: "done", text: "the rules", files: ["rules.ts"], commit: "abc1234" },
      });
      const early = yield* board.notices.pipe(Stream.take(2), Stream.runCollect);
      expect(early.every(({ text }) => !text.includes("abc1234"))).toBe(true);
      yield* TestClock.adjust("120 seconds");
      yield* board.tick;
      const notices = yield* board.notices.pipe(Stream.take(2), Stream.runCollect);
      const batch = notices.find(({ threadId }) => threadId === neon.threadId)?.text;
      expect(batch).toContain("Use upper case tags");
      expect(batch).toContain("Sol handed off abc1234 (rules.ts).");
      expect(board.claimsFor(leadId).map(({ memberId }) => memberId)).toEqual([neon.taskId]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps edit presence, escalates an overlap once, and includes the merge plan at the last hand-back",
  () =>
    Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      yield* board.updateTeam(team);
      const now = yield* Clock.currentTimeMillis;
      const edit = (head: string, start: number): EditState => ({
        head,
        signature: head,
        committed: new Set(["rules.ts"]),
        changedAt: now,
        files: [{ path: "rules.ts", ranges: [{ start, end: start + 5 }] }],
      });
      const edits = new Map([
        [sol.threadId, edit("a", 40)],
        [neon.threadId, edit("b", 50)],
      ]);
      const pair = { a: sol.taskId, b: neon.taskId, path: "rules.ts", severity: 1 };
      yield* board.updateEdits({ team, edits, pairs: [pair] });
      yield* board.updateEdits({ team, edits, pairs: [pair] });
      yield* board.updateEdits({ team, edits, pairs: [{ ...pair, severity: 2, confirmed: true }] });
      yield* TestClock.adjust("2 minutes");
      yield* board.tick;
      const notices = yield* board.notices.pipe(Stream.take(4), Stream.runCollect);
      expect(notices.map(({ text }) => text)).toEqual([
        BOARD_NOTICE_PREFIX +
          "Neon is also changing rules.ts (lines 50–55). Coordinate before continuing.",
        BOARD_NOTICE_PREFIX +
          "Sol is also changing rules.ts (lines 40–45). Coordinate before continuing.",
        BOARD_NOTICE_PREFIX + "Neon will conflict in rules.ts. Coordinate before continuing.",
        BOARD_NOTICE_PREFIX + "Sol will conflict in rules.ts. Coordinate before continuing.",
      ]);
      const active = yield* history(board);
      expect(active._tag === "Some" && active.value).toMatchObject({
        overlapCount: 1,
        files: [{ path: "rules.ts", willConflict: true }],
      });
      yield* TestClock.adjust("10 minutes");
      yield* board.tick;
      const stale = yield* history(board);
      expect(stale._tag === "Some" && stale.value.presence).toEqual([]);
      yield* board.endRun(sol);
      yield* board.endRun(neon);
      yield* board.endRun(opus);
      expect(board.completion(leadId, opus.taskId)).toContain("Board merge plan:");
      expect(board.completion(leadId, opus.taskId)).toContain("Sol/Neon rules.ts");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "replays posts, active claims, unread cursors and stats after restart and retains read-only history",
  () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* Effect.gen(function* () {
        const board = yield* TeamBoard.TeamBoard;
        yield* board.updateTeam(team);
        yield* claim(board, sol, "settings.ts");
        expect((yield* board.access(neon.threadId, {})).posts).toHaveLength(1);
      }).pipe(Effect.provide(TeamBoard.layer));
      const boardPath = path.join(config.stateDir, "boards", "lead.jsonl");
      yield* fileSystem.writeFileString(boardPath, "{partial", { flag: "a" });
      yield* Effect.gen(function* () {
        const board = yield* TeamBoard.TeamBoard;
        const checkpoint = yield* fileSystem.readFileString(
          path.join(config.stateDir, "boards", "stats.jsonl"),
        );
        expect(checkpoint).toContain('"claims":1,"conflicts":0,"postsWritten":1,"postsRead":1');
        yield* board.updateTeam({
          ...team,
          members: [
            { ...sol, runId: RunId.make("resumed-sol"), resumedFrom: [sol.runId] },
            neon,
            opus,
          ],
        });
        expect(yield* board.access(neon.threadId, {})).toEqual({
          posts: [],
          notice: EMPTY_BOARD_READ,
        });
        expect((yield* claim(board, neon, "settings.ts#parser")).conflicts?.[0]?.owner).toBe(
          sol.name,
        );
        yield* board.lateNotice({ leadId, repo: team.repo, file: "settings.ts" });
        yield* board.updateTeam({ ...team, members: [] });
        const saved = yield* history(board);
        expect(saved._tag === "Some" && saved.value).toMatchObject({
          active: false,
          postCount: 2,
          presence: [],
        });
        expect(
          (yield* Effect.result(board.postUser({ threadId: leadId, text: "Closed" })))._tag,
        ).toBe("Failure");
      }).pipe(Effect.provide(TeamBoard.layer));
      const result = yield* fileSystem.readFileString(
        path.join(config.stateDir, "boards", "stats.jsonl"),
      );
      expect(result).toContain(
        '"claims":1,"conflicts":1,"postsWritten":2,"postsRead":1,"lateNotices":1',
      );
    }).pipe(Effect.provide(fixture)),
);

it.effect(
  "reserves a staggered sibling's claim through multiple restarts and resolves its task handle",
  () =>
    Effect.gen(function* () {
      const owner = { ...opus, taskId: NodeId.make("node:delegated-task:original-opus") };
      yield* Effect.gen(function* () {
        const board = yield* TeamBoard.TeamBoard;
        yield* board.updateTeam({ ...team, members: [sol, neon, owner] });
        yield* claim(board, owner, "settings.ts");
      }).pipe(Effect.provide(TeamBoard.layer));
      yield* Effect.gen(function* () {
        const board = yield* TeamBoard.TeamBoard;
        yield* board.updateTeam({
          ...team,
          members: [sol, neon],
          pendingMembers: new Map([[owner.taskId, owner.name]]),
        });
        expect((yield* claim(board, sol, "settings.ts")).conflicts?.[0]?.owner).toBe(owner.name);
        const resumed = {
          ...owner,
          runId: RunId.make("third-opus"),
          resumedFrom: [RunId.make("second-opus"), owner.runId],
        };
        yield* board.updateTeam({ ...team, members: [sol, neon, resumed] });
        expect((yield* claim(board, neon, "settings.ts")).conflicts?.[0]?.owner).toBe(owner.name);
        yield* board.endRun(resumed);
        expect(board.completion(leadId, taskReference(owner.taskId))).toContain("settings.ts");
        expect((yield* claim(board, sol, "settings.ts")).conflicts).toBeUndefined();
      }).pipe(Effect.provide(TeamBoard.layer));
    }).pipe(Effect.provide(fixture)),
);

it.effect("opens a fresh push and preserves the first push under its own history ID", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    // Push 1.
    yield* board.updateTeam(team);
    yield* board.postUser({ threadId: leadId, text: "Use error code E_TAGS", decision: true });
    yield* claim(board, sol, "settings.ts");
    yield* claim(board, neon, "settings.ts");
    yield* board.access(neon.threadId, {
      post: { kind: "finding", text: "Parser drops duplicate tags", files: ["parser.ts"] },
    });
    yield* board.endRun(sol);
    yield* board.endRun(neon);
    yield* board.endRun(opus);
    yield* board.updateTeam({ ...team, members: [] });

    // Push 2, hours later, brand-new subagents and briefs.
    yield* TestClock.adjust("3 hours");
    const kai = member("Kai");
    const lux = member("Lux");
    yield* board.updateTeam({ leadId, repo: team.repo, members: [kai, lux] });

    const summary = yield* board.subscribe({ threadId: leadId }).pipe(Stream.runHead);
    if (summary._tag !== "Some") throw new Error("Expected the second push");
    expect(summary.value).toMatchObject({ active: true, postCount: 0, overlapCount: 0 });
    const [previous] = summary.value.history ?? [];
    expect(previous?.members).toEqual(["Sol", "Neon", "Opus"]);
    expect(previous?.id).not.toBe(summary.value.pushId);
    const archived = yield* board
      .subscribe({ threadId: leadId, details: true, pushId: previous!.id })
      .pipe(Stream.runHead);
    expect(archived._tag === "Some" && archived.value).toMatchObject({
      active: false,
      postCount: 4,
      overlapCount: 1,
    });
    expect(
      archived._tag === "Some" &&
        archived.value.posts?.some(
          ({ text, pinned }) => text === "Use error code E_TAGS" && pinned,
        ),
    ).toBe(true);
    expect(yield* board.access(kai.threadId, {})).toEqual({ posts: [], notice: EMPTY_BOARD_READ });
    const dup = yield* board.access(lux.threadId, {
      post: { kind: "finding", text: "Parser drops duplicate tags here", files: ["parser.ts"] },
    });
    expect(dup.notice).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

it.effect("grants unheld files in a partial claim and reports the granted and denied paths", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    yield* claim(board, sol, "a.ts");
    const denied = yield* claim(board, neon, "a.ts", "b.ts");
    expect(denied.claimed).toEqual(["b.ts"]);
    expect(denied.conflicts?.map(({ file, owner }) => [file, owner])).toEqual([["a.ts", "Sol"]]);
    expect(denied.notice).toContain("Claimed b.ts. Not granted: a.ts (Sol holds it: ");
    expect(
      board
        .claimsFor(leadId)
        .filter(({ memberId }) => memberId === neon.taskId)
        .map(({ file }) => file),
    ).toEqual(["b.ts"]);
    expect((yield* claim(board, opus, "b.ts")).conflicts?.[0]?.owner).toBe("Neon");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps an ended sibling in Files and in the overlap count through the end of the push",
  () =>
    Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      yield* board.updateTeam(team);
      yield* claim(board, sol, "rules.ts#tags");
      const now = yield* Clock.currentTimeMillis;
      const edit = (start: number): EditState => ({
        head: "h",
        signature: `s${start}`,
        committed: new Set(),
        changedAt: now,
        files: [{ path: "rules.ts", ranges: [{ start, end: start + 5 }] }],
      });
      const edits = new Map([
        [sol.threadId, edit(40)],
        [neon.threadId, edit(44)],
      ]);
      const pair = { a: sol.taskId, b: neon.taskId, path: "rules.ts", severity: 1 };
      yield* board.updateEdits({ team, edits, pairs: [pair] });
      const before = yield* board
        .subscribe({ threadId: leadId, details: true })
        .pipe(Stream.runHead);
      expect(before._tag === "Some" && before.value.files?.map(({ path }) => path)).toEqual([
        "rules.ts",
      ]);
      yield* board.endRun(sol);
      // The runtime recomputes pairs over all participants, so the pair survives the run end.
      yield* board.updateEdits({ team, edits, pairs: [pair] });
      const after = yield* board
        .subscribe({ threadId: leadId, details: true })
        .pipe(Stream.runHead);
      expect(after._tag === "Some" && after.value).toMatchObject({ active: true, overlapCount: 1 });
      expect(after._tag === "Some" && after.value.files).toMatchObject([
        {
          path: "rules.ts",
          agents: [
            { author: { name: "Sol" }, claims: ["rules.ts#tags"] },
            { author: { name: "Neon" } },
          ],
        },
      ]);
      const presence = yield* board
        .subscribe({ threadId: leadId, presenceOnly: true })
        .pipe(Stream.runHead);
      expect(
        presence._tag === "Some" && presence.value.presence.map(({ taskId }) => taskId),
      ).toEqual([neon.taskId]);
    }).pipe(Effect.provide(layer)),
);

it.effect("writes a user reply only to the push with its parent post", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    const kai = member("Kai");
    const lux = member("Lux");
    yield* board.updateTeam(team);
    yield* board.updateTeam({ leadId, repo: "second-repo", members: [kai, lux] });
    const posts = Effect.map(
      board.subscribe({ threadId: leadId, details: true }).pipe(Stream.runHead),
      (option) => (option._tag === "Some" ? (option.value.posts ?? []) : []),
    );
    yield* board.access(sol.threadId, { post: { kind: "question", text: "JSON or YAML?" } });
    const target = (yield* posts).find(({ text }) => text === "JSON or YAML?")!;
    const reply = yield* Effect.result(
      board.postUser({ threadId: leadId, text: "JSON", replyTo: target.id, clientRequestId: "r" }),
    );
    expect(reply._tag).toBe("Success");
    expect(
      (yield* posts).filter(({ text, author }) => text === "JSON" && author.user),
    ).toHaveLength(1);
    expect((yield* board.access(kai.threadId, {})).posts).toEqual([]);
    expect(board.hasNotices(kai.threadId)).toBe(false);
    yield* board.endRun(sol);
    expect((yield* posts).map(({ text }) => text)).toContain("JSON");
  }).pipe(Effect.provide(layer)),
);

it.effect("assigns stable unique sibling names for targeted posts", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    const a = { ...member("A"), name: "claude-opus-5-5" };
    const b = { ...member("B"), name: "claude-opus-5-5" };
    const c = member("C");
    yield* board.updateTeam({ leadId, repo: team.repo, members: [a, b, c] });
    yield* claim(board, a, "x.ts");
    const denied = yield* claim(board, b, "x.ts");
    expect(denied.conflicts?.[0]?.owner).toBe(a.name);
    const oldNotice = board.reserveNotices(a.threadId)!;
    yield* oldNotice.finish(true);
    const read = yield* board.access(c.threadId, {
      post: { kind: "question", text: "Are you done?", to: "claude-opus-5-5 #2" },
    });
    expect(board.reserveNotices(b.threadId)?.text).toContain("C asked you");
    expect(board.hasNotices(a.threadId)).toBe(false);
    expect([
      ...new Set(read.posts.filter(({ kind }) => kind === "claim").map(({ by }) => by)),
    ]).toEqual(["claude-opus-5-5", "claude-opus-5-5 #2"]);
  }).pipe(Effect.provide(layer)),
);

it.effect("sends only one new post and one eviction on a 300-post subscription", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    const write = (i: number) =>
      board.access([sol, neon, opus][i % 3]!.threadId, {
        post: { kind: "finding", text: "x".repeat(280), files: [`src/area-${i % 7}/file-${i}.ts`] },
      });
    for (let i = 0; i < 300; ++i) yield* write(i);
    const ready = yield* Deferred.make<void>();
    const stream = yield* board.subscribe({ threadId: leadId, details: true, delta: true }).pipe(
      Stream.tap(() => Deferred.succeed(ready, undefined)),
      Stream.take(2),
      Stream.runCollect,
      Effect.forkScoped,
    );
    yield* Deferred.await(ready);
    yield* write(300);
    const [initial, update] = yield* Fiber.join(stream);
    expect(initial?.posts).toHaveLength(300);
    expect(update).toMatchObject({
      delta: true,
      postCount: 300,
      posts: [{ files: ["src/area-6/file-300.ts"] }],
      removedPostIds: [initial?.posts?.at(-1)?.id],
    });
    expect(update?.files).toBeUndefined();
    expect(initial?.presence).toEqual([]);
    expect(jsonBytes(initial)).toBeGreaterThan(100_000);
    const encode = Schema.encodeEffect(TeamBoardSnapshot);
    const fullBytes = jsonBytes(yield* encode(initial!));
    const deltaBytes = jsonBytes(yield* encode(update!));
    expect(deltaBytes).toBeLessThan(800);
    yield* Effect.promise(() =>
      writeAgentQualityArtifact("team-board-300-post-update", {
        initial: fullBytes,
        update: deltaBytes,
      }),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "lets the last sibling post a handoff and frees the lead's tool at the push boundary",
  () =>
    Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      yield* board.updateTeam({ ...team, members: [sol, neon] });
      yield* claim(board, sol, "rules.ts");
      yield* board.endRun(neon);
      expect(board.completion(leadId, neon.taskId)).toBe("");
      expect(board.available(sol.threadId)).toBe(true);
      expect(board.available(leadId)).toBe(true);
      yield* board.access(sol.threadId, {
        post: { kind: "done", text: "rules fixed", files: ["rules.ts"], commit: "abc1234" },
      });
      yield* board.endRun(sol);
      expect(board.available(leadId)).toBe(false);
      expect(board.completion(leadId, sol.taskId)).toContain("handoffs abc1234");
      expect(board.completion(leadId, sol.taskId)).toContain("Board merge plan:");
    }).pipe(Effect.provide(layer)),
);

it.effect("keeps rejected guidance and user messages in the mailbox across restart", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      yield* board.updateTeam(team);
      yield* board.queueGuidance(sol.threadId, sol.runId);
      yield* board.queueGuidance(sol.threadId, sol.runId);
      const guidance = yield* Stream.runHead(board.notices);
      if (guidance._tag !== "Some") throw new Error("Expected guidance");
      const steer = board.reserveSteer(sol.threadId, "team-board:" + guidance.value.id)!;
      expect(steer.text).toContain(BOARD_NOTICE_PREFIX + TEAM_BOARD_CLAUSE + " Board is empty.");
      expect(board.reserveNotices(sol.threadId)).toBeUndefined();
      yield* steer.finish(false);
      expect(board.needsGuidance(sol.threadId, sol.runId)).toBe(true);
      yield* board.postUser({ threadId: leadId, text: "Keep existing keys" });
    }).pipe(Effect.provide(TeamBoard.layer));
    yield* Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      yield* board.updateTeam(team);
      const nextTurn = board.reserveNotices(sol.threadId, sol.runId)!;
      expect(nextTurn.text.split("\n")).toHaveLength(2);
      expect(nextTurn.text).toContain(BOARD_USER_PREFIX + "Keep existing keys");
      yield* nextTurn.finish(false);
      expect(board.needsGuidance(sol.threadId, sol.runId)).toBe(true);
      yield* board.reserveNotices(sol.threadId, sol.runId)!.finish(true);
      expect(board.needsGuidance(sol.threadId, sol.runId)).toBe(false);
      expect(board.hasNotices(sol.threadId)).toBe(false);
      expect(board.hasNotices(neon.threadId)).toBe(true);
    }).pipe(Effect.provide(TeamBoard.layer));
  }).pipe(Effect.provide(fixture)),
);

it.effect("keeps a clean merge in Files without issuing a notice or an amber count", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    const now = yield* Clock.currentTimeMillis;
    const edit = (head: string): EditState => ({
      head,
      signature: head,
      committed: new Set(["rules.ts"]),
      changedAt: now,
      files: [{ path: "rules.ts", ranges: [{ start: 40, end: 45 }] }],
    });
    yield* board.updateEdits({
      team,
      edits: new Map([
        [sol.threadId, edit("a")],
        [neon.threadId, edit("b")],
      ]),
      pairs: [{ a: sol.taskId, b: neon.taskId, path: "rules.ts", severity: 1, confirmed: false }],
    });
    expect(board.hasNotices(sol.threadId)).toBe(false);
    expect(board.hasNotices(neon.threadId)).toBe(false);
    const details = yield* history(board);
    expect(details._tag === "Some" && details.value).toMatchObject({
      overlapCount: 0,
      files: [{ path: "rules.ts", willConflict: false }],
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("replays overlap details for a departed sibling while the same push resumes", () =>
  Effect.gen(function* () {
    const original = { ...team, members: [sol, neon] };
    yield* Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      yield* board.updateTeam(original);
      yield* claim(board, sol, "rules.ts#tags");
      const edit: EditState = {
        head: "a",
        signature: "edits",
        changedAt: yield* Clock.currentTimeMillis,
        committed: new Set(),
        files: [{ path: "rules.ts", ranges: [{ start: 40, end: 45 }] }],
      };
      yield* board.updateEdits({
        team: original,
        edits: new Map([
          [sol.threadId, edit],
          [neon.threadId, edit],
        ]),
        pairs: [{ a: sol.taskId, b: neon.taskId, path: "rules.ts", severity: 1 }],
      });
      yield* board.endRun(sol);
      yield* board.updateTeam({ ...team, members: [neon] });
    }).pipe(Effect.provide(TeamBoard.layer));
    yield* Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      const resumed = { ...neon, runId: RunId.make("resumed-neon"), resumedFrom: [neon.runId] };
      yield* board.updateTeam({ ...team, members: [resumed] });
      const snapshot = yield* history(board);
      expect(snapshot._tag === "Some" && snapshot.value).toMatchObject({
        active: true,
        overlapCount: 1,
        files: [
          {
            path: "rules.ts",
            agents: [
              {
                author: { name: "Sol" },
                claims: ["rules.ts#tags"],
                ranges: [{ start: 40, end: 45 }],
              },
              { author: { name: "Neon" }, ranges: [{ start: 40, end: 45 }] },
            ],
          },
        ],
      });
      expect(board.claimsFor(leadId)).toEqual([]);
    }).pipe(Effect.provide(TeamBoard.layer));
  }).pipe(Effect.provide(fixture)),
);

it.effect("a batched handoff remains queued through restart until the two-minute deadline", () =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      yield* board.updateTeam(team);
      yield* claim(board, neon, "rules.ts");
      yield* board.access(sol.threadId, {
        post: { kind: "question", text: "Can you check rules.ts?", to: neon.name },
      });
      const first = board.reserveNotices(neon.threadId)!;
      yield* first.finish(true);
      yield* board.access(sol.threadId, {
        post: { kind: "done", text: "fixed the rules", files: ["rules.ts"], commit: "abc1234" },
      });
      expect(board.reserveNotices(neon.threadId)).toBeUndefined();
    }).pipe(Effect.provide(TeamBoard.layer));
    yield* Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      yield* board.updateTeam(team);
      yield* TestClock.adjust("119 seconds");
      yield* board.tick;
      expect(board.reserveNotices(neon.threadId)).toBeUndefined();
      yield* TestClock.adjust("1 second");
      yield* board.tick;
      const handoff = board.reserveNotices(neon.threadId);
      expect(handoff?.text).toBe(BOARD_NOTICE_PREFIX + "Sol handed off abc1234 (rules.ts).");
      yield* handoff!.finish(true);
      expect(board.reserveNotices(neon.threadId)).toBeUndefined();
    }).pipe(Effect.provide(TeamBoard.layer));
  }).pipe(Effect.provide(fixture)),
);

it.effect("includes live claims and current pinned decisions in bounded kickoff guidance", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    yield* claim(board, sol, "settings.ts#parse");
    yield* board.postUser({ threadId: leadId, text: "Use E_TAGS", decision: true });
    const posted = board.reserveNotices(neon.threadId)!;
    yield* posted.finish(true);
    yield* board.queueGuidance(neon.threadId, neon.runId);
    const kickoff = board.reserveNotices(neon.threadId, neon.runId)!;
    expect(kickoff.text).toContain("with your next SSHCode tool result. Don't poll with read.");
    expect(kickoff.text).toContain("Pinned decisions: User: Use E_TAGS.");
    expect(kickoff.text).toContain("Live claims: Sol holds settings.ts#parse.");
    expect(Buffer.byteLength(kickoff.text)).toBeLessThanOrEqual(BOARD_NOTICE_BYTES);
    expect(kickoff.text).not.toContain("Board is empty.");
    yield* kickoff.finish(true);
    yield* board.queueGuidance(neon.threadId, neon.runId);
    expect(board.reserveNotices(neon.threadId, neon.runId)).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

it.effect("returns unread posts in each write and releases every owned claim on done", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    yield* claim(board, neon, "neon.ts");
    for (const post of [
      { kind: "claim", text: "Claim two files", files: ["first.ts", "second.ts", "third.ts"] },
      { kind: "finding", text: "A local diagnostic" },
      { kind: "release", text: "I can free this file early", files: ["first.ts"] },
      { kind: "done", text: "Ready to merge", files: ["second.ts"], commit: "abcdef1" },
    ] as const) {
      const incoming = `Fresh finding before ${post.kind}`;
      yield* board.access(neon.threadId, { post: { kind: "finding", text: incoming } });
      const receipt = yield* board.access(sol.threadId, { post });
      expect(receipt.posts.map(({ text }) => text)).toContain(incoming);
      if (post.kind === "release")
        expect(
          board
            .claimsFor(leadId)
            .filter(({ memberId }) => memberId === sol.taskId)
            .map(({ file }) => file),
        ).toEqual(["second.ts", "third.ts"]);
    }
    expect(board.claimsFor(leadId).map(({ file }) => file)).toEqual(["neon.ts"]);
    expect(yield* board.access(sol.threadId, {})).toEqual({ posts: [], notice: EMPTY_BOARD_READ });
  }).pipe(Effect.provide(layer)),
);

it.effect("pushes the post itself and keeps it unread until the provider accepts delivery", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    yield* board.access(sol.threadId, {
      post: { kind: "question", text: "Keep JSON keys in their existing order?", to: neon.name },
    });
    const pending = board.reserveNotices(neon.threadId)!;
    expect(pending.text).toContain("Keep JSON keys in their existing order?");
    yield* pending.finish(false);
    const retry = board.reserveNotices(neon.threadId)!;
    expect(retry.text).toBe(pending.text);
    yield* retry.finish(true);
    expect(yield* board.access(neon.threadId, {})).toEqual({ posts: [], notice: EMPTY_BOARD_READ });
    expect((yield* board.access(opus.threadId, {})).posts.map(({ text }) => text)).toEqual([
      "Keep JSON keys in their existing order?",
    ]);
  }).pipe(Effect.provide(layer)),
);

it.effect("delivers the actual batched posts and leaves overflow for the next tool result", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    yield* board.access(sol.threadId, {
      post: { kind: "question", text: "Kickoff", to: neon.name },
    });
    yield* Stream.runHead(board.notices);
    yield* board.reserveNotices(neon.threadId)!.finish(true);
    for (let i = 1; i <= 4; i++)
      yield* board.access(sol.threadId, {
        post: { kind: "question", to: neon.name, text: `Question ${i}. ${"x".repeat(255)}` },
      });
    yield* TestClock.adjust("2 minutes");
    yield* board.tick;
    const scheduled = yield* Stream.runHead(board.notices);
    if (scheduled._tag !== "Some") throw new Error("Expected a batched steer");
    expect(Buffer.byteLength(scheduled.value.text)).toBeLessThanOrEqual(BOARD_NOTICE_BYTES);
    expect(scheduled.value.text).toContain("Question 1.");
    expect(scheduled.value.text).toContain("Question 2.");
    expect(scheduled.value.text).toContain("Question 3.");
    expect(scheduled.value.text).not.toContain("Question 4.");
    yield* board.reserveSteer(neon.threadId, `team-board:${scheduled.value.id}`)!.finish(true);
    const attached = board.reserveNotices(neon.threadId)!;
    expect(attached.text).toContain("Question 4.");
    yield* attached.finish(true);
    expect(yield* board.access(neon.threadId, {})).toEqual({ posts: [], notice: EMPTY_BOARD_READ });
  }).pipe(Effect.provide(layer)),
);

it.effect("discards notices when a member's run or push ends", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    yield* board.access(neon.threadId, {
      post: { kind: "question", text: "Which file owns the parser?", to: sol.name },
    });
    expect(board.hasNotices(sol.threadId)).toBe(true);
    const followUp = RunId.make("run-Sol-followup");
    expect(board.reserveNotices(sol.threadId, followUp)).toBeUndefined();
    expect(board.hasNotices(sol.threadId)).toBe(true);
    board.endRunNotices(sol.threadId, sol.runId);
    expect(board.reserveNotices(sol.threadId, sol.runId)).toBeUndefined();
    expect(board.hasNotices(sol.threadId)).toBe(false);
    yield* board.endRun(sol);
    expect(board.available(leadId)).toBe(true);
    expect(board.reserveNotices(sol.threadId, followUp)).toBeUndefined();
    expect(board.hasNotices(sol.threadId)).toBe(false);
    yield* board.endRun(neon);
    yield* board.endRun(opus);
    expect(board.reserveNotices(sol.threadId, followUp)).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

it.effect("writes the merge plan when the last member of this repository ends", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam({
      ...team,
      members: [sol, neon],
      pendingMembers: new Map([[opus.taskId, "Outside repo"]]),
    });
    yield* claim(board, sol, "a.ts");
    yield* board.endRun(sol);
    yield* board.endRun(neon);
    expect(board.available(leadId)).toBe(false);
    expect(board.completion(leadId, neon.taskId)).toContain("merge plan");
    const archived = yield* history(board);
    expect(archived._tag === "Some" && archived.value).toMatchObject({ active: false });
  }).pipe(Effect.provide(layer)),
);

it.effect("retains a chat's name across follow-up tasks and sends it addressed posts", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    yield* claim(board, sol, "a.ts");
    yield* board.endRun(sol);
    const followUp = {
      ...sol,
      name: "Different title",
      taskId: NodeId.make("new-task"),
      runId: RunId.make("new-run"),
    };
    yield* board.updateTeam({ ...team, members: [followUp, neon, opus] });
    yield* board.access(neon.threadId, {
      post: { kind: "question", text: "Is your patch ready?", to: "Sol" },
    });
    const received = board.reserveNotices(followUp.threadId, followUp.runId);
    expect(received?.text).toContain("Is your patch ready?");
    expect(
      board.observeTeam(followUp.threadId)?.members.find(({ taskId }) => taskId === followUp.taskId)
        ?.name,
    ).toBe("Sol");
  }).pipe(Effect.provide(layer)),
);

it.effect("reads across live repositories and keeps writes scoped to the selected board", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    const kai = member("Kai"),
      lux = member("Lux");
    yield* board.updateTeam({ ...team, repoName: "Web" });
    yield* board.updateTeam({
      leadId,
      repo: "another-repo",
      repoName: "Server",
      members: [kai, lux],
    });
    yield* claim(board, sol, "web.ts");
    yield* claim(board, neon, "web.ts");
    yield* claim(board, lux, "server.ts");
    yield* claim(board, kai, "server.ts");
    yield* board.access(kai.threadId, { post: { kind: "question", text: "Which API version?" } });
    const read = yield* board.access(leadId, {});
    expect(read.posts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ by: "Sol", repo: "Web" }),
        expect.objectContaining({ text: "Which API version?", repo: "Server" }),
      ]),
    );
    expect((yield* board.access(leadId, {})).notice).toBe(EMPTY_BOARD_READ);
    const summary = yield* board.subscribe({ threadId: leadId, delta: true }).pipe(Stream.runHead);
    if (summary._tag !== "Some") throw new Error("No summary");
    expect(summary.value).toMatchObject({
      active: true,
      postCount: 5,
      overlapCount: 2,
      presence: [],
    });
    expect(summary.value.repos?.map(({ name }) => name)).toEqual(["Web", "Server"]);
    const server = summary.value.repos![1]!;
    const unavailable = yield* Effect.flip(
      board.access(leadId, { post: { kind: "finding", text: "Use v2" } }),
    );
    expect(unavailable.message).toBe("Choose a repository: Web, Server.");
    expect((yield* Effect.flip(board.postUser({ threadId: leadId, text: "Use v2" }))).message).toBe(
      unavailable.message,
    );
    yield* board.access(leadId, { repo: "Server", post: { kind: "finding", text: "Use v2" } });
    yield* board.postUser({ threadId: leadId, repo: server.id, text: "Keep the v1 fallback" });
    const details = yield* board
      .subscribe({ threadId: leadId, details: true, pushId: server.id })
      .pipe(Stream.runHead);
    expect(details._tag === "Some" && details.value.posts?.map(({ text }) => text)).toContain(
      "Keep the v1 fallback",
    );
    expect(details._tag === "Some" && details.value.posts?.map(({ text }) => text)).toContain(
      "Use v2",
    );
    const first = yield* history(board);
    expect(first._tag === "Some" && first.value.posts?.map(({ text }) => text)).not.toContain(
      "Use v2",
    );
    const presence = yield* board
      .subscribe({ threadId: leadId, presenceOnly: true })
      .pipe(Stream.runHead);
    expect(presence._tag === "Some" && presence.value.presence.map(({ taskId }) => taskId)).toEqual(
      [sol.taskId, lux.taskId],
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("pages older archive summaries without loading them at startup", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = path.join(config.stateDir, "boards");
    const file = path.join(directory, `${leadId}.jsonl`);
    yield* Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      for (let p = 0; p < 12; p++) {
        const a = member(`Alpha${p}`),
          b = member(`Beta${p}`);
        yield* board.updateTeam({ ...team, members: [a, b] });
        yield* claim(board, a, "archive.ts");
        yield* board.endRun(a);
        yield* board.endRun(b);
        yield* TestClock.adjust("1 minute");
      }
    }).pipe(Effect.provide(TeamBoard.layer));
    // Lazy journal loading leaves this simulated torn tail alone until the
    // archive is requested. Eager replay would repair it during construction.
    yield* fs.writeFileString(file, "torn-jsonl-tail", { flag: "a" });
    yield* Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      expect((yield* fs.readFileString(file)).endsWith("torn-jsonl-tail")).toBe(true);
      expect((yield* board.recoverRepos(leadId)).size).toBe(0);
      expect((yield* fs.readFileString(file)).endsWith("torn-jsonl-tail")).toBe(true);
      const first = yield* board.subscribe({ threadId: leadId }).pipe(Stream.runHead);
      if (first._tag !== "Some" || first.value.history === undefined)
        throw new Error("History is missing");
      expect(first.value.history).toHaveLength(10);
      expect(first.value.historyHasMore).toBe(true);
      expect(first.value.history[0]).toMatchObject({
        members: ["Alpha11", "Beta11"],
        postCount: 1,
        overlapCount: 0,
      });
      const older = yield* board
        .subscribe({ threadId: leadId, historyBefore: first.value.history[9]!.id })
        .pipe(Stream.runHead);
      expect(
        older._tag === "Some" && older.value.history?.map(({ members }) => members[0]),
      ).toEqual(["Alpha1", "Alpha0"]);
      expect(older._tag === "Some" && older.value.historyHasMore).toBeUndefined();
      expect((yield* fs.readFileString(file)).endsWith("torn-jsonl-tail")).toBe(false);
    }).pipe(Effect.provide(TeamBoard.layer));
  }).pipe(Effect.provide(fixture)),
);

it("caps archives by age, count and bytes, dropping oldest first", () => {
  const base = { repo: team.repo, members: {}, files: [], overlapCount: 0 };
  const now = RETENTION_MS * 2;
  const pushes = Array.from({ length: 60 }, (_, i) => ({
    ...base,
    id: `push-${i}`,
    startedAt: now - 120 + i,
    endedAt: now - 119 + i,
    posts: [],
  }));
  const latest = pruneLedger({ ...emptyLedger, history: pushes }, now).history!;
  expect(latest.map(({ id }) => id)).toEqual(pushes.slice(-50).map(({ id }) => id));
  const large = pushes.map((push) => ({
    ...push,
    posts: Array.from({ length: 300 }, (_, i) => ({
      repo: team.repo,
      post: {
        id: `post-${i}`,
        author: { name: "Example" },
        kind: "finding",
        text: "x".repeat(280),
        at: DateTime.makeUnsafe(push.endedAt),
      },
    })),
  }));
  const bounded = pruneLedger({ ...emptyLedger, history: large }, now).history!;
  expect(bounded.length).toBeLessThan(50);
  expect(jsonBytes(bounded)).toBeLessThanOrEqual(2_000_000);
  expect(bounded.map(({ id }) => id)).toEqual(large.slice(-bounded.length).map(({ id }) => id));
  expect(pruneLedger({ ...emptyLedger, history: large }, now + RETENTION_MS).history).toEqual([]);
});

it.effect("keeps every handoff commit in a two-minute batch", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    yield* claim(board, sol, "a.ts", "b.ts", "c.ts");
    for (const [who, file, commit] of [
      [neon, "a.ts", "aaaaaaa"],
      [opus, "b.ts", "bbbbbbb"],
      [neon, "c.ts", "ccccccc"],
    ] as const) {
      yield* board.access(who.threadId, {
        post: { kind: "done", text: `Fixed ${file}`, files: [file], commit },
      });
    }
    const immediate = board.reserveNotices(sol.threadId, sol.runId)!;
    expect(immediate.text).toContain("aaaaaaa");
    yield* immediate.finish(true);
    expect(board.reserveNotices(sol.threadId, sol.runId)).toBeUndefined();
    yield* TestClock.adjust("2 minutes");
    yield* board.tick;
    const batched = board.reserveNotices(sol.threadId, sol.runId)!;
    expect(batched.text).toContain("bbbbbbb");
    expect(batched.text).toContain("ccccccc");
  }).pipe(Effect.provide(layer)),
);

it.effect("batches actual implicit overlaps and caps notices at two per agent for the push", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    const paths = ["first.ts", "second.ts", "third.ts"];
    const edit: EditState = {
      head: "unchanged",
      changedAt: yield* Clock.currentTimeMillis,
      signature: "different",
      committed: new Set(),
      files: paths.map((path) => ({ path, ranges: [{ start: 5, end: 5 }] })),
    };
    yield* board.updateEdits({
      team,
      edits: new Map([
        [sol.threadId, edit],
        [neon.threadId, edit],
      ]),
      pairs: [
        ...paths.map((path) => ({ a: sol.taskId, b: neon.taskId, path, severity: 1 })),
        { a: sol.taskId, b: neon.taskId, path: "near.ts", severity: 0 },
      ],
    });
    const first = board.reserveNotices(sol.threadId)!;
    expect(first.text).toContain("first.ts");
    yield* first.finish(true);
    expect(board.reserveNotices(sol.threadId)).toBeUndefined();
    yield* TestClock.adjust("2 minutes");
    yield* board.tick;
    const second = board.reserveNotices(sol.threadId)!;
    expect(second.text).toContain("second.ts");
    expect(second.text).not.toContain("third.ts");
    yield* second.finish(true);
    expect(board.reserveNotices(sol.threadId)).toBeUndefined();
    const state = yield* history(board);
    expect(state._tag === "Some" && state.value.files?.map(({ path }) => path)).toContain(
      "third.ts",
    );
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "tells the active lead about the push once while keeping the catalog after completion",
  () =>
    Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      const leadRun = RunId.make("lead-run");
      expect(board.toolListed(leadId)).toBe(false);
      expect(board.needsLeadGuidance(leadId)).toBe(false);
      yield* board.updateTeam(team);
      expect(board.toolListed(leadId)).toBe(true);
      yield* board.queueLeadGuidance(leadId, leadRun);
      const notice = board.reserveNotices(leadId, leadRun)!;
      expect(notice.text).toContain("The team board is open.");
      yield* notice.finish(true);
      yield* board.queueLeadGuidance(leadId, leadRun);
      expect(board.reserveNotices(leadId, leadRun)).toBeUndefined();
      yield* board.endRun(sol);
      yield* board.endRun(neon);
      yield* board.endRun(opus);
      expect(board.toolListed(leadId)).toBe(true);
      expect(board.available(leadId)).toBe(false);
      expect(board.reserveNotices(leadId, leadRun)).toBeUndefined();
    }).pipe(Effect.provide(layer)),
);

it.effect("checkpoints changed open-push stats on restart and leaves identical stats alone", () =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stats = path.join(config.stateDir, "boards", "stats.jsonl");
    yield* Effect.gen(function* () {
      const board = yield* TeamBoard.TeamBoard;
      yield* board.updateTeam(team);
      yield* claim(board, sol, "stats.ts");
    }).pipe(Effect.provide(TeamBoard.layer));
    yield* TestClock.adjust("1 minute");
    yield* Effect.asVoid(TeamBoard.TeamBoard).pipe(Effect.provide(TeamBoard.layer));
    const before = yield* fs.readFileString(stats);
    expect(before).toContain('"claims":1');
    yield* TestClock.adjust("1 minute");
    yield* Effect.asVoid(TeamBoard.TeamBoard).pipe(Effect.provide(TeamBoard.layer));
    expect(yield* fs.readFileString(stats)).toBe(before);
  }).pipe(Effect.provide(fixture)),
);

it.effect("returns the matching completed handoff when a later claim can reuse it", () =>
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    yield* board.updateTeam(team);
    yield* claim(board, sol, "src/schema.ts#quantity");
    yield* claim(board, opus, "test/schema.test.ts");
    yield* board.postUser({
      threadId: leadId,
      decision: true,
      text: `Keep the interface. ${"a".repeat(240)}`,
    });
    yield* board.access(sol.threadId, {
      post: {
        kind: "done",
        text: `Fixed quantity. ${"a".repeat(240)}`,
        files: ["src/schema.ts", `src/${"x".repeat(158)}.ts`, `src/${"y".repeat(150)}.ts`],
        commit: "fe12345",
      },
    });
    yield* board.endRun(sol);
    const unrelated = yield* claim(board, opus, "unrelated.ts");
    expect(unrelated.handoffs).toBeUndefined();
    const receipt = yield* claim(board, neon, "src/schema.ts#quantity", "test/schema.test.ts");
    expect(receipt.claimed).toEqual(["src/schema.ts#quantity"]);
    expect(receipt.conflicts?.map(({ owner }) => owner)).toEqual(["Opus"]);
    expect(receipt.handoffs).toEqual([
      { by: "Sol", commit: "fe12345", files: ["src/schema.ts#quantity"] },
    ]);
    expect(jsonBytes(receipt)).toBeLessThanOrEqual(1_200);
    expect(receipt.posts.some(({ commit }) => commit === "fe12345")).toBe(false);
    expect(receipt.more).toBeGreaterThan(0);
    // The compact summary does not consume the full post. It remains available
    // when the recipient explicitly reads missing details.
    let found = false;
    for (let attempt = 0; attempt < 8; attempt++) {
      const read = yield* board.access(neon.threadId, {});
      if (read.posts.some(({ commit }) => commit === "fe12345")) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  }).pipe(Effect.provide(layer)),
);
