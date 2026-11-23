import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import {
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  type OrchestrationV2HistoricalMessage,
} from "@t3tools/contracts";
import {
  segmentCasualMessage,
  parseCasualDecisions,
  casualVisibleText,
} from "@t3tools/shared/casualVoice";
import { createCasualVoiceStore } from "@t3tools/client-runtime/casualVoice";
import { historyResponseItems, renderHistory } from "@t3tools/provider-core/server/handoffBudget";
import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import { buildPrContentPrompt } from "@t3tools/provider-core/server/textGenerationPrompts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Handoffs from "../orchestration-v2/ContextHandoffService.ts";

const original = "The result is probably not safe. Hope this helps.";
const display = parseCasualDecisions(
  segmentCasualMessage(original, "final"),
  "1 say: the result is probably not safe.\n2 hide: filler",
)!;
const threadId = ThreadId.make("isolation-chat");
const runId = RunId.make("isolation-run");
const messageId = MessageId.make("isolation-message");
const backend = {
  kind: "provider",
  modelSelection: { instanceId: ProviderInstanceId.make("fake"), model: "test-model" },
} as const;
const now = DateTime.makeUnsafe("2026-10-26T00:00:00Z");
const item: OrchestrationV2TurnItem = Object.freeze({
  id: TurnItemId.make("isolation-item"),
  type: "assistant_message",
  messageId,
  text: original,
  streaming: false,
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: null,
  startedAt: now,
  completedAt: now,
  updatedAt: now,
});
const history: ReadonlyArray<OrchestrationV2HistoricalMessage> = Object.freeze([
  {
    role: "assistant",
    text: original,
    threadId,
    runId,
    itemId: item.id,
    providerThreadId: null,
    status: "completed",
    kind: "assistant_message",
  },
]);
async function populateDisplayStore() {
  const store = createCasualVoiceStore();
  await store.load("mac\nisolation-chat", threadId, async () => ({
    enabled: true,
    backend,
    models: [],
  }));
  await store.rewrite(
    "mac\nisolation-chat",
    threadId,
    messageId,
    async () => ({ enabled: true, backend, display }),
    runId,
  );
  return store;
}
const layer = Handoffs.layer.pipe(
  Layer.provide(IdAllocator.layer),
  Layer.provideMerge(NodeServices.layer),
);
it.layer(layer)("display-only context isolation", (it) => {
  it.effect(
    "native history, titles and PR inputs retain originals after display rewriting and hiding",
    () =>
      Effect.gen(function* () {
        yield* Effect.promise(populateDisplayStore);
        expect(casualVisibleText(display)).not.toContain("Hope this helps.");
        const title = formatThreadTitleContext([{ role: "assistant", text: original }]);
        const pr = buildPrContentPrompt({
          baseBranch: "main",
          headBranch: "work",
          commitSummary: original,
          diffSummary: original,
          diffPatch: original,
        });
        const native = historyResponseItems(history, "native context");
        for (const value of [
          title.message,
          pr.prompt,
          renderHistory(history, "native context"),
          native[1]!.content[0]!.text,
        ]) {
          expect(value).toContain(original);
          expect(value).not.toContain("hid 1 line");
          expect(value).not.toContain("1 say:");
        }
        expect(history[0]!.text).toBe(original);
      }),
  );
  it.effect("forks, subagent transfers, handoffs and summaries carry the full originals", () =>
    Effect.gen(function* () {
      yield* Effect.promise(populateDisplayStore);
      const service = yield* Handoffs.ContextHandoffServiceV2;
      const common = {
        targetRunId: runId,
        toProviderThreadId: ProviderThreadId.make("target-native"),
        createdAt: now,
      };
      const transferred = {
        ...common,
        threadId,
        fromProviderThreadIds: [],
        fromProviderInstanceId: ProviderInstanceId.make("source"),
        toProviderInstanceId: backend.modelSelection.instanceId,
        transferId: null,
        coveredRunOrdinals: { from: 1, to: 1 },
      };
      const imported = yield* service.prepareLegacyImport({
        ...common,
        threadId,
        toProviderInstanceId: backend.modelSelection.instanceId,
        items: [item],
      });
      const fork = yield* service.prepareForkDelta({
        ...transferred,
        sourceThreadId: threadId,
        targetThreadId: ThreadId.make("fork"),
        deltaItems: [item],
      });
      const full = yield* service.prepareProviderHandoff({
        ...transferred,
        strategy: "full_thread_summary",
        items: [item],
      });
      const delta = yield* service.prepareProviderHandoff({
        ...transferred,
        strategy: "delta_since_target_last_seen",
        items: [item],
      });
      for (const handoff of [imported, fork, full, delta]) {
        expect(handoff.summaryText).toContain(original);
        expect(handoff.history?.messages[0]?.text).toBe(original);
        const prompt = Handoffs.providerMessageWithContextHandoff({
          handoff,
          userText: "Continue with the original constraints.",
        });
        expect(prompt).toContain(original);
        expect(prompt).not.toContain("hide: filler");
      }
      expect(item.text).toBe(original);
    }),
  );
  it.effect("prompt-building paths cannot depend on or read the presentation store", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = path.resolve(import.meta.dirname, "../../../..");
      const paths = {
        "native history": "packages/provider-core/src/server/handoffBudget.ts",
        "follow-ups and steers": "apps/server/src/orchestration-v2/Orchestrator.ts",
        "forks and rewinds": "apps/server/src/orchestration-v2/ThreadLaunchService.ts",
        "rewind and thread history": "apps/server/src/orchestration-v2/ThreadManagementService.ts",
        "side chats /btw and /side": "apps/server/src/sideChat/SideChatService.ts",
        "subagent context transfers": "apps/server/src/orchestration-v2/ContextHandoffDelivery.ts",
        "handoffs and summaries": "apps/server/src/orchestration-v2/ContextHandoffService.ts",
        "thread titles": "apps/server/src/orchestration-v2/ThreadTitleRegenerationService.ts",
        "PR text": "apps/server/src/git/GitManager.ts",
      };
      for (const [kind, file] of Object.entries(paths)) {
        const source = yield* fs.readFileString(path.join(root, file));
        expect(source, kind).not.toMatch(
          /(?:casualVoice|CasualVoice|casual-voice|rewriteProse|casualVisibleText)/,
        );
      }
    }),
  );
});
