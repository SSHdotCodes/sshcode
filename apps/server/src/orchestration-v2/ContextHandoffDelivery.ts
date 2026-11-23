import type {
  OrchestrationV2ContextHandoff,
  OrchestrationV2HistoricalMessage,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { ContextHandoffBudgetError } from "@t3tools/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  historyCost,
  renderHandoffBrief,
  renderHistory,
  selectHistory,
} from "@t3tools/provider-core/server/handoffBudget";

type HandoffBrief = NonNullable<OrchestrationV2ContextHandoff["brief"]>;

/**
 * Persist before/after injection: an ambiguous pending delivery requires a fresh native thread.
 * Run `unsent` when the provider refused the turn before reading the prompt, so that
 * refusal does not leave an ambiguous marker behind.
 */
export const deliverContextHandoffs = Effect.fn("orchestrationV2.deliverContextHandoffs")(
  function* <InjectError = never, PersistError = never, BudgetError = never>(input: {
    readonly handoffs: ReadonlyArray<OrchestrationV2ContextHandoff>;
    readonly providerThread: OrchestrationV2ProviderThread;
    readonly budget: number | Effect.Effect<number, BudgetError>;
    readonly deferInline?: boolean;
    readonly alreadyDeliveredItemIds: ReadonlySet<string>;
    /**
     * The outgoing model's brief, newly written for this delivery. A brief recorded on a
     * pending handoff by an earlier attempt is used when this is absent.
     */
    readonly brief?: HandoffBrief | undefined;
    /** Workspace state, rendered; placed after the brief. */
    readonly workspace?: string | undefined;
    readonly inject?: (
      history: ProviderAdapter.ProviderAdapterV2HistoricalContext,
    ) => Effect.Effect<boolean, InjectError>;
    readonly persist: (handoff: OrchestrationV2ContextHandoff) => Effect.Effect<void, PersistError>;
  }) {
    const nativeThreadId = input.providerThread.nativeThreadRef?.nativeId ?? undefined;
    const pending = input.handoffs.filter(
      (handoff) =>
        nativeThreadId === undefined ||
        handoff.delivery?.nativeThreadId !== nativeThreadId ||
        handoff.delivery.status === "pending",
    );
    if (pending.length === 0 || (input.deferInline && input.inject === undefined))
      return { context: "", delivered: Effect.void, unsent: Effect.void, briefIncluded: false };
    const budget = typeof input.budget === "number" ? input.budget : yield* input.budget;
    let coverage = pending
      .map(
        (handoff) =>
          `Context handoff (${handoff.strategy === "fork_delta_summary" ? "merge_back / fork_delta_summary" : handoff.strategy}):\n${
            handoff.history?.coverage ??
            `From thread ${handoff.threadId}, runs ${handoff.coveredRunOrdinals.from}-${handoff.coveredRunOrdinals.to}. Recover history with t3_thread_read, view=activity, fromEnd=false; paginate with afterPosition=nextPosition, and use itemId/textOffset for long items.`
          }`,
      )
      .join("\n");
    // Repeated failures can accumulate many recovery markers. Keep a single
    // thread-level entry point when detailed coverage would crowd out history;
    // its activity includes the original handoff/fork source references.
    if (historyCost([], coverage) > Math.min(4_000, budget / 2)) {
      const strategies = Array.from(new Set(pending.map((handoff) => handoff.strategy)));
      coverage = `Context handoff (${strategies.join(", ")}). ${pending.length} handoff records; detailed coverage references omitted. Recover an omitted item only when the request needs it: find it with t3_thread_read({threadId:"${input.providerThread.appThreadId ?? pending[0]!.threadId}",view:"activity",query:"<words>"}), then read it by itemId, with textOffset=nextTextOffset until null. Follow fork/handoff source references in activity. Items included below need no read.`;
    }
    // Pending handoffs can carry the same item in different forms (an overlapping
    // full and delta handoff, or accumulated recovery markers). Keep it once, in
    // its fullest stored form, at its first position.
    const seen = new Set(input.alreadyDeliveredItemIds);
    const messages: Array<OrchestrationV2HistoricalMessage> = [];
    const positionByItemId = new Map<string, number>();
    for (const message of pending.flatMap((handoff) => handoff.history?.messages ?? [])) {
      if (seen.has(message.itemId)) {
        const position = positionByItemId.get(message.itemId);
        if (position !== undefined && message.text.length > messages[position]!.text.length)
          messages[position] = message;
        continue;
      }
      seen.add(message.itemId);
      positionByItemId.set(message.itemId, messages.length);
      messages.push(message);
    }
    // Old preview handoffs remain readable. Their preformatted context is included
    // as a whole when it fits, otherwise the coverage marker points to retrieval.
    const oldContext = pending
      .filter((handoff) => handoff.history === undefined)
      .map((handoff) => handoff.summaryText)
      .join("\n\n");
    const fullCoverage =
      oldContext && historyCost([], `${coverage}\n${oldContext}`) + 512 <= budget
        ? `${coverage}\n${oldContext}`
        : coverage;
    // The brief and the workspace come first and spend the same budget as the history. Each
    // is left out when it would take more than half of it: neither may fail a delivery.
    const brief = input.brief ?? pending.findLast((handoff) => handoff.brief)?.brief;
    const fits = (parts: ReadonlyArray<string>) =>
      historyCost([], [...parts, fullCoverage].join("\n\n")) <= budget / 2;
    const briefText = brief === undefined ? undefined : renderHandoffBrief(brief);
    const briefIncluded = briefText !== undefined && fits([briefText]);
    const prefaceParts = briefIncluded ? [briefText] : [];
    if (input.workspace && fits([...prefaceParts, input.workspace]))
      prefaceParts.push(input.workspace);
    const preface = prefaceParts.join("\n\n");
    // A brief is kept on the newest pending handoff, so a repeated delivery carries it again.
    const briefHolder = input.brief === undefined ? undefined : pending.at(-1);
    const withBrief = (handoff: OrchestrationV2ContextHandoff) =>
      input.brief === undefined || handoff !== briefHolder ? handoff : { ...handoff, brief };
    const selected = selectHistory({
      messages,
      coverage: preface.length === 0 ? fullCoverage : `${preface}\n\n${fullCoverage}`,
      omittedItems: pending.reduce((sum, handoff) => sum + (handoff.history?.omittedItems ?? 0), 0),
      budget,
    });
    if (historyCost(selected.messages, selected.context) > budget) {
      if (input.deferInline)
        return { context: "", delivered: Effect.void, unsent: Effect.void, briefIncluded: false };
      return yield* new ContextHandoffBudgetError();
    }
    const omittedItemIds = new Set(selected.omittedItemIds);
    const deliveredById = new Map(selected.messages.map((message) => [message.itemId, message]));
    const persist = (status: "pending" | "injected" | "inline") =>
      Effect.forEach(
        pending,
        (handoff) =>
          input.persist({
            ...withBrief(handoff),
            // The native context estimate counts a delivered item at the size in the
            // persisted history, so a settled delivery persists the form it sent,
            // which this second selection may have shortened beyond the stored one.
            // A pending (not yet accepted) delivery keeps the stored form, so an
            // ambiguous attempt does not destroy detail a later delivery could use.
            ...(status === "pending" || handoff.history === undefined
              ? {}
              : {
                  history: {
                    ...handoff.history,
                    messages: handoff.history.messages.map(
                      (message) => deliveredById.get(message.itemId) ?? message,
                    ),
                  },
                }),
            ...(nativeThreadId === undefined
              ? {}
              : {
                  delivery: {
                    nativeThreadId,
                    status,
                    omittedItemIds: [
                      ...(handoff.history?.omittedItemIds ?? []),
                      ...(handoff.history?.messages ?? [])
                        .filter((message) => omittedItemIds.has(message.itemId))
                        .map((message) => message.itemId),
                    ],
                    itemIds: selected.messages
                      .filter((message) =>
                        handoff.history?.messages.some(
                          (candidate) => candidate.itemId === message.itemId,
                        ),
                      )
                      .map((message) => message.itemId),
                  },
                }),
          }),
        { discard: true },
      );
    if (input.inject !== undefined && nativeThreadId !== undefined) {
      if (
        pending.some(
          (handoff) =>
            handoff.delivery?.nativeThreadId === nativeThreadId &&
            handoff.delivery.status === "pending",
        )
      ) {
        return yield* new ContextHandoffDeliveryUncertainError();
      }
      yield* persist("pending");
      const injected = yield* input.inject({
        messages: selected.messages,
        context: selected.context,
      });
      if (injected) {
        yield* persist("injected");
        return { context: "", delivered: Effect.void, unsent: Effect.void, briefIncluded };
      }
    } else {
      // Text-only delivery can also be accepted before a connection drops.
      yield* persist("pending");
    }
    if (input.deferInline) {
      // Compaction APIs cannot accept an inline transcript. Keep it available
      // for the next ordinary turn when native injection is unsupported.
      yield* Effect.forEach(pending, (handoff) => input.persist(withBrief(handoff)), {
        discard: true,
      });
      return { context: "", delivered: Effect.void, unsent: Effect.void, briefIncluded: false };
    }
    return {
      context: renderHistory(selected.messages, selected.context),
      delivered: persist("inline"),
      unsent: Effect.forEach(pending, (handoff) => input.persist(withBrief(handoff)), {
        discard: true,
      }),
      briefIncluded,
    };
  },
);

export class ContextHandoffDeliveryUncertainError extends Schema.TaggedError<ContextHandoffDeliveryUncertainError>()(
  "ContextHandoffDeliveryUncertainError",
  {},
) {
  override get message() {
    return "Historical context delivery is uncertain; replace the native thread before retrying.";
  }
}
