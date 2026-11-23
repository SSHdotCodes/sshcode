import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for admission"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "dispatch-review" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.effect("an auto deferred start sees imported user history that has no runs", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:imported-history");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create-imported-history"),
      threadId,
      projectId: ProjectId.make("project:imported-history"),
      title: "Imported history",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    // Session and cloud importers record user messages without runs.
    const now = yield* DateTime.now;
    yield* store.apply({
      id: EventId.make("imported-user-message"),
      type: "message.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: MessageId.make("imported-user-message"),
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: "imported prompt",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    });
    // The empty-thread exception for a deferred auto start must not apply:
    // the chat already has user messages, so the send starts immediately.
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("agent-auto-deferred"),
      threadId,
      messageId: MessageId.make("agent-auto-deferred"),
      text: "continue",
      attachments: [],
      deliveryIntent: "auto",
      dispatchMode: { type: "defer_start" },
      createdBy: "agent",
      creationSource: "server",
    });
    const { runs } = yield* store.getThreadRecords(threadId, ["runs"]);
    assert.deepEqual(
      runs.map((run) => run.status),
      ["starting"],
    );
  }).pipe(Effect.provide(layerTest)),
);
