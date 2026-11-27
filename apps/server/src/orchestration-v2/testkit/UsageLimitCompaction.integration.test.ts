import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ClaudeProviderCapabilitiesV2 } from "../Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";
import { type CapturedTurn, makeTestAdapter } from "./ProviderSwitch.testkit.ts";
import { CLAUDE_MODEL_SELECTION } from "./fixtures/shared.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const threadId = ThreadId.make("thread:limit-compaction");
const projectId = ProjectId.make("project:provider-switch");
const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

const runLimitedSwitch = (scenario: string): Effect.Effect<void, unknown> =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace(`limit-${scenario}`);
      const capturedTurns = yield* Ref.make<ReadonlyArray<CapturedTurn>>([]);
      const capturedCompactions = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
      const injectedHistory = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const nativeThreadGeneration = yield* Ref.make(0);
      const failStartOnce = yield* Ref.make(false);
      const retry = scenario === "cross-retry";
      const sameHarness = scenario.startsWith("same-");
      const returning = scenario.startsWith("returning-");
      const larger = scenario === "returning-larger-target";
      const estimated = scenario === "returning-estimated-full";
      const smaller = scenario === "same-smaller-window" || scenario === "same-sticky-native";
      const inline = scenario === "cross-compact-inline";
      const oversized = scenario === "cross-oversized-history";
      const driver = sameHarness
        ? CLAUDE_DRIVER
        : ProviderDriverKind.make(
            scenario === "cross-opencode"
              ? "opencode"
              : scenario === "cross-acp"
                ? "acp"
                : scenario === "cross-pi"
                  ? "pi"
                  : scenario === "cross-cursor"
                    ? "cursor"
                    : scenario === "cross-muse"
                      ? "muse"
                      : "codex",
          );
      const targetSelection: ModelSelection = sameHarness
        ? { ...CLAUDE_MODEL_SELECTION, model: "claude-haiku-4-5" }
        : {
            instanceId: ProviderInstanceId.make(`limit-target-${driver}`),
            model: larger ? "selected-larger" : "selected-model",
          };
      const initialTargetSelection = larger
        ? { ...targetSelection, model: "selected-model" }
        : targetSelection;
      const targetAdapter = makeTestAdapter({
        instanceId: targetSelection.instanceId,
        driver,
        capabilities: sameHarness ? ClaudeProviderCapabilitiesV2 : CodexProviderCapabilitiesV2,
        modelSelection: targetSelection,
        responseByRunOrdinal: {
          // About 42k tokens at 4 bytes a token: more than the 32k window without a usage report.
          ...(estimated ? { 1: "Earlier target work. ".repeat(8_000) } : {}),
          [returning ? 3 : 2]: "Recovered continuation summary",
        },
        capturedTurns,
        capturedCompactions,
        nativeThreadGeneration,
        stickyNativeThread: scenario === "same-sticky-native",
        ...(retry ? { failStartOnce } : {}),
        ...(inline ? {} : { injectedHistory }),
        ...(sameHarness ? { limitedRunOrdinals: new Set([1]) } : {}),
        getModelContextWindow: (selection) =>
          larger && selection.model === targetSelection.model
            ? 128_000
            : smaller && selection.model === targetSelection.model
              ? 32_000
              : returning
                ? 32_000
                : 128_000,
        tokenUsageByRunOrdinal: estimated
          ? {}
          : {
              1: {
                usedTokens: smaller ? 80_000 : returning ? 30_000 : 20_000,
                maxTokens: returning ? 32_000 : 128_000,
              },
            },
      });
      const sourceAdapter = makeTestAdapter({
        instanceId: CLAUDE_MODEL_SELECTION.instanceId,
        driver: CLAUDE_DRIVER,
        capabilities: ClaudeProviderCapabilitiesV2,
        modelSelection: CLAUDE_MODEL_SELECTION,
        responseByRunOrdinal: {
          [returning ? 2 : 1]: oversized
            ? "Detailed earlier work ".repeat(8_000)
            : "Preserve the partial work",
        },
        limitedRunOrdinals: new Set([returning ? 2 : 1]),
        capturedTurns,
        capturedCompactions,
      });
      const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(
        sameHarness ? [targetAdapter] : [sourceAdapter, targetAdapter],
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const dispatch = Effect.fnUntraced(function* (
          ordinal: number,
          text: string,
          modelSelection: ModelSelection,
        ) {
          const terminal = yield* orchestrator.streamStoredEvents.pipe(
            Stream.filter(
              ({ event }) =>
                event.type === "run.updated" &&
                event.payload.ordinal === ordinal &&
                (event.payload.status === "completed" || event.payload.status === "failed"),
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`limit:${ordinal}`),
            threadId,
            messageId: MessageId.make(`limit:${ordinal}`),
            createdBy: "user",
            creationSource: "web",
            text,
            attachments: [],
            modelSelection,
            dispatchMode: { type: "start_immediately" },
          });
          yield* Fiber.join(terminal);
          yield* worker.drain();
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("limit:create"),
          threadId,
          projectId,
          createdBy: "user",
          creationSource: "web",
          title: "Limited switch",
          modelSelection: returning ? initialTargetSelection : CLAUDE_MODEL_SELECTION,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        const originalRequest = oversized
          ? "Long original constraints ".repeat(4_000)
          : "Original request: preserve the user's constraints";
        yield* dispatch(
          1,
          originalRequest,
          returning ? initialTargetSelection : CLAUDE_MODEL_SELECTION,
        );
        const first = (yield* Ref.get(capturedTurns))[0]!;
        if (returning)
          yield* dispatch(2, "New work on the exhausted model", CLAUDE_MODEL_SELECTION);
        const compact = scenario.includes("compact") || smaller || retry;
        if (retry) yield* Ref.set(failStartOnce, true);
        yield* dispatch(
          returning ? 3 : 2,
          compact ? "/compact" : "Continue the work",
          targetSelection,
        );
        if (retry) {
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
            "failed",
          );
          yield* dispatch(3, "/compact", targetSelection);
        }
        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(projection.runs.at(-1)?.status, "completed");
        const turns = yield* Ref.get(capturedTurns);
        const target = turns.at(-1)!;
        assert.deepEqual(target.modelSelection, targetSelection);
        assert.lengthOf(turns, returning ? 3 : 2);
        const notices = projection.turnItems.filter(
          (item) => item.type === "system_notice" && item.title === "Context recovery",
        );
        if (scenario === "same-native-compact" || scenario === "same-native-auto") {
          assert.equal(target.nativeThreadId, first.nativeThreadId);
          assert.deepEqual(yield* Ref.get(capturedCompactions), compact ? [targetSelection] : []);
          assert.equal(target.text, compact ? "/compact" : "Continue the work");
          assert.lengthOf(notices, 0);
        } else {
          assert.deepEqual(yield* Ref.get(capturedCompactions), []);
          assert.include(target.text, "Write a concise continuation summary");
          if (compact) assert.include(target.text, "Reply with the summary and wait");
          assert.lengthOf(notices, retry ? 2 : 1);
          assert.equal(notices[0]?.type, "system_notice");
          if (notices[0]?.type === "system_notice") {
            assert.include(notices[0].message, targetSelection.model);
            assert.include(notices[0].message, CLAUDE_MODEL_SELECTION.model);
            assert.include(notices[0].message, "full conversation remains saved");
          }
          const delivered = inline
            ? target.text
            : yield* encodeJson(yield* Ref.get(injectedHistory));
          assert.include(delivered, "t3_thread_read");
          if (oversized) {
            // The request fits the first turn but exceeds the handoff budget. Keep its
            // start in the handoff and the full text in the chat.
            assert.isTrue(
              projection.contextHandoffs.some((handoff) =>
                handoff.history?.messages.some(
                  (message) => message.shortened && message.kind === "user_message",
                ),
              ),
            );
            assert.include(delivered, "Long original constraints Long original constraints");
            assert.include(delivered, "characters cut]");
            assert.isTrue(
              projection.turnItems.some(
                (item) => item.type === "user_message" && item.text === originalRequest,
              ),
            );
          } else {
            assert.include(delivered, larger ? "New work on the exhausted model" : originalRequest);
          }
          if (smaller || (returning && !larger)) {
            assert.notEqual(target.nativeThreadId, first.nativeThreadId);
            assert.equal(yield* Ref.get(nativeThreadGeneration), 2);
            const providerThread = projection.providerThreads.find(
              (thread) => thread.id === target.providerThreadId,
            )!;
            assert.isNull(providerThread.contextUsage);
          } else if (larger) {
            assert.equal(target.nativeThreadId, first.nativeThreadId);
            assert.equal(yield* Ref.get(nativeThreadGeneration), 1);
          }
        }
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            {
              name: `limit-${scenario}`,
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: {
                  type: "readOnly",
                  access: { type: "fullAccess" },
                  networkAccess: false,
                },
              },
            },
            layerRegistry,
          ),
        ),
      );
    }),
  );

describe("usage limit context recovery", () => {
  it.live.each([
    "same-native-compact",
    "same-native-auto",
    "same-smaller-window",
    "same-sticky-native",
    "cross-codex",
    "cross-opencode",
    "cross-acp",
    "cross-pi",
    "cross-cursor",
    "cross-muse",
    "cross-compact-native",
    "cross-compact-inline",
    "cross-oversized-history",
    "cross-retry",
    "returning-full-target",
    "returning-larger-target",
    "returning-estimated-full",
  ] as const)("recovers a usage-limited model switch: %s", runLimitedSwitch);
});
