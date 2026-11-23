import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ChatControls from "./chatControls.ts";
import * as Verdicts from "./firstSubagentVerdicts.ts";

const parentId = ThreadId.make("parent");
const at = DateTime.makeUnsafe("2026-11-09T07:00:00Z");
const lead = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const childModel = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };

const thread: OrchestrationV2AppThread = {
  id: parentId,
  createdBy: "user",
  creationSource: "web",
  projectId: ProjectId.make("project"),
  title: "Parent",
  providerInstanceId: lead.instanceId,
  modelSelection: lead,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: "/tmp/parent",
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: parentId,
  },
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

const task = (
  id: string,
  extra: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent => ({
  id: NodeId.make(id),
  threadId: parentId,
  runId: null,
  parentNodeId: NodeId.make("parent-node"),
  origin: "app_owned",
  createdBy: "agent",
  driver: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: childModel.instanceId,
  providerThreadId: null,
  childThreadId: ThreadId.make(`child-${id}`),
  nativeTaskRef: null,
  prompt: "work",
  title: id,
  model: childModel.model,
  modelSelection: childModel,
  status: "running",
  result: null,
  startedAt: at,
  completedAt: null,
  updatedAt: at,
  ...extra,
});

let eventOrdinal = 0;
const taskEvent = (value: OrchestrationV2Subagent): OrchestrationV2DomainEvent => ({
  id: EventId.make(`first-subagent-event-${++eventOrdinal}`),
  type: "subagent.updated",
  threadId: value.threadId,
  occurredAt: at,
  payload: value,
});

const platform = ServerConfig.layerTest(process.cwd(), { prefix: "first-subagent-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const testLayer = Layer.mergeAll(
  RuntimeLayer.layerEventSink,
  ProjectionStore.layer,
  Verdicts.layer.pipe(Layer.provide(ProjectionStore.layer)),
).pipe(
  Layer.provideMerge(ChatControls.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(platform),
);

const setup = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make(`thread-${++eventOrdinal}`),
    type: "thread.created",
    threadId: parentId,
    occurredAt: at,
    payload: thread,
  });
  const sink = yield* EventSink.EventSinkV2;
  const askOf = () =>
    store.getThreadShell(parentId).pipe(Effect.map((shell) => shell?.firstSubagentAsk ?? null));
  return { sink, askOf };
});

it.effect("asks on the chat's first subagent only, until it stops", () =>
  Effect.gen(function* () {
    const { sink, askOf } = yield* setup;
    yield* sink.write({
      events: [taskEvent(task("native", { origin: "provider_native", childThreadId: null }))],
    });
    expect(yield* askOf()).toBeNull();
    yield* sink.write({ events: [taskEvent(task("first"))] });
    expect(yield* askOf()).toBe("first");
    yield* sink.write({ events: [taskEvent(task("second"))] });
    expect(yield* askOf()).toBe("first");
    yield* sink.write({ events: [taskEvent(task("second", { status: "completed" }))] });
    expect(yield* askOf()).toBe("first");
    yield* sink.write({ events: [taskEvent(task("first", { status: "completed" }))] });
    expect(yield* askOf()).toBeNull();
    yield* sink.write({ events: [taskEvent(task("third"))] });
    expect(yield* askOf()).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("does not ask in a chat whose first subagent already finished", () =>
  Effect.gen(function* () {
    const { sink, askOf } = yield* setup;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    // Written straight to the projection, as before this process started.
    yield* store.apply(taskEvent(task("earlier", { status: "completed" })));
    yield* sink.write({ events: [taskEvent(task("later"))] });
    expect(yield* askOf()).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("does not ask about a first subagent the user started themselves", () =>
  Effect.gen(function* () {
    const { sink, askOf } = yield* setup;
    yield* sink.write({ events: [taskEvent(task("mine", { createdBy: "user" }))] });
    expect(yield* askOf()).toBeNull();
    // They have shown they want subagents here: the agent's own first one is not asked about.
    yield* sink.write({ events: [taskEvent(task("agents"))] });
    expect(yield* askOf()).toBeNull();
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("saves a bounded verdict with both models and turns the switch off for solo", () =>
  Effect.gen(function* () {
    const { sink, askOf } = yield* setup;
    const verdicts = yield* Verdicts.FirstSubagentVerdicts;
    const controls = yield* ChatControls.ChatControls;
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const file = `${config.stateDir}/${Verdicts.VERDICTS_FILE}`;
    const old = {
      threadId: "old",
      taskId: "old",
      verdict: "fine",
      lead: { instanceId: "codex", model: null },
      child: { instanceId: "codex", model: null },
      at: "2026-11-01T00:00:00.000Z",
    };
    yield* fs.writeFileString(
      file,
      JSON.stringify({
        version: 1,
        verdicts: Array.from({ length: Verdicts.MAX_VERDICTS }, () => old),
      }),
    );
    yield* sink.write({ events: [taskEvent(task("first"))] });
    expect(yield* askOf()).toBe("first");

    const missing = yield* verdicts
      .answer({ threadId: parentId, taskId: NodeId.make("nope"), verdict: "solo" })
      .pipe(Effect.flip);
    expect(missing.message).toBe("This chat has no such subagent.");
    expect(controls.subagentsEnabled(parentId)).toBe(true);

    yield* verdicts.answer({ threadId: parentId, taskId: NodeId.make("first"), verdict: "solo" });
    expect(controls.subagentsEnabled(parentId)).toBe(false);
    expect(yield* askOf()).toBeNull();
    const saved = JSON.parse(yield* fs.readFileString(file));
    expect(saved.verdicts).toHaveLength(Verdicts.MAX_VERDICTS);
    expect(saved.verdicts.at(-1)).toMatchObject({
      threadId: parentId,
      taskId: "first",
      verdict: "solo",
      lead,
      child: childModel,
    });

    // A second answer, say from the phone, changes nothing.
    yield* verdicts.answer({ threadId: parentId, taskId: NodeId.make("first"), verdict: "fine" });
    expect(JSON.parse(yield* fs.readFileString(file)).verdicts.at(-1).verdict).toBe("solo");
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
