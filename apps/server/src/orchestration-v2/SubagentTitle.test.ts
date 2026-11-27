import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ExecutionResources from "../execution/ExecutionResources.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
// No effect worker: runs stay unstarted and title generation never runs.
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "subagent-title" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ExecutionResources.layer),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

/** Starts a parent run and delegates one titled task from it; returns the child thread. */
const delegateTitled = (parentThreadId: ThreadId, title: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${parentThreadId}`),
      threadId: parentThreadId,
      projectId: ProjectId.make("project:subagent-title"),
      title: "Lead",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${parentThreadId}`),
      threadId: parentThreadId,
      messageId: MessageId.make(`message:${parentThreadId}`),
      text: "Delegate the research",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${parentThreadId}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task: "Research when agents use subagents",
      title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    return (yield* orchestrator.getThreadProjection(parentThreadId)).subagents[0]!.childThreadId!;
  });

/** What the parent shows for its subagent: the Agents sheet's record and the timeline card. */
const parentTitles = (parentThreadId: ThreadId) =>
  Effect.gen(function* () {
    const parent = yield* (yield* Orchestrator.OrchestratorV2).getThreadProjection(parentThreadId);
    return {
      record: parent.subagents.map((task) => task.title),
      card: parent.turnItems.flatMap((item) => (item.type === "subagent" ? [item.title] : [])),
    };
  });

const rename = (threadId: ThreadId, commandId: string, title: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: CommandId.make(commandId),
      threadId,
      title,
    }),
  );

it.effect("renaming a delegated child renames its subagent on the parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentThreadId = ThreadId.make("thread:subagent-title:rename");
    const fullTitle =
      "Research subagents: when agents use them, how often they finish, and what they cost";
    const childThreadId = yield* delegateTitled(parentThreadId, fullTitle);
    const clipped = (yield* orchestrator.getThreadProjection(childThreadId)).thread.title;
    assert.notEqual(clipped, fullTitle);

    // Sending the child's clipped title again is no rename; the full title stays.
    yield* rename(childThreadId, "rename:same", clipped);
    assert.deepEqual(yield* parentTitles(parentThreadId), {
      record: [fullTitle],
      card: [fullTitle],
    });

    // The t3_thread_update rename and the chat's own rename send this command.
    yield* rename(childThreadId, "rename:new", "Orchestration overhaul (Neon lead)");
    assert.equal(
      (yield* orchestrator.getThreadProjection(childThreadId)).thread.title,
      "Orchestration overhaul (Neon lead)",
    );
    assert.deepEqual(yield* parentTitles(parentThreadId), {
      record: ["Orchestration overhaul (Neon lead)"],
      card: ["Orchestration overhaul (Neon lead)"],
    });
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a regenerated child title reaches its subagent on the parent", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentThreadId = ThreadId.make("thread:subagent-title:regenerate");
    const childThreadId = yield* delegateTitled(parentThreadId, "Research subagents");
    const requestId = CommandId.make("regenerate:child");
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: requestId,
      threadId: childThreadId,
      regenerateTitle: true,
    });
    yield* orchestrator.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: CommandId.make("regenerate:child:complete"),
      threadId: childThreadId,
      requestId,
      title: "Subagent usage study",
    });
    assert.deepEqual(yield* parentTitles(parentThreadId), {
      record: ["Subagent usage study"],
      card: ["Subagent usage study"],
    });
  }).pipe(Effect.provide(layerTest)),
);
