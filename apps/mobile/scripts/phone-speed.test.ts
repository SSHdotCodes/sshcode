// Opt-in Node benchmark. From apps/mobile, set PHONE_SPEED to shell, 3000, 20000 or 60000
// and run pnpm exec vp test run scripts/phone-speed.test.ts. The SQLite sample deletes its temporary database.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as DateTime from "effect/DateTime";
import {
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  RunId,
  RunAttemptId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  OrchestrationV2ThreadBoundedSnapshot,
  OrchestrationV2ThreadDetailSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { EnvironmentRegistry, PrimaryConnectionTarget } from "@t3tools/client-runtime/connection";
import {
  makeStoredShellSnapshotEncoder,
  orchestrationShellCacheSchemaVersion,
} from "@t3tools/client-runtime/platform";
import {
  applyShellStreamEvent,
  EMPTY_SHELL_STATE,
  type EnvironmentShellState,
  decodeShellSnapshotDeferringPullRequests,
} from "@t3tools/client-runtime/state/shell";
import {
  createThreadFamilyAtoms,
  createEnvironmentThreadShellAtoms,
} from "@t3tools/client-runtime/state/threads";
import { applyOrchestrationV2ProjectionEvent } from "@t3tools/client-runtime/state/orchestration-v2-projection";
import { createQuestionHistoryProjector } from "@t3tools/client-runtime/state/thread-requests";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";

import {
  v2ShellSnapshot,
  v2ThreadShell,
  v2Projection,
  v2Now,
} from "../../../packages/client-runtime/src/state/orchestrationV2TestFixtures";
import { buildBoundedThreadStreamSnapshot } from "../../server/src/orchestration-v2/ThreadStream";
import {
  decodeStoredShellSnapshot,
  decodeStoredShellPreview,
  encodeStoredShellPreview,
  firstScreenShellSnapshot,
} from "../src/connection/shell-cache-decoding";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  threadListV2ListItemsAreEqual,
} from "../src/features/threads/threadListV2";
import {
  isWorkflowThread,
  workflowListHiddenKeys,
} from "../src/features/workflows/workflowVisibility";
import { homeMachineSummaries } from "../src/lib/thread-summaries";
import {
  createThreadFeedProjector,
  createThreadFeedPresentationProjector,
  threadFeedSummary,
} from "../src/lib/threadFeedProjection";

// Pending drafts have no native images in this fixture.
vi.mock("../src/lib/composerImageGallery", () => ({ composerImageGallery: () => [] }));
import { threadHasMedia } from "@t3tools/client-runtime/thread-media";
import { threadImageGallery } from "../src/features/threads/messageImageGallery";
import { createTimelineDecorationsProjector } from "../src/features/discord/timelinePresentation";

const selection = process.env.PHONE_SPEED;
const environmentId = EnvironmentId.make("phone");
const catalogValueAtom = Atom.make({
  isReady: true,
  entries: new Map([
    [
      environmentId,
      {
        enabled: true,
        profile: Option.none(),
        target: new PrimaryConnectionTarget({
          environmentId,
          label: "Synthetic",
          httpBaseUrl: "http://localhost",
          wsBaseUrl: "ws://localhost",
        }),
      },
    ],
  ]),
});
const now = "2026-11-01T10:00:00.000Z";

function startTimer(durations: Record<string, number>, key: string) {
  const cpu = process.threadCpuUsage();
  const start = performance.now();
  return () => {
    durations[key] = performance.now() - start;
    const elapsed = process.threadCpuUsage(cpu);
    durations[key + "Cpu"] = (elapsed.user + elapsed.system) / 1000;
  };
}

function timed<T>(durations: Record<string, number>, key: string, run: () => T): T {
  const stop = startTimer(durations, key);
  const result = run();
  stop();
  return result;
}

function timedEffect<A, E>(
  durations: Record<string, number>,
  key: string,
  run: () => Effect.Effect<A, E>,
) {
  return Effect.gen(function* () {
    const stop = startTimer(durations, key);
    const result = yield* run();
    stop();
    return result;
  });
}

function measure(size: number, sample: () => Record<string, number>, repetitions = 5) {
  reportSamples(size, Array.from({ length: repetitions }, sample));
}

function reportSamples(size: number, samples: Record<string, number>[]) {
  const median = Object.fromEntries(
    Object.keys(samples[0]!).map((key) => {
      const sorted = samples.map((row) => row[key]!).sort((a, b) => a - b);
      return [key, Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(3))];
    }),
  );
  process.stdout.write(JSON.stringify({ size, repetitions: samples.length, ...median }) + "\n");
}

// Isolate copying strings across the SQLite boundary from parse, validation and encoding.
function measureSqlite(size: number, raw: string, preview: string) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "phone-speed-"));
  const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "cache.sqlite"));
  try {
    db.exec("PRAGMA journal_mode=WAL");
    db.exec("CREATE TABLE cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL) WITHOUT ROWID");
    const save = db.prepare(
      "INSERT INTO cache VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload",
    );
    const load = db.prepare("SELECT payload FROM cache WHERE key = ?");
    save.run("snapshot", raw);
    save.run("first-screen", preview);
    const records = [
      [raw, preview],
      [
        raw.replace("Investigate workspace 0", "Revised workspace 0"),
        preview.replace("Investigate workspace 0", "Revised workspace 0"),
      ],
    ] as const;
    let i = 0;
    measure(size, () => {
      const times: Record<string, number> = {};
      const [full, small] = records[++i % 2]!;
      timed(times, "sqliteWrite", () => {
        save.run("snapshot", full);
        save.run("first-screen", small);
      });
      timed(times, "sqliteRead", () => load.get("snapshot"));
      timed(times, "sqlitePreviewRead", () => load.get("first-screen"));
      return times;
    });
  } finally {
    db.close();
    NodeFS.rmSync(dir, { recursive: true });
  }
}

function shellFixture(size: number): OrchestrationV2ShellSnapshot {
  return {
    ...v2ShellSnapshot,
    idleSubagentsOmitted: true,
    ...(size === 635 ? { idleAppOwnedSubagentsOmitted: true as const } : {}),
    threads: Array.from({ length: size }, (_, i) => {
      const id = ThreadId.make(`chat-${i}`);
      const parent = ThreadId.make(`chat-${i % 32}`);
      return {
        ...v2ThreadShell,
        id,
        title: `Investigate workspace ${i}`,
        lineage:
          i < 100
            ? { ...v2ThreadShell.lineage, rootThreadId: id }
            : {
                rootThreadId: parent,
                parentThreadId: parent,
                relationshipToParent: "subagent" as const,
              },
        createdBy: i < 100 ? "user" : "agent",
        creationSource: i < 100 ? "mobile" : "mcp",
        latestRunId: RunId.make(`run-${i}`),
        status: i % 23 === 0 ? "running" : "completed",
        latestRunStartedAt: v2Now,
        latestUserMessageAt: v2Now,
        lastVisitedAt: v2Now,
        latestVisibleMessage: {
          role: "assistant",
          id: MessageId.make(`m-${i}`),
          updatedAt: v2Now,
          text: "Synthetic output. ".repeat(size === 635 ? 79 : 87),
        },
        replyPreview: "A short synthetic preview.",
        latestRequest: "Check the workspace.",
        pullRequests: [],
      };
    }),
  };
}

function homeReader() {
  const registry = AtomRegistry.make();
  const source = Atom.make<AsyncResult.AsyncResult<EnvironmentShellState>>(
    AsyncResult.success(EMPTY_SHELL_STATE),
  );
  const families = createThreadFamilyAtoms(
    Atom.runtime(
      Layer.effect(EnvironmentRegistry.EnvironmentRegistry, Effect.die("Unexpected family RPC")),
    ),
    () => source,
  );
  const atoms = createEnvironmentThreadShellAtoms({
    catalogValueAtom,
    snapshotAtom: families.snapshotAtom,
  });
  const index = atoms.environmentThreadIndexAtom(environmentId);
  registry.mount(index);
  let indexChanges = 0;
  registry.subscribe(index, () => indexChanges++);
  let listBuilds = 0;
  const rows = Atom.make((get) => {
    const all = get(atoms.topLevelThreadShellsAtom);
    const navigation = all.filter(
      (t) => t.lineage.relationshipToParent !== "subagent" && !isWorkflowThread(t),
    );
    workflowListHiddenKeys(all);
    homeMachineSummaries(navigation);
    listBuilds++;
    return buildThreadListV2ListItems({
      layout: buildThreadListV2Items({ threads: navigation, searchQuery: "", now }),
      pendingTasks: [],
    });
  });
  registry.mount(rows);
  return {
    registry,
    put(snapshot: OrchestrationV2ShellSnapshot) {
      registry.set(
        source,
        AsyncResult.success({
          ...EMPTY_SHELL_STATE,
          status: "live",
          generation: 1,
          snapshot: Option.some(snapshot),
        }),
      );
      registry.get(index);
      return registry.get(rows);
    },
    builds: () => listBuilds,
    indices: () => indexChanges,
  };
}

it.effect.skipIf(selection !== "shell")(
  "measures shell bytes, cold Home selectors, single deltas and cache CPU",
  () =>
    Effect.gen(function* () {
      for (const size of [635, 2100]) {
        const shell = shellFixture(size);
        const body = Buffer.from(JSON.stringify(shell));
        const stored = {
          schemaVersion: orchestrationShellCacheSchemaVersion(shell),
          environmentId,
          snapshot: shell,
        };
        const encoder = () => makeStoredShellSnapshotEncoder({ yieldToHost: Effect.void });
        const raw = yield* encoder()(stored);
        const previewRaw = yield* encodeStoredShellPreview({
          ...stored,
          snapshot: firstScreenShellSnapshot(shell, environmentId),
        });
        measureSqlite(size, raw, previewRaw);
        const warmEncode = encoder();
        yield* warmEncode(stored);
        const samples: Record<string, number>[] = [];
        for (let i = 0; i < 5; i++) {
          const t: Record<string, number> = {
            bytes: body.length,
            cacheBytes: Buffer.byteLength(raw),
            previewBytes: Buffer.byteLength(previewRaw),
          };
          const reader = homeReader();
          const parsed = timed(t, "parse", () => JSON.parse(body.toString()));
          const snapshot = yield* timedEffect(t, "decode", () =>
            decodeShellSnapshotDeferringPullRequests(parsed),
          );
          let rows = timed(t, "storeAndList", () => reader.put(snapshot));
          t.ready = t.parse! + t.decode! + t.storeAndList!;
          t.readyCpu = t.parseCpu! + t.decodeCpu! + t.storeAndListCpu!;
          // A foreground status transition republishes the retained snapshot.
          const beforeResume = reader.builds();
          timed(t, "resumePublish", () => reader.put(snapshot));
          t.resumeBuilds = reader.builds() - beforeResume;
          let current: OrchestrationV2ShellSnapshot = snapshot;
          for (const [name, index, changeOutput] of [
            ["cursor", size - 1, false],
            ["child", size - 1, true],
            ["root", 1, true],
          ] as const) {
            const before = reader.builds();
            const previousIndex = reader.indices();
            const next = timed(t, name, () => {
              const old = current.threads[index]!;
              current = applyShellStreamEvent(current, {
                kind: "thread.updated",
                location: "active",
                sequence: current.snapshotSequence + 1,
                thread: { ...old, ...(changeOutput ? { replyPreview: "New output" } : {}) },
              });
              return reader.put(current);
            });
            t[name + "Indexes"] = reader.indices() - previousIndex;
            t[name + "Builds"] = reader.builds() - before;
            const byKey = new Map(rows.map((row) => [row.key, row]));
            t[name + "Rows"] = next.filter((r) => {
              const old = byKey.get(r.key);
              return !old || !threadListV2ListItemsAreEqual(old, r);
            }).length;
            rows = next;
          }
          yield* timedEffect(t, "cacheRead", () => decodeStoredShellSnapshot(raw));
          const preview = yield* timedEffect(t, "previewRead", () =>
            decodeStoredShellPreview(previewRaw),
          );
          const previewReader = homeReader();
          timed(t, "previewList", () => previewReader.put(preview.snapshot));
          previewReader.registry.dispose();
          timed(t, "previewSelect", () => firstScreenShellSnapshot(shell, environmentId));
          const savePreview = (value: OrchestrationV2ShellSnapshot) =>
            encodeStoredShellPreview({
              ...stored,
              snapshot: firstScreenShellSnapshot(value, environmentId),
            });
          yield* timedEffect(t, "coldWrite", () =>
            Effect.gen(function* () {
              yield* encoder()(stored);
              yield* savePreview(shell);
            }),
          );
          const changed = {
            ...shell,
            threads: [{ ...shell.threads[0]!, title: "Changed" }, ...shell.threads.slice(1)],
          };
          yield* timedEffect(t, "warmWrite", () =>
            Effect.gen(function* () {
              yield* warmEncode({ ...stored, snapshot: changed });
              yield* savePreview(changed);
            }),
          );
          reader.registry.dispose();
          samples.push(t);
        }
        reportSamples(size, samples);
      }
    }),
  30000,
);

function chatFixture(size: number): OrchestrationV2ThreadProjection {
  const threadId = v2Projection.thread.id;
  const runCount = Math.round((size * 2255) / 60000);
  const runIndex = (i: number) => Math.floor((i * runCount) / size);
  const runs = Array.from({ length: runCount }, (_, i) => ({
    id: RunId.make(`r-${i}`),
    threadId,
    ordinal: i + 1,
    providerInstanceId: v2ThreadShell.providerInstanceId,
    modelSelection: v2ThreadShell.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`prompt-${i}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: i === runCount - 1 ? ("running" as const) : ("completed" as const),
    requestedAt: v2Now,
    startedAt: v2Now,
    completedAt: i === runCount - 1 ? null : v2Now,
    checkpointId: null,
    contextHandoffId: null,
  }));
  const rootIds = runs.map((_, index) => {
    const firstItem = Math.ceil((index * size) / runCount);
    return NodeId.make(`n-${Math.floor(firstItem / 10) * 9 + (firstItem % 10)}`);
  });
  const attempts = runs.map((run, index) => ({
    id: RunAttemptId.make(`attempt-${index}`),
    runId: run.id,
    attemptOrdinal: 1,
    rootNodeId: rootIds[index]!,
    providerInstanceId: run.providerInstanceId,
    providerThreadId: ProviderThreadId.make("provider-thread"),
    providerTurnId: null,
    reason: "initial" as const,
    status: run.status,
    startedAt: v2Now,
    completedAt: run.completedAt,
  }));
  const nodes = Array.from({ length: Math.floor(size * 0.9) }, (_, i) => {
    const id = NodeId.make(`n-${i}`);
    const run = runIndex(Math.floor(i / 9) * 10 + (i % 9));
    const rootNodeId = rootIds[run]!;
    return {
      id,
      threadId,
      runId: runs[run]!.id,
      parentNodeId: id === rootNodeId ? null : rootNodeId,
      rootNodeId,
      kind: "tool_call" as const,
      status: "completed" as const,
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: v2Now,
      completedAt: v2Now,
    };
  });
  const turnItems = Array.from({ length: size }, (_, i): OrchestrationV2TurnItem => {
    const run = runs[runIndex(i)]!;
    const common = {
      id: TurnItemId.make(`i-${i}`),
      threadId,
      runId: run.id,
      ordinal: i + 1,
      nodeId: i % 10 === 9 ? null : nodes[Math.floor(i / 10) * 9 + (i % 10)]!.id,
      parentItemId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      status: "completed" as const,
      title: null,
      startedAt: v2Now,
      updatedAt: v2Now,
      completedAt: v2Now,
    };
    if (i === 0 || runIndex(i) !== runIndex(i - 1))
      return {
        ...common,
        type: "user_message",
        messageId: run.userMessageId,
        text: "Check this",
        attachments: [],
        inputIntent: "turn_start",
        createdBy: "user",
        creationSource: "mobile",
      };
    if (i === size - 1 || runIndex(i) !== runIndex(i + 1))
      return {
        ...common,
        type: "assistant_message",
        messageId: MessageId.make(`answer-${i}`),
        text: "Checked",
        attachments: [],
        streaming: i === size - 1,
        status: i === size - 1 ? "running" : "completed",
        completedAt: i === size - 1 ? null : v2Now,
      };
    return {
      ...common,
      type: "command_execution",
      input: "git status",
      output: "clean",
      exitCode: 0,
    };
  });
  const messages = turnItems.flatMap((item) =>
    item.type !== "user_message" && item.type !== "assistant_message"
      ? []
      : [
          {
            id: item.messageId,
            threadId,
            runId: item.runId,
            nodeId: item.nodeId,
            role: item.type === "user_message" ? ("user" as const) : ("assistant" as const),
            createdBy: item.type === "user_message" ? ("user" as const) : ("agent" as const),
            creationSource: "mobile" as const,
            attachments: [],
            text: item.text,
            streaming: item.type === "assistant_message" && item.streaming,
            createdAt: v2Now,
            updatedAt: v2Now,
          },
        ],
  );
  return {
    ...v2Projection,
    runs,
    attempts,
    nodes,
    turnItems,
    messages,
    visibleTurnItems: turnItems.map((item, position) => ({
      item,
      position,
      visibility: "local",
      sourceThreadId: threadId,
      sourceItemId: item.id,
    })),
  };
}

function feedReader() {
  const questions = createQuestionHistoryProjector();
  const build = createThreadFeedProjector();
  const present = createThreadFeedPresentationProjector();
  const expanded = new Set<RunId>();
  const decorate = createTimelineDecorationsProjector();
  const source = Atom.make<OrchestrationV2ThreadProjection>(v2Projection);
  let stages: Record<string, number> = {};
  const rows = Atom.make((get) => {
    const p = get(source);
    stages = {};
    const items = timed(stages, "questions", () => questions(p));
    const feed = timed(stages, "feed", () =>
      build(items, { nodes: p.nodes, attempts: p.attempts }),
    );
    const run = p.runs.at(-1);
    const latest = run
      ? {
          runId: run.id,
          status: run.status,
          startedAt: run.startedAt && DateTime.formatIso(run.startedAt),
          completedAt: run.completedAt && DateTime.formatIso(run.completedAt),
        }
      : null;
    const visible = timed(stages, "folds", () => present(feed, latest, expanded));
    threadFeedSummary(feed);
    threadFeedSummary(visible);
    decorate(visible, null);
    threadImageGallery(visible, { environmentId, threadId: p.thread.id, workspaceRoot: null });
    timed(stages, "media", () => threadHasMedia(p));
    return visible;
  });
  const registry = AtomRegistry.make();
  registry.mount(rows);
  return {
    stages: () => stages,
    put(p: OrchestrationV2ThreadProjection) {
      registry.set(source, p);
      return registry.get(rows);
    },
    registry,
  };
}

const decodeFull = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot),
);
const boundedCodec = Schema.toCodecJson(OrchestrationV2ThreadBoundedSnapshot);
for (const size of [3000, 20000, 60000]) {
  it.skipIf(selection !== String(size))(
    "measures bounded and full opens at " + size,
    () => {
      const full = chatFixture(size);
      const lastRun = full.runs.at(-1)!;
      // Model the HTTP store's one-turn SQL window, including its live/ancestry set
      // (empty here). ThreadStream applies the real compact body and ID-table policy.
      const recent = buildBoundedThreadStreamSnapshot({
        snapshotSequence: 1,
        snapshotUserTurnLimit: 1,
        projection: {
          ...full,
          runs: [lastRun],
          attempts: full.attempts.slice(-1),
          nodes: full.nodes.filter((n) => n.runId === lastRun.id),
        },
        compactIds: true,
        dedupeBodies: true,
        compactTurnItems: true,
      });
      const boundedBody = Buffer.from(
        JSON.stringify(
          Schema.encodeSync(boundedCodec)({
            ...recent,
            historyCursor: recent.historyCursor ?? null,
            hasMoreHistory: recent.hasMoreHistory ?? false,
            latestLocalTurnOrdinal: recent.latestLocalTurnOrdinal ?? null,
          }),
        ),
      );
      const fullBody = Buffer.from(JSON.stringify({ snapshotSequence: 1, projection: full }));
      for (const bounded of [true, false]) {
        const body = bounded ? boundedBody : fullBody;
        measure(
          size,
          () => {
            const t: Record<string, number> = { bounded: Number(bounded), bytes: body.length };
            const parsed = timed(t, "parse", () => JSON.parse(body.toString()));
            const p = timed(t, "decode", () =>
              bounded
                ? boundedSnapshotProjection(Schema.decodeUnknownSync(boundedCodec)(parsed))
                : decodeFull(parsed).projection,
            );
            const reader = feedReader();
            const rows = timed(t, "storeAndFeed", () => reader.put(p));
            t.ready = t.parse! + t.decode! + t.storeAndFeed!;
            t.readyCpu = t.parseCpu! + t.decodeCpu! + t.storeAndFeedCpu!;
            for (const [key, duration] of Object.entries(reader.stages()))
              t["open_" + key] = duration;
            t.items = p.visibleTurnItems.length;
            t.nodes = p.nodes.length;
            t.runs = p.runs.length;
            t.rows = rows.length;
            const last = p.turnItems.at(-1)!;
            expect(last.type).toBe("assistant_message");
            if (last.type !== "assistant_message") throw new Error("missing reply");
            const event = {
              id: EventId.make("event"),
              type: "turn-item.updated" as const,
              threadId: p.thread.id,
              occurredAt: v2Now,
            };
            const updated = timed(t, "tokenReduce", () =>
              applyOrchestrationV2ProjectionEvent(
                p,
                { ...event, payload: { ...last, text: last.text + " next" } },
                { partialTimeline: bounded },
              )!,
            );
            timed(t, "tokenFeed", () => reader.put(updated));
            const appended = timed(t, "appendReduce", () =>
              applyOrchestrationV2ProjectionEvent(
                updated,
                {
                  ...event,
                  payload: {
                    ...last,
                    id: TurnItemId.make("new"),
                    messageId: MessageId.make("new"),
                    ordinal: last.ordinal + 1,
                    text: "Another reply",
                  },
                },
                { partialTimeline: bounded },
              )!,
            );
            timed(t, "appendFeed", () => reader.put(appended));
            for (const [key, duration] of Object.entries(reader.stages()))
              t["append_" + key] = duration;
            reader.registry.dispose();
            return t;
          },
          bounded ? 9 : 3,
        );
      }
    },
    30000,
  );
}
