import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import { HANDOFF_BRIEF_PROMPT } from "../HandoffBriefService.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { CLAUDE_MODEL_SELECTION, CODEX_MODEL_SELECTION } from "./fixtures/shared.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./ProviderSwitch.testkit.ts";

const projectId = ProjectId.make("project:handoff-brief");
const BRIEF = [
  `## Goal and requirements\nThe user wants "the importer to stream, never buffer".`,
  `## Where things stand\n${"Specifics. ".repeat(12)}`,
  "## Done and verified\nParser tests pass.",
  "## Next step\nStream the writer.",
].join("\n\n");

const scenario = (input: {
  readonly name: string;
  readonly run: (harness: {
    readonly threadId: ThreadId;
    readonly send: (
      ordinal: number,
      text: string,
      selection: ModelSelection,
    ) => Effect.Effect<void>;
    readonly select: (selection: ModelSelection) => Effect.Effect<void>;
    readonly turns: Effect.Effect<ReadonlyArray<CapturedTurn>>;
    readonly questions: Effect.Effect<ReadonlyArray<string>>;
  }) => Effect.Effect<void, never, Orchestrator.OrchestratorV2>;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const threadId = ThreadId.make(`thread:${input.name}`);
      const cwd = yield* checkpointWorkspace(input.name);
      const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const sideQuestions = yield* Ref.make<ReadonlyArray<string>>([]);
      const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
        makeTestAdapter({
          instanceId: CLAUDE_MODEL_SELECTION.instanceId,
          driver: ProviderDriverKind.make("claudeAgent"),
          capabilities: ClaudeProviderCapabilitiesV2,
          modelSelection: CLAUDE_MODEL_SELECTION,
          responseByRunOrdinal: { 1: "Claude started the importer" },
          capturedTurns,
          sideAnswer: Effect.succeed(BRIEF),
          sideQuestions,
        }),
        makeTestAdapter({
          instanceId: CODEX_MODEL_SELECTION.instanceId,
          driver: ProviderDriverKind.make("codex"),
          capabilities: CodexProviderCapabilitiesV2,
          modelSelection: CODEX_MODEL_SELECTION,
          responseByRunOrdinal: { 2: "Codex continued" },
          capturedTurns,
        }),
      ]);
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const settled = (ordinal: number) =>
          orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.payload.ordinal === ordinal &&
                (event.payload.status === "completed" || event.payload.status === "failed"),
            ),
            Stream.runHead,
            Effect.andThen(worker.drain()),
          );
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make(`${input.name}:create`),
          threadId,
          projectId,
          createdBy: "user",
          creationSource: "web",
          title: "Handoff brief",
          modelSelection: CLAUDE_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* input.run({
          threadId,
          send: (ordinal, text, selection) =>
            orchestrator
              .dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`${input.name}:${ordinal}`),
                threadId,
                messageId: MessageId.make(`${input.name}:${ordinal}`),
                createdBy: "user",
                creationSource: "web",
                text,
                attachments: [],
                modelSelection: selection,
                dispatchMode: { type: "start_immediately" },
              })
              .pipe(Effect.andThen(settled(ordinal)), Effect.orDie),
          select: (selection) =>
            orchestrator
              .dispatch({
                type: "thread.model-selection.set",
                commandId: CommandId.make(`${input.name}:select:${selection.instanceId}`),
                threadId,
                modelSelection: selection,
              })
              .pipe(Effect.andThen(worker.drain()), Effect.orDie),
          turns: Ref.get(capturedTurns),
          questions: Ref.get(sideQuestions),
        });
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name: input.name,
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: { type: "readOnly" },
              },
            },
            layerRegistry,
          ),
        ),
      );
    }),
  );

describe("handoff brief", () => {
  it.live("hands the new provider the outgoing model's brief ahead of the history", () =>
    scenario({
      name: "handoff-brief-delivered",
      run: ({ threadId, send, select, turns, questions }) =>
        Effect.gen(function* () {
          yield* send(1, "Original request: stream the importer", CLAUDE_MODEL_SELECTION);
          yield* select(CODEX_MODEL_SELECTION);
          yield* send(2, "Carry on", CODEX_MODEL_SELECTION);
          assert.deepEqual(yield* questions, [HANDOFF_BRIEF_PROMPT]);
          const text = (yield* turns).at(-1)!.text;
          assert.isTrue(
            text.startsWith(
              `[Handoff brief from the previous model, ${CLAUDE_MODEL_SELECTION.model}`,
            ),
          );
          const briefAt = text.indexOf("the importer to stream, never buffer");
          const historyAt = text.indexOf("Original request: stream the importer");
          assert.isTrue(briefAt > 0 && briefAt < historyAt);
          assert.isTrue(text.endsWith("User message:\nCarry on"));
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const projection = yield* orchestrator.getThreadProjection(threadId).pipe(Effect.orDie);
          assert.equal(projection.contextHandoffs.at(-1)?.brief?.text, BRIEF.trim());
          const row = projection.turnItems.find((item) => item.type === "handoff");
          assert.deepEqual(row?.type === "handoff" ? row.brief : undefined, {
            providerInstanceId: CLAUDE_MODEL_SELECTION.instanceId,
            model: CLAUDE_MODEL_SELECTION.model,
          });
        }),
    }),
  );

  it.live("drops the brief when the selection returns to the outgoing provider", () =>
    scenario({
      name: "handoff-brief-superseded",
      run: ({ send, select, turns, questions }) =>
        Effect.gen(function* () {
          yield* send(1, "Original request: stream the importer", CLAUDE_MODEL_SELECTION);
          yield* select(CODEX_MODEL_SELECTION);
          yield* select(CLAUDE_MODEL_SELECTION);
          yield* send(2, "Carry on", CLAUDE_MODEL_SELECTION);
          assert.lengthOf(yield* questions, 1);
          const last = (yield* turns).at(-1)!;
          assert.equal(last.modelSelection.instanceId, CLAUDE_MODEL_SELECTION.instanceId);
          assert.notInclude(last.text, "Handoff brief");
        }),
    }),
  );
});
