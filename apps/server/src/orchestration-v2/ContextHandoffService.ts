import {
  OrchestrationV2ContextHandoff,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  DEFAULT_HANDOFF_TOKEN_CAP,
  MAX_HANDOFF_TOKEN_CAP,
  handoffChangedFiles,
  handoffTokenCapConfig,
  handoffCoverage,
  handoffMessage,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import { cancelledTurnItemWork } from "./RestartBackgroundNote.ts";

// Failed and interrupted turns still contain conversation the next provider needs.
// Queued, cancelled, and rolled-back runs must not be replayed as conversation.
export function isHandoffSourceRun(run: OrchestrationV2Run): boolean {
  return run.status === "completed" || run.status === "failed" || run.status === "interrupted";
}

export class ContextHandoffPrepareError extends Schema.TaggedError<ContextHandoffPrepareError>()(
  "ContextHandoffPrepareError",
  {
    threadId: ThreadId,
    targetRunId: RunId,
    fromProviderThreadIds: Schema.Array(ProviderThreadId),
    toProviderThreadId: ProviderThreadId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to prepare context handoff for run ${this.targetRunId} in thread ${this.threadId}.`;
  }
}

export const ContextHandoffServiceV2Error = Schema.Union([ContextHandoffPrepareError]);
export type ContextHandoffServiceV2Error = typeof ContextHandoffServiceV2Error.Type;

export interface ContextHandoffServiceV2Shape {
  readonly prepareLegacyImport: (input: {
    readonly threadId: ThreadId;
    readonly targetRunId: RunId;
    readonly toProviderThreadId: ProviderThreadId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  readonly prepare: (input: {
    readonly threadId: ThreadId;
    readonly targetRunId: RunId;
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  readonly prepareForkDelta: (input: {
    readonly sourceThreadId: ThreadId;
    readonly targetThreadId: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: OrchestrationV2ContextHandoff["transferId"];
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
  readonly prepareProviderHandoff: (input: {
    readonly threadId: ThreadId;
    readonly targetRunId: RunId;
    readonly transferId: OrchestrationV2ContextHandoff["transferId"];
    readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
    readonly toProviderThreadId: ProviderThreadId;
    readonly fromProviderInstanceId: ProviderInstanceId;
    readonly toProviderInstanceId: ProviderInstanceId;
    readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
    readonly runs?: ReadonlyArray<OrchestrationV2Run>;
    readonly strategy: Extract<
      OrchestrationV2ContextHandoff["strategy"],
      "delta_since_target_last_seen" | "full_thread_summary"
    >;
    readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2ContextHandoff, ContextHandoffServiceV2Error>;
}

export class ContextHandoffServiceV2 extends Context.Service<
  ContextHandoffServiceV2,
  ContextHandoffServiceV2Shape
>()("t3/orchestration-v2/ContextHandoffService/ContextHandoffServiceV2") {}

function compactText(text: string, maxLength = 240): string {
  const compacted = text.replace(/\s+/g, " ").trim();
  if (compacted.length <= maxLength) {
    return compacted;
  }
  return `${compacted.slice(0, maxLength - 3)}...`;
}

function summarizeDeltaItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
      return `- User: ${compactText(item.text)}`;
    case "assistant_message":
      return `- Assistant: ${compactText(item.text)}`;
    case "command_execution":
      return `- Command: ${compactText(item.input)}`;
    case "file_change":
      return `- File change: ${item.fileName}`;
    case "checkpoint":
      return `- Checkpoint: ${item.files.length} files`;
    case "handoff":
      return `- Handoff: ${compactText(item.summary ?? item.strategy)}`;
    default:
      return null;
  }
}

function makeForkDeltaSummary(input: {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
  readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
}): string {
  const itemLines = input.deltaItems.flatMap((item) => {
    const line = summarizeDeltaItem(item);
    return line === null ? [] : [line];
  });
  return [
    "Merge-back context from forked conversation.",
    `Source thread: ${input.sourceThreadId}`,
    `Target thread: ${input.targetThreadId}`,
    `Covered fork runs: ${input.coveredRunOrdinals.from}-${input.coveredRunOrdinals.to}`,
    "",
    "Fork delta:",
    ...(itemLines.length === 0 ? ["- No user-visible delta items."] : itemLines),
  ].join("\n");
}

function makeLegacyImportSummary(items: ReadonlyArray<OrchestrationV2TurnItem>): string {
  const sections = items.flatMap((item) => {
    switch (item.type) {
      case "user_message":
        return [{ label: "User", body: item.text }];
      case "assistant_message":
        return [{ label: "Assistant", body: item.text }];
      default:
        return [];
    }
  });
  const header =
    "Imported conversation history from the previous SSHCode orchestrator. Use it as context; do not repeat it unless the user asks.";
  const maxChars = 32_000;
  const selected: Array<string> = [];
  let remaining = maxChars - header.length - 2;
  for (const section of sections.toReversed()) {
    if (remaining <= 0) break;
    const fullSection = `${section.label}:\n${section.body}`;
    if (fullSection.length <= remaining) {
      selected.unshift(fullSection);
      remaining -= fullSection.length + 2;
      continue;
    }

    const prefix = `${section.label}:\n... `;
    const bodyBudget = remaining - prefix.length;
    if (bodyBudget <= 0) continue;

    const initialStart = section.body.length - bodyBudget;
    let bodyStart = Math.max(0, initialStart);
    if (
      bodyStart > 0 &&
      !/\s/.test(section.body[bodyStart - 1] ?? "") &&
      !/\s/.test(section.body[bodyStart] ?? "")
    ) {
      const nextWhitespace = section.body.slice(bodyStart).search(/\s/);
      if (nextWhitespace !== -1) {
        bodyStart += nextWhitespace;
      }
    }
    const codeUnitAtStart = section.body.charCodeAt(bodyStart);
    const codeUnitBeforeStart = section.body.charCodeAt(bodyStart - 1);
    if (
      codeUnitAtStart >= 0xdc00 &&
      codeUnitAtStart <= 0xdfff &&
      codeUnitBeforeStart >= 0xd800 &&
      codeUnitBeforeStart <= 0xdbff
    ) {
      bodyStart += 1;
    }
    const bodySuffix = section.body.slice(bodyStart).trimStart();
    if (bodySuffix.length === 0) continue;

    const suffix = `${prefix}${bodySuffix}`;
    selected.unshift(suffix);
    remaining -= suffix.length + 2;
  }
  return [header, ...selected].join("\n\n");
}

export function providerMessageWithContextHandoff(input: {
  readonly handoff: OrchestrationV2ContextHandoff;
  readonly userText: string;
}): string {
  return providerMessageWithContextHandoffs({
    handoffs: [input.handoff],
    userText: input.userText,
  });
}

function providerMessageWithContextHandoffs(input: {
  readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
  readonly userText: string;
}): string {
  const handoffSections = input.handoffs.flatMap((handoff) => {
    const label =
      handoff.strategy === "fork_delta_summary"
        ? "merge_back / fork_delta_summary"
        : handoff.strategy;
    return [`Context handoff (${label}):`, handoff.summaryText, ""];
  });
  return [...handoffSections, "User message:", input.userText].join("\n");
}

const MAX_PENDING_WORK = 20;

/** What the successor should know about the workspace, from the covered items. */
function workspaceOf(items: ReadonlyArray<OrchestrationV2TurnItem>) {
  const changedFiles = handoffChangedFiles(items);
  // Settled runs leave background work running: subagents, monitors, background shells.
  const pendingWork = items
    .filter(
      (item) =>
        (item.status === "pending" || item.status === "running" || item.status === "waiting") &&
        (item.type === "subagent" ||
          item.type === "dynamic_tool" ||
          (item.type === "command_execution" && item.monitor === true)),
    )
    .flatMap((item) => {
      const work = cancelledTurnItemWork(item);
      return work === undefined ? [] : [{ kind: work.kind, label: work.label }];
    })
    .slice(-MAX_PENDING_WORK);
  return {
    ...(changedFiles.length === 0 ? {} : { changedFiles }),
    ...(pendingWork.length === 0 ? {} : { pendingWork }),
  };
}

const makeContextHandoffService = Effect.fn("orchestrationV2.ContextHandoffService.layer")(
  function* () {
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    // Stored at the largest size a target can take; delivery selects again for the actual target.
    const tokenCap = Option.getOrElse(
      yield* handoffTokenCapConfig.pipe(Effect.orElseSucceed(() => Option.none<number>())),
      () => MAX_HANDOFF_TOKEN_CAP,
    );

    const prepareLegacyImport = Effect.fn("orchestrationV2.contextHandoff.prepareLegacyImport")(
      function* (input: {
        readonly threadId: ThreadId;
        readonly targetRunId: RunId;
        readonly toProviderThreadId: ProviderThreadId;
        readonly toProviderInstanceId: ProviderInstanceId;
        readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly createdAt: DateTime.Utc;
      }) {
        const handoffId = yield* idAllocator.allocate
          .contextHandoff({
            threadId: input.threadId,
            fromProviderInstanceId: ProviderInstanceId.make("legacy"),
            toProviderInstanceId: input.toProviderInstanceId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ContextHandoffPrepareError({
                  threadId: input.threadId,
                  targetRunId: input.targetRunId,
                  fromProviderThreadIds: [],
                  toProviderThreadId: input.toProviderThreadId,
                  cause,
                }),
            ),
          );
        const coverage = handoffCoverage({ ...input, coveredRunOrdinals: { from: 1, to: 1 } });
        const selected = selectHistory({
          messages: input.items.flatMap((item) => {
            const message = handoffMessage(item);
            return message === null ? [] : [message];
          }),
          coverage,
          budget: tokenCap,
        });
        return {
          id: handoffId,
          transferId: null,
          threadId: input.threadId,
          targetRunId: input.targetRunId,
          fromProviderThreadIds: [],
          toProviderThreadId: input.toProviderThreadId,
          coveredRunOrdinals: { from: 1, to: 1 },
          strategy: "manual_context",
          status: "ready",
          summaryMessageId: null,
          summaryText: makeLegacyImportSummary(input.items),
          history: {
            messages: selected.messages,
            coverage,
            omittedItems: selected.omittedItems,
            omittedItemIds: selected.omittedItemIds,
          },
          createdByProviderInstanceId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } satisfies OrchestrationV2ContextHandoff;
      },
    );

    const prepare = Effect.fn("orchestrationV2.contextHandoff.prepare")(function* (input: {
      readonly threadId: ThreadId;
      readonly targetRunId: RunId;
      readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
      readonly toProviderThreadId: ProviderThreadId;
    }) {
      const now = yield* DateTime.now;
      const handoffId = yield* idAllocator.allocate
        .contextHandoff({
          threadId: input.threadId,
          fromProviderInstanceId: ProviderInstanceId.make("manual"),
          toProviderInstanceId: ProviderInstanceId.make("manual"),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ContextHandoffPrepareError({
                threadId: input.threadId,
                targetRunId: input.targetRunId,
                fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                toProviderThreadId: input.toProviderThreadId,
                cause,
              }),
          ),
        );
      return {
        id: handoffId,
        transferId: null,
        threadId: input.threadId,
        targetRunId: input.targetRunId,
        fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
        toProviderThreadId: input.toProviderThreadId,
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "manual_context",
        status: "ready",
        summaryMessageId: null,
        summaryText: "Manual context handoff.",
        createdByProviderInstanceId: null,
        createdAt: now,
        updatedAt: now,
      } satisfies OrchestrationV2ContextHandoff;
    });

    const prepareForkDelta = Effect.fn("orchestrationV2.contextHandoff.prepareForkDelta")(
      function* (input: {
        readonly sourceThreadId: ThreadId;
        readonly targetThreadId: ThreadId;
        readonly targetRunId: RunId;
        readonly transferId: OrchestrationV2ContextHandoff["transferId"];
        readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
        readonly toProviderThreadId: ProviderThreadId;
        readonly fromProviderInstanceId: ProviderInstanceId;
        readonly toProviderInstanceId: ProviderInstanceId;
        readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
        readonly deltaItems: ReadonlyArray<OrchestrationV2TurnItem>;
        readonly createdAt: DateTime.Utc;
      }) {
        const handoffId = yield* idAllocator.allocate
          .contextHandoff({
            threadId: input.targetThreadId,
            fromProviderInstanceId: input.fromProviderInstanceId,
            toProviderInstanceId: input.toProviderInstanceId,
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new ContextHandoffPrepareError({
                  threadId: input.targetThreadId,
                  targetRunId: input.targetRunId,
                  fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                  toProviderThreadId: input.toProviderThreadId,
                  cause,
                }),
            ),
          );
        const coverage = handoffCoverage({
          threadId: input.sourceThreadId,
          coveredRunOrdinals: input.coveredRunOrdinals,
          items: input.deltaItems,
        });
        const selected = selectHistory({
          messages: input.deltaItems.flatMap((item) => {
            const message = handoffMessage(item);
            return message === null ? [] : [message];
          }),
          coverage,
          budget: tokenCap,
        });
        return {
          id: handoffId,
          transferId: input.transferId,
          threadId: input.targetThreadId,
          targetRunId: input.targetRunId,
          fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
          toProviderThreadId: input.toProviderThreadId,
          coveredRunOrdinals: input.coveredRunOrdinals,
          strategy: "fork_delta_summary",
          status: "ready",
          summaryMessageId: null,
          summaryText: makeForkDeltaSummary(input),
          history: {
            messages: selected.messages,
            coverage,
            omittedItems: selected.omittedItems,
            omittedItemIds: selected.omittedItemIds,
          },
          createdByProviderInstanceId: null,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        } satisfies OrchestrationV2ContextHandoff;
      },
    );

    const prepareProviderHandoff = Effect.fn(
      "orchestrationV2.contextHandoff.prepareProviderHandoff",
    )(function* (input: {
      readonly threadId: ThreadId;
      readonly targetRunId: RunId;
      readonly transferId: OrchestrationV2ContextHandoff["transferId"];
      readonly fromProviderThreadIds: ReadonlyArray<ProviderThreadId>;
      readonly toProviderThreadId: ProviderThreadId;
      readonly fromProviderInstanceId: ProviderInstanceId;
      readonly toProviderInstanceId: ProviderInstanceId;
      readonly coveredRunOrdinals: OrchestrationV2ContextHandoff["coveredRunOrdinals"];
      readonly runs?: ReadonlyArray<OrchestrationV2Run>;
      readonly strategy: Extract<
        OrchestrationV2ContextHandoff["strategy"],
        "delta_since_target_last_seen" | "full_thread_summary"
      >;
      readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
      readonly createdAt: DateTime.Utc;
    }) {
      const handoffId = yield* idAllocator.allocate
        .contextHandoff({
          threadId: input.threadId,
          fromProviderInstanceId: input.fromProviderInstanceId,
          toProviderInstanceId: input.toProviderInstanceId,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new ContextHandoffPrepareError({
                threadId: input.threadId,
                targetRunId: input.targetRunId,
                fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
                toProviderThreadId: input.toProviderThreadId,
                cause,
              }),
          ),
        );
      const runStatuses = new Map(input.runs?.map((run) => [run.id, run.status]));
      const coverage = handoffCoverage(input);
      const messages = input.items.flatMap((item) => {
        const message = handoffMessage(item);
        return message === null
          ? []
          : [
              {
                ...message,
                ...(item.runId === null ? {} : { runStatus: runStatuses.get(item.runId) }),
              },
            ];
      });
      const selected = selectHistory({ messages, coverage, budget: tokenCap });
      // The record agents read back keeps the smallest handoff's size; delivery uses `history`.
      const summary =
        tokenCap <= DEFAULT_HANDOFF_TOKEN_CAP
          ? selected
          : selectHistory({ messages, coverage, budget: DEFAULT_HANDOFF_TOKEN_CAP });
      return {
        id: handoffId,
        transferId: input.transferId,
        threadId: input.threadId,
        targetRunId: input.targetRunId,
        fromProviderThreadIds: Array.from(input.fromProviderThreadIds),
        toProviderThreadId: input.toProviderThreadId,
        coveredRunOrdinals: input.coveredRunOrdinals,
        strategy: input.strategy,
        status: "ready",
        summaryMessageId: null,
        summaryText: renderHistory(summary.messages, summary.context),
        history: {
          messages: selected.messages,
          coverage,
          omittedItems: selected.omittedItems,
          omittedItemIds: selected.omittedItemIds,
          ...workspaceOf(input.items),
        },
        createdByProviderInstanceId: null,
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      } satisfies OrchestrationV2ContextHandoff;
    });

    return ContextHandoffServiceV2.of({
      prepareLegacyImport,
      prepare,
      prepareForkDelta,
      prepareProviderHandoff,
    });
  },
);

export const layer: Layer.Layer<ContextHandoffServiceV2, never, IdAllocator.IdAllocatorV2> =
  Layer.effect(ContextHandoffServiceV2, makeContextHandoffService());
