/**
 * Puts a provider's failed runs on its snapshot (`ServerProvider.recentFailure`), so the
 * model picker, the composer and agent tools can see a usage limit or a failing provider
 * before the next run, not only inside the chat whose run failed. A failure saying the
 * model itself is gone is remembered for that model (see `unavailableModels.ts`).
 *
 * @module ProviderHealthReactor
 */
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  ProviderInstanceId,
  ServerProviderRecentFailure,
  ServerProvider,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import {
  classifyProviderFailure,
  isModelGoneFailure,
  providerAccountFailureReason,
} from "@t3tools/provider-core/server/failure";

import { usageLimitModelIds } from "@t3tools/shared/accountBalance";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "./Orchestrator.ts";

const MESSAGE_MAX_LENGTH = 500;

export interface ProviderHealthUpdate {
  readonly instanceId: ProviderInstanceId;
  /** `null` clears the instance's failure. */
  readonly failure: ServerProviderRecentFailure | null;
  readonly preserveOutOfCredit?: boolean;
}

function shortMessage(message: string): string {
  const text = message.trim().replace(/\s+/g, " ");
  return text.length <= MESSAGE_MAX_LENGTH ? text : `${text.slice(0, MESSAGE_MAX_LENGTH - 1)}…`;
}

/** Qwen Code reports the UTC month and day without a year. Use the event's nearest year. */
function yearlessQuotaReset(message: string, occurredAt: number): number | undefined {
  const reset = /\bquota will reset at (\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC\b/iu.exec(message);
  if (reset === null) return undefined;
  const { year } = DateTime.toPartsUtc(DateTime.makeUnsafe(occurredAt));
  let nearest: number | undefined;
  for (const candidateYear of [year, year - 1, year + 1]) {
    const iso = `${candidateYear}-${reset[1]}T${reset[2]}.000Z`;
    const time = Date.parse(iso);
    if (!Number.isFinite(time) || DateTime.formatIso(DateTime.makeUnsafe(time)) !== iso) continue;
    if (nearest === undefined || Math.abs(time - occurredAt) < Math.abs(nearest - occurredAt)) {
      nearest = time;
    }
  }
  return nearest;
}

/**
 * Model output clears account health; a completion also clears transient failures.
 * A failed account, usage-limit or provider error item marks it. Errors the
 * provider is still retrying, and failures outside the provider (workspace setup, a bad
 * request), say nothing.
 */
export function providerHealthUpdate(
  event: OrchestrationV2DomainEvent,
  context?: { readonly provider: ServerProvider; readonly model?: string | undefined },
): ProviderHealthUpdate | null {
  if (event.type === "run.updated") {
    return event.payload.status === "completed"
      ? { instanceId: event.payload.providerInstanceId, failure: null, preserveOutOfCredit: true }
      : null;
  }
  if (event.type !== "turn-item.updated") return null;
  if (
    event.providerInstanceId !== undefined &&
    event.payload.status !== "failed" &&
    (((event.payload.type === "assistant_message" || event.payload.type === "reasoning") &&
      event.payload.text.trim().length > 0) ||
      event.payload.type === "dynamic_tool" ||
      event.payload.type === "command_execution" ||
      event.payload.type === "file_search" ||
      event.payload.type === "web_search")
  )
    return { instanceId: event.providerInstanceId, failure: null };
  if (event.payload.type !== "error") return null;
  const item = event.payload;
  const instanceId = event.providerInstanceId;
  // A retry in progress stays "running"; it turns "failed" once the provider gives up.
  if (instanceId === undefined || item.status !== "failed") return null;
  const reportedKind = item.failure.class;
  const classified = classifyProviderFailure(item.failure.message, item.failure.code);
  const kind =
    reportedKind === "provider_error" && classified === "usage_limit" ? classified : reportedKind;
  if (kind === "transport_error" || kind === "validation_error" || kind === "unknown") return null;
  // A known reset keeps a quota error temporary. Bare 429/rate-limit failures
  // never imply exhausted credit. Reuse the adapters' account classifier.
  const outOfCredit =
    item.failure.resetAt == null &&
    kind !== "usage_limit" &&
    (kind === "billing_error" || classified === "billing_error");
  if (outOfCredit) {
    const message = shortMessage(item.failure.message);
    return {
      instanceId,
      failure: {
        kind: "billing_error",
        outOfCredit: true,
        message:
          message.length > 160 ? `${message.slice(0, 159)}…` : message || "Payment required.",
        occurredAt: DateTime.formatIso(event.occurredAt),
      },
    };
  }
  const accountReason = providerAccountFailureReason(kind);
  const message = accountReason ?? shortMessage(item.failure.message);
  if (message.length === 0) return null;
  const occurredAt = DateTime.toEpochMillis(event.occurredAt);
  // Billing/plan changes are infrequent; sign-in and permissions can be fixed
  // sooner. Expiry permits a new attempt, never promises the account recovered.
  const recheckMs =
    kind === "billing_error" || kind === "subscription_error"
      ? 6 * 60 * 60_000
      : accountReason
        ? 60 * 60_000
        : 5 * 60_000;
  const reportedReset = item.failure.resetAt
    ? Date.parse(item.failure.resetAt)
    : kind === "usage_limit"
      ? yearlessQuotaReset(item.failure.message, occurredAt)
      : undefined;
  const resetAt = DateTime.formatIso(
    DateTime.makeUnsafe(
      reportedReset !== undefined && reportedReset > occurredAt
        ? reportedReset
        : occurredAt + recheckMs,
    ),
  );
  let modelIds: ReadonlyArray<string> | undefined;
  if (kind === "usage_limit" && context) {
    // OpenCode's free allowance can run out while other routes on the instance still work.
    // Its error identifies the selected model, but does not enumerate the rest of the tier.
    if (context.provider.driver === "opencode" && item.failure.code === "provider.free-limit") {
      if (context.model === undefined) return null;
      modelIds = [context.model];
    } else {
      modelIds = usageLimitModelIds(
        context.provider,
        context.model,
        occurredAt,
        item.failure.usageLimitWindowIds,
      );
    }
  }
  return {
    instanceId,
    failure: {
      kind,
      message,
      occurredAt: DateTime.formatIso(event.occurredAt),
      resetAt,
      ...(modelIds === undefined ? {} : { modelIds }),
    },
  };
}

export interface ModelAvailabilityUpdate {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  /** The provider's words that the model is gone; `null` once a run on it completes. */
  readonly reason: string | null;
}

const MAX_TRACKED_RUNS = 500;

/**
 * Remembers each run's model (the latest few hundred runs) so a failed run whose
 * provider says the model is gone records that exact instance and model, and a
 * completed run clears it.
 */
export function makeModelAvailabilityTracker() {
  type RunModel = Pick<ModelAvailabilityUpdate, "instanceId" | "model">;
  const runs = new Map<string, RunModel | undefined>();
  const rememberRun = (runId: string, target: RunModel | undefined) => {
    runs.delete(runId);
    runs.set(runId, target);
    if (runs.size > MAX_TRACKED_RUNS) runs.delete(runs.keys().next().value!);
  };
  const remember = (
    run: Pick<OrchestrationV2Run, "id" | "providerInstanceId" | "modelSelection">,
  ) => {
    const target = { instanceId: run.providerInstanceId, model: run.modelSelection.model };
    rememberRun(run.id, target);
    return target;
  };
  const track = (event: OrchestrationV2DomainEvent): ModelAvailabilityUpdate | null => {
    if (event.type === "run.created" || event.type === "run.updated") {
      const target = remember(event.payload);
      return event.payload.status === "completed" ? { ...target, reason: null } : null;
    }
    if (
      event.type !== "turn-item.updated" ||
      event.payload.type !== "error" ||
      event.payload.status !== "failed"
    )
      return null;
    const runId = event.payload.runId ?? event.runId;
    const target = runId ? runs.get(runId) : undefined;
    if (!target || !isModelGoneFailure(event.payload.failure)) return null;
    return { ...target, reason: event.payload.failure.message };
  };
  return Object.assign(track, {
    /** The model of a run seen here, without a read: output arrives many times a second. */
    modelOf: (runId: string): string | undefined => runs.get(runId)?.model,
    remember,
    hasRun: (runId: string) => runs.has(runId),
    rememberMissing: (runId: string) => rememberRun(runId, undefined),
  });
}

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    const modelAvailability = makeModelAvailabilityTracker();
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        Effect.gen(function* () {
          let update = providerHealthUpdate(event);
          const availability = modelAvailability(event);
          yield* providers.recordModelHealthEvent(event);
          if (update !== null) {
            const instanceId = update.instanceId;
            const provider = (yield* providers.getProviders).find(
              (p) => p.instanceId === instanceId,
            );
            const runId =
              event.runId ?? (event.type === "turn-item.updated" ? event.payload.runId : undefined);
            let model =
              event.type === "run.updated"
                ? event.payload.modelSelection.model
                : runId === undefined || runId === null
                  ? undefined
                  : modelAvailability.modelOf(runId);
            // Only a limit being recorded is worth a read of the chat's runs, once per failed
            // run. Output never is: it streams, and a chat can hold thousands of runs. Output
            // of a run not seen here leaves a scoped limit standing until its reset.
            if (
              model === undefined &&
              update.failure?.kind === "usage_limit" &&
              runId !== undefined &&
              runId !== null &&
              !modelAvailability.hasRun(runId)
            ) {
              const records = yield* orchestrator.getThreadRecords(event.threadId, ["runs"]).pipe(
                Effect.catch(() =>
                  Effect.logWarning("Could not read the run for a provider usage limit", {
                    threadId: event.threadId,
                    runId,
                  }).pipe(Effect.as(undefined)),
                ),
              );
              const run = records?.runs.find((candidate) => candidate.id === runId);
              if (run !== undefined) model = modelAvailability.remember(run).model;
              else modelAvailability.rememberMissing(runId);
            }
            if (provider && update.failure?.kind === "usage_limit") {
              update = providerHealthUpdate(event, { provider, model });
            }
            // Output on an unrelated model does not clear a scoped limit.
            if (
              update !== null &&
              !(
                update.failure === null &&
                provider?.recentFailure?.modelIds !== undefined &&
                (model === undefined || !provider.recentFailure.modelIds.includes(model))
              )
            ) {
              yield* providers.setProviderRecentFailure(update);
            }
          }
          if (availability !== null) yield* providers.setModelUnavailable(availability);
        }),
      ).pipe(
        // Health is a hint for the next pick; losing it must never disturb the server.
        Effect.catchCause((cause) =>
          Effect.logWarning("Provider health tracking stopped", { cause }),
        ),
      ),
    );
  }),
);
