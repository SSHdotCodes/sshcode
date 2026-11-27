import {
  CommandId,
  isAgentToolEnabled,
  MessageId,
  isOrchestrationV2WorkActive,
  type OrchestrationV2AppThread,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { SubagentsEnabled } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as Clock from "effect/Clock";
import { currentAgentToolPolicyState } from "../mcp/AgentToolPolicy.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { DispatchModeLimit } from "../orchestration-v2/DispatchModeLimit.ts";
import * as TeamBoard from "./TeamBoard.ts";
import * as TeamBoardGit from "./TeamBoardGit.ts";
import {
  overlapEdits,
  PRESENCE_MS,
  TEAM_BOARD_TOOL,
  type BoardMember,
  type BoardPair,
  type BoardTeam,
  type EditState,
} from "./model.ts";

const isLocal = (
  task: OrchestrationV2Subagent,
): task is OrchestrationV2Subagent & { childThreadId: ThreadId } =>
  task.origin === "app_owned" && task.remote === undefined && task.childThreadId !== null;
const isLive = (task: OrchestrationV2Subagent) => isOrchestrationV2WorkActive(task.status);
const cleanName = (name?: string | null) =>
  name
    ?.replace(/[\s\p{Cc}]+/gu, " ")
    .trim()
    .slice(0, 48);
const memberName = (task: OrchestrationV2Subagent) =>
  cleanName(task.title) || cleanName(task.model) || "Subagent";
const handled = <A, E>(action: string, effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.catchCause(() => Effect.logWarning("Team board operation failed", { action })),
  );

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const board = yield* TeamBoard.TeamBoard;
    const git = yield* TeamBoardGit.TeamBoardGit;
    const events = yield* EventSink.EventSinkV2;
    const projection = yield* ProjectionStore.ProjectionStoreV2;
    const projects = yield* ProjectStore.ProjectStoreV2;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const enabled = yield* SubagentsEnabled;
    const rosterLane = yield* Semaphore.make(1);
    const scanLane = yield* Semaphore.make(1);
    const ready = new Map<ThreadId, Set<ThreadId>>();
    const leads = new Map<ThreadId, Map<ThreadId, OrchestrationV2Subagent>>();
    const knownRepos = new Map<ThreadId, Set<string>>();
    const checkouts = new Map<string, { readonly id: string; readonly name: string }>();
    const projectRoots = new Map<string, string>();
    const watched = new Map<ThreadId, BoardMember>();
    const inspectCache = new Map<ThreadId, EditState>();
    const mergeCache = new Map<string, ReadonlySet<string>>();
    const chatBaseline = new Map<
      ThreadId,
      { runId: RunId; base: string; ignored?: ReadonlySet<string> }
    >();
    const lastRefresh = new Map<ThreadId, number>();
    const trailingRefresh = new Map<ThreadId, number>();
    const crossChatSeen = new Set<string>();

    const locate = Effect.fnUntraced(function* (
      thread: OrchestrationV2AppThread | OrchestrationV2ThreadShell,
    ) {
      let workspace = thread.worktreePath ?? projectRoots.get(thread.projectId);
      if (workspace === undefined) {
        workspace = Option.getOrUndefined(yield* projects.get(thread.projectId))?.workspaceRoot;
        if (workspace !== undefined) {
          if (projectRoots.size >= 128) projectRoots.clear();
          projectRoots.set(thread.projectId, workspace);
        }
      }
      if (workspace === undefined) return undefined;
      const repo = checkouts.get(workspace) ?? (yield* git.repository(workspace));
      if (repo === undefined) return undefined;
      if (checkouts.size >= 256) checkouts.clear();
      checkouts.set(workspace, repo);
      return { repo: repo.id, repoName: repo.name, cwd: workspace };
    });
    const readMember = Effect.fnUntraced(function* (
      task: OrchestrationV2Subagent & { childThreadId: ThreadId },
    ) {
      const child = yield* projection.getThreadRecords(task.childThreadId, ["runs"], {
        activeRunsOnly: true,
      });
      // Worktree creation is part of preparation. Wait for its actual path before comparing it.
      const active = child.runs.findLast(
        (run) => run.status === "starting" || run.status === "running" || run.status === "waiting",
      );
      if (active === undefined) return undefined;
      const checkout = yield* locate(child.thread);
      if (checkout === undefined) return undefined;
      const existing = watched.get(task.childThreadId);
      const baseRef =
        active?.workspacePreparation?.type === "worktree"
          ? active.workspacePreparation.baseRef
          : undefined;
      const configuredBase =
        baseRef !== undefined && /^[a-f0-9]{40,64}$/u.test(baseRef) ? baseRef : undefined;
      const base =
        configuredBase ??
        existing?.base ??
        (child.thread.worktreePath === null
          ? undefined
          : ((yield* git.worktreeBase(checkout.cwd)) ?? (yield* git.head(checkout.cwd))));
      const resumedFrom: RunId[] = [];
      let source = active.restartContinuationOfRunId;
      for (let transit = 0; source !== undefined && transit < 32; transit++) {
        resumedFrom.push(source);
        const prior = yield* projection.getThreadRecords(task.childThreadId, ["runs"], {
          runIds: [source],
        });
        source = prior.runs[0]?.restartContinuationOfRunId;
      }
      const member: BoardMember = {
        threadId: task.childThreadId,
        taskId: task.id,
        name: memberName(task),
        cwd: checkout.cwd,
        worktree: child.thread.worktreePath !== null,
        runId: active.id,
        ...(resumedFrom.length === 0 ? {} : { resumedFrom }),
        ...(base === undefined ? {} : { base }),
      };
      return { repo: checkout.repo, repoName: checkout.repoName, member };
    });
    const syncLead = Effect.fnUntraced(function* (leadId: ThreadId) {
      const tasks = leads.get(leadId);
      const affected = knownRepos.get(leadId) ?? new Set<string>();
      const groups = new Map<string, { name: string; members: BoardMember[] }>();
      const pendingMembers = new Map(
        enabled(leadId)
          ? [...(tasks?.values() ?? [])].map((task) => [task.id, memberName(task)])
          : [],
      );
      if (enabled(leadId) && tasks !== undefined && (tasks.size >= 2 || affected.size > 0)) {
        const resolved = yield* Effect.forEach(
          [...tasks.values()].filter(isLocal),
          (task) => readMember(task).pipe(Effect.option),
          { concurrency: 4 },
        );
        for (const entry of resolved) {
          const found = Option.getOrUndefined(entry);
          if (found === undefined) continue;
          const group = groups.get(found.repo) ?? { name: found.repoName, members: [] };
          group.members.push(found.member);
          groups.set(found.repo, group);
          pendingMembers.delete(found.member.taskId);
        }
      }
      const before = new Set([...watched.keys()].filter((id) => board.memberAvailable(id)));
      for (const repo of new Set([...affected, ...groups.keys()])) {
        const group = groups.get(repo);
        const members = group?.members ?? [];
        if (members.length < 2 && !affected.has(repo)) continue;
        for (const member of members) watched.set(member.threadId, member);
        yield* board.updateTeam({
          leadId,
          repo,
          members,
          pendingMembers,
          ...(group === undefined ? {} : { repoName: group.name }),
        });
        if (!board.tracksRepo(leadId, repo)) affected.delete(repo);
        else affected.add(repo);
      }
      for (const id of watched.keys()) {
        if (tasks?.has(id) || !before.has(id)) continue;
        // Only discard members this lead used to track and which it has now released.
        if (board.memberAvailable(id)) continue;
        watched.delete(id);
      }
      if (affected.size === 0) knownRepos.delete(leadId);
      else knownRepos.set(leadId, affected);
    });

    // The task is published before Git prepares its worktree. Recheck when its
    // provider can open so the eager MCP list sees the actual sibling cohort.
    board.registerChildPreparation((leadId, threadId) =>
      rosterLane
        .withPermits(1)(
          handled(
            "prepared roster",
            Effect.gen(function* () {
              const peers = ready.get(leadId) ?? new Set<ThreadId>();
              peers.add(threadId);
              ready.set(leadId, peers);
              const current = leads.get(leadId);
              if (peers.size < 2 && (current?.size ?? 0) < 2) return;
              if (current === undefined || !current.has(threadId) || current.size < 2) {
                const parent = yield* projection.getThreadRecords(leadId, ["subagents"]);
                leads.set(
                  leadId,
                  new Map(
                    parent.subagents
                      .filter(isLocal)
                      .filter(isLive)
                      .map((task) => [task.childThreadId, task]),
                  ),
                );
              }
              yield* syncLead(leadId);
            }),
          ),
        )
        .pipe(Effect.asVoid),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => board.registerChildPreparation(() => Effect.void)),
    );

    const overlap = Effect.fnUntraced(function* (
      team: TeamBoard.BoardTeamObservation,
      edits: ReadonlyMap<ThreadId, EditState>,
    ) {
      const pairs: BoardPair[] = [];
      const members = [
        ...new Map(team.participants.map((member) => [member.threadId, member])).values(),
      ].sort((a, b) => a.taskId.localeCompare(b.taskId));
      const now = yield* Clock.currentTimeMillis;
      for (const [i, left] of members.entries()) {
        const le = edits.get(left.threadId);
        for (const right of members.slice(i + 1)) {
          const re = edits.get(right.threadId);
          if (le === undefined || re === undefined) continue;
          const matching = (le?.files ?? []).filter((file) =>
            re?.files.some((other) => other.path === file.path),
          );
          const committed = matching.some(
            (file) => le.committed.has(file.path) && re.committed.has(file.path),
          );
          let confirmed: ReadonlySet<string> | undefined;
          const fresh = !le.stale && !re.stale;
          if (committed && fresh) {
            const key = `${team.repo}:${le.head}:${re.head}`;
            confirmed =
              mergeCache.get(key) ??
              (yield* git.conflicts(left.cwd, le.head, re.head)) ??
              (left.cwd === right.cwd
                ? undefined
                : yield* git.conflicts(right.cwd, le.head, re.head));
            if (confirmed !== undefined) {
              if (mergeCache.size >= 256) mergeCache.clear();
              mergeCache.set(key, confirmed);
            }
          }
          for (const file of matching) {
            const { path } = file;
            const r = re.files.find((other) => other.path === path)!;
            const bothCommitted = le.committed.has(path) && re.committed.has(path);
            const result = bothCommitted ? confirmed?.has(path) : undefined;
            const actual =
              !bothCommitted &&
              fresh &&
              le.changedAt > now - PRESENCE_MS &&
              re.changedAt > now - PRESENCE_MS &&
              overlapEdits(file, r);
            pairs.push({
              a: left.taskId,
              b: right.taskId,
              path,
              severity: result === true ? 2 : actual ? 1 : 0,
              ...(result === undefined ? {} : { confirmed: result }),
            });
          }
        }
      }
      return pairs.slice(0, 256);
    });
    const inspect = Effect.fnUntraced(function* (
      threadId: ThreadId,
      cwd: string,
      base: string,
      force: boolean,
      ignored?: ReadonlySet<string>,
      deferred = false,
    ) {
      const now = yield* Clock.currentTimeMillis;
      const previous = inspectCache.get(threadId);
      const due = (lastRefresh.get(threadId) ?? -Infinity) + 10_000;
      if (!force && now < due) {
        if (deferred) trailingRefresh.set(threadId, due);
        return previous;
      }
      trailingRefresh.delete(threadId);
      lastRefresh.set(threadId, now);
      const next = yield* git.inspect(cwd, base, previous, ignored);
      if (next === undefined) inspectCache.delete(threadId);
      else inspectCache.set(threadId, next);
      return next;
    });
    const inspectTeam = Effect.fnUntraced(function* (
      team: TeamBoard.BoardTeamObservation,
      changed?: ThreadId,
      force = false,
    ) {
      const members =
        changed === undefined
          ? team.members
          : team.members.filter((member) => member.threadId === changed);
      if (members.length === 0) return;
      const byWorktree = Map.groupBy(members, ({ cwd }) => cwd);
      yield* Effect.forEach(
        byWorktree.values(),
        (sameWorktree) =>
          Effect.gen(function* () {
            for (const member of sameWorktree) {
              if (member.worktree && member.base !== undefined) {
                const restored = team.previousEdits.get(member.threadId);
                if (restored !== undefined && !inspectCache.has(member.threadId))
                  inspectCache.set(member.threadId, restored);
                yield* inspect(
                  member.threadId,
                  member.cwd,
                  member.base,
                  force,
                  undefined,
                  changed !== undefined,
                );
              }
            }
          }),
        { concurrency: 2, discard: true },
      );
      const current = new Map(team.previousEdits);
      for (const { threadId } of team.members) {
        const edit = inspectCache.get(threadId);
        if (edit !== undefined) current.set(threadId, edit);
        else if (members.some((member) => member.threadId === threadId)) current.delete(threadId);
      }
      const pairs = yield* overlap(team, current);
      yield* board.updateEdits({ team, edits: current, pairs });
    });
    const refreshTeam = (team: TeamBoard.BoardTeamObservation, changed?: ThreadId, force = false) =>
      scanLane.withPermits(1)(inspectTeam(team, changed, force));
    board.registerFinalScan((target) =>
      handled(
        "final inspection",
        Effect.gen(function* () {
          const team = board.observeTeam(target.threadId);
          if (team !== undefined) yield* refreshTeam(team, target.threadId, true);
        }),
      ).pipe(Effect.asVoid),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => board.registerFinalScan(() => Effect.void)));
    const crossChat = Effect.fnUntraced(function* (teams: ReadonlyArray<BoardTeam>) {
      const snapshot = yield* projection.getShellSnapshot({ location: "active" });
      const live = snapshot.threads.filter((thread) => thread.activeRunId !== null);
      const activeIds = new Set(live.map((thread) => thread.id));
      for (const id of chatBaseline.keys()) if (!activeIds.has(id)) chatBaseline.delete(id);
      const known = new Map(
        teams.flatMap((team) =>
          team.members.map(
            (member) => [member.threadId, { leadId: team.leadId, repo: team.repo }] as const,
          ),
        ),
      );
      for (const thread of live) {
        const runId = thread.activeRunId!;
        const checkout = yield* locate(thread);
        if (checkout === undefined || !teams.some((team) => team.repo === checkout.repo)) continue;
        const tracked = known.get(thread.id);
        let edit = inspectCache.get(thread.id);
        if (tracked === undefined) {
          let baseline = chatBaseline.get(thread.id);
          if (baseline?.runId !== runId) {
            const base =
              (thread.worktreePath === null ? undefined : yield* git.worktreeBase(checkout.cwd)) ??
              (yield* git.head(checkout.cwd));
            if (base === undefined) continue;
            const ignored =
              thread.worktreePath === null ? yield* git.dirty(checkout.cwd) : undefined;
            if (thread.worktreePath === null && ignored === undefined) continue;
            baseline = { runId, base, ...(ignored === undefined ? {} : { ignored }) };
            chatBaseline.set(thread.id, baseline);
            inspectCache.delete(thread.id);
            lastRefresh.delete(thread.id);
          }
          edit = yield* inspect(thread.id, checkout.cwd, baseline.base, false, baseline.ignored);
        }
        if (edit === undefined || edit.stale) continue;
        for (const team of teams) {
          if (
            team.repo !== checkout.repo ||
            team.leadId === tracked?.leadId ||
            team.leadId === thread.id
          )
            continue;
          for (const member of team.members) {
            if (member.runId === undefined || member.threadId === thread.id) continue;
            const other = inspectCache.get(member.threadId);
            const now = yield* Clock.currentTimeMillis;
            if (
              other === undefined ||
              other.stale ||
              edit.changedAt <= now - PRESENCE_MS ||
              other.changedAt <= now - PRESENCE_MS
            )
              continue;
            for (const file of edit.files) {
              const siblingFile = other.files.find((candidate) => candidate.path === file.path);
              if (siblingFile === undefined) continue;
              const key = [...[runId, member.runId].sort(), file.path].join("\0");
              if (crossChatSeen.has(key)) continue;
              const bothCommitted = edit.committed.has(file.path) && other.committed.has(file.path);
              if (bothCommitted) {
                const heads = `${team.repo}:${edit.head}:${other.head}`;
                const conflicts =
                  mergeCache.get(heads) ??
                  (yield* git.conflicts(checkout.cwd, edit.head, other.head));
                if (conflicts !== undefined) {
                  if (mergeCache.size >= 256) mergeCache.clear();
                  mergeCache.set(heads, conflicts);
                }
                if (!conflicts?.has(file.path)) continue;
              } else if (!overlapEdits(siblingFile, file)) continue;
              if (crossChatSeen.size >= 2_048) crossChatSeen.clear();
              crossChatSeen.add(key);
              const notice = `Another chat in this repo is also changing ${file.path}.`;
              yield* board.queueNotice({ threadId: member.threadId, runId: member.runId }, notice);
              if (tracked !== undefined)
                yield* board.queueNotice({ threadId: thread.id, runId }, notice);
            }
          }
        }
      }
      for (const id of inspectCache.keys())
        if (!activeIds.has(id) && !watched.has(id)) inspectCache.delete(id);
      for (const id of lastRefresh.keys())
        if (!activeIds.has(id) && !watched.has(id)) lastRefresh.delete(id);
    });

    const nowSequence = yield* events.latestSequence().pipe(Effect.orElseSucceed(() => 0));
    // Subscribe before the startup roster read so a fresh launch cannot disappear between the two.
    const taskEvents = events.stream({ afterSequence: nowSequence, eventType: "subagent.updated" });
    yield* taskEvents.pipe(
      Stream.runForEach(({ event }) =>
        rosterLane.withPermits(1)(
          handled(
            "roster",
            Effect.gen(function* () {
              if (event.type !== "subagent.updated" || !isLocal(event.payload)) return;
              const task = event.payload;
              const active = isLive(task);
              const leadId = event.threadId;
              const current = leads.get(leadId) ?? new Map();
              const previous = current.get(task.childThreadId);
              if (active) current.set(task.childThreadId, task);
              else {
                const peers = ready.get(leadId);
                peers?.delete(task.childThreadId);
                if (peers?.size === 0) ready.delete(leadId);
                if (previous === undefined) return;
                const member = watched.get(task.childThreadId);
                if (member !== undefined) {
                  const observed = board.observeTeam(task.childThreadId);
                  if (observed !== undefined) yield* refreshTeam(observed, task.childThreadId);
                  watched.delete(task.childThreadId);
                }
                current.delete(task.childThreadId);
              }
              if (current.size === 0) leads.delete(leadId);
              else leads.set(leadId, current);
              if (current.size >= 2 || knownRepos.has(leadId)) yield* syncLead(leadId);
            }),
          ),
        ),
      ),
      Effect.ignore,
      Effect.forkScoped({ startImmediately: true }),
    );
    yield* Stream.merge(
      board.editRefreshes,
      Stream.tick("60 seconds").pipe(Stream.as(undefined)),
    ).pipe(
      Stream.runForEach((id) =>
        handled(
          "inspect",
          Effect.gen(function* () {
            const teams = board.activeTeams();
            if (teams.length === 0) return;
            for (const team of teams) yield* refreshTeam(team, id);
            if (id === undefined) yield* scanLane.withPermits(1)(crossChat(teams));
          }),
        ),
      ),
      Effect.forkScoped,
    );
    yield* Stream.tick("5 seconds").pipe(
      Stream.runForEach(() =>
        handled(
          "maintenance",
          Effect.gen(function* () {
            yield* board.tick;
            if (trailingRefresh.size === 0) return;
            const now = yield* Clock.currentTimeMillis;
            for (const [id, due] of trailingRefresh) {
              if (now < due) continue;
              trailingRefresh.delete(id);
              if (board.memberAvailable(id)) yield* board.refreshAfterTool(id);
            }
          }),
        ),
      ),
      Effect.forkScoped,
    );

    const pendingNotices = new Map<string, { notice: TeamBoard.TeamBoardNotice; until: number }>();
    const guide = Effect.fnUntraced(function* (id: ThreadId) {
      const member = watched.get(id);
      const child = member?.runId !== undefined && board.needsGuidance(id, member.runId);
      const lead = board.needsLeadGuidance(id);
      if (!child && !lead) return;
      const shell = yield* projection.getThreadShell(id);
      const runId = shell?.activeRunId;
      if (shell === null || runId === undefined || runId === null) return;
      const { available, policy } = yield* currentAgentToolPolicyState;
      if (!available || !isAgentToolEnabled(policy, TEAM_BOARD_TOOL, shell.providerInstanceId))
        return;
      if (child && member?.runId === runId) yield* board.queueGuidance(id, runId);
      if (lead) yield* board.queueLeadGuidance(id, runId);
    });
    const deliver = Effect.fnUntraced(function* (notice: TeamBoard.TeamBoardNotice, until: number) {
      if (!board.noticeIsLive(notice)) return;
      const shell = yield* projection.getThreadShell(notice.threadId);
      if (shell === null || shell.activeRunId !== notice.runId) return;
      if (notice.guidance || notice.leadGuidance) {
        const { available, policy } = yield* currentAgentToolPolicyState;
        if (!available || !isAgentToolEnabled(policy, TEAM_BOARD_TOOL, shell.providerInstanceId))
          return;
      }
      if (shell.activityRunStatus === "starting" || shell.activityRunStatus === "waiting") {
        if ((yield* Clock.currentTimeMillis) < until && pendingNotices.size < 512)
          pendingNotices.set(notice.id, { notice, until });
        return;
      }
      const source =
        notice.from === undefined ? undefined : yield* projection.getThreadShell(notice.from);
      if (source === null) return;
      yield* threads
        .sendToThread({
          projectId: shell.projectId,
          threadId: notice.threadId,
          expectedRunId: notice.runId,
          commandId: CommandId.make(`team-board:${notice.id}`),
          messageId: MessageId.make(`team-board:${notice.id}`),
          text: notice.text,
          attachments: [],
          mode: "steer",
          steerExistingOnly: true,
          createdBy: "system",
          creationSource: "mcp",
        })
        .pipe(
          Effect.provideService(
            DispatchModeLimit,
            source === undefined
              ? undefined
              : { runtimeMode: source.runtimeMode, interactionMode: source.interactionMode },
          ),
          Effect.option,
        );
    });
    yield* board.notices.pipe(
      Stream.mapEffect(
        (notice) =>
          handled(
            "steer",
            Effect.flatMap(Clock.currentTimeMillis, (now) => deliver(notice, now + 60_000)),
          ),
        { concurrency: 4 },
      ),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* Stream.tick("5 seconds").pipe(
      Stream.runForEach(() =>
        Effect.gen(function* () {
          yield* Effect.forEach(
            [...pendingNotices.values()],
            ({ notice, until }) => {
              pendingNotices.delete(notice.id);
              return handled("pending steer", deliver(notice, until));
            },
            { concurrency: 4, discard: true },
          );
        }),
      ),
      Effect.forkScoped,
    );
    yield* board.availabilityChanges.pipe(
      Stream.runForEach((ids) =>
        Effect.forEach(ids, (id) => handled("guidance", guide(id)), {
          concurrency: 4,
          discard: true,
        }),
      ),
      Effect.forkScoped,
    );

    yield* rosterLane.withPermits(1)(
      handled(
        "restore",
        Effect.gen(function* () {
          const snapshot = yield* projection.getShellSnapshot({ location: "active" });
          const grouped = new Map<ThreadId, number>();
          for (const thread of snapshot.threads) {
            const parent =
              thread.lineage.relationshipToParent === "subagent" &&
              thread.lineage.parentEnvironmentId === undefined
                ? thread.lineage.parentThreadId
                : null;
            if (parent === null || thread.activeRunId === null) continue;
            board.registerSubagent(thread.id);
            grouped.set(parent, (grouped.get(parent) ?? 0) + 1);
          }
          const indexed = [...board.restorableRepos].flatMap(([id, repos]) =>
            repos.size > 0 ? [id] : [],
          );
          for (const leadId of new Set([...grouped.keys(), ...indexed])) {
            const repos = yield* board.recoverRepos(leadId);
            if ((grouped.get(leadId) ?? 0) < 2 && repos.size === 0) continue;
            if (repos.size > 0) knownRepos.set(leadId, new Set(repos));
            const records = yield* projection
              .getThreadRecords(leadId, ["subagents"])
              .pipe(Effect.option);
            const tasks = (Option.getOrUndefined(records)?.subagents ?? [])
              .filter(isLocal)
              .filter(isLive);
            for (const task of tasks) {
              const current = leads.get(leadId) ?? new Map();
              if (!current.has(task.childThreadId)) current.set(task.childThreadId, task);
              leads.set(leadId, current);
            }
            yield* syncLead(leadId);
          }
        }),
      ),
    );
  }),
).pipe(Layer.provide(TeamBoardGit.layer));
