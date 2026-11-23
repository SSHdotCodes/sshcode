import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";
import {
  isOrchestrationV2WorkActive,
  isProviderAvailable,
  type ModelSelection,
  type CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { latestExecutedRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { usageWindowsForModel } from "@t3tools/shared/accountBalance";
import { modelSelectionsEqual } from "@t3tools/shared/model";
import { isUsageWindowLimited } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { assertProviderInstanceEnabled } from "./ProviderInstancePolicy.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import { restartContinuationRun } from "./RestartContinuation.ts";
import { WORKSPACE_PREPARATION_INPUT } from "./workspacePreparation.ts";
import {
  EffectOutboxV2,
  pendingAccountMove,
  type PendingOrchestrationEffectV2,
} from "./EffectOutbox.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { ProviderSwitchServiceV2, type ProviderSwitchPlanV2 } from "./ProviderSwitchService.ts";
import { accountUnavailable } from "../provider/accountAvailability.ts";
import {
  cancelledRosterTaskWork,
  cancelledTurnItemWork,
  mergeRestartCancelledBackgroundWork,
  withDriverShellWake,
} from "./RestartBackgroundNote.ts";

export class AccountMoveUnavailableError extends Schema.TaggedError<AccountMoveUnavailableError>()(
  "AccountMoveUnavailableError",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

function destinationBlocker(provider: ServerProvider, model: string, now: number) {
  const name = provider.displayName ?? provider.instanceId;
  if (provider.auth.status === "unauthenticated") return `${name} is signed out.`;
  const refusal = accountUnavailable(provider, now, model);
  if (refusal !== undefined) return `${name}: ${refusal.reason}`;
  if (
    usageWindowsForModel(provider, model).some(
      (window) =>
        isUsageWindowLimited(window) &&
        (window.resetsAt === undefined || Date.parse(window.resetsAt) > now),
    )
  )
    return `${name}: Usage limit reached.`;
  if (
    !provider.enabled ||
    !provider.installed ||
    !isProviderAvailable(provider) ||
    provider.status === "error" ||
    provider.status === "disabled"
  )
    return provider.unavailableReason ?? provider.message ?? `${name} is unavailable.`;
  const update = provider.updateRequiredModels?.find((entry) => entry.slug === model);
  if (update)
    return formatProviderUpdateRequiredNotice({
      driver: provider.driver,
      updateRequiredModels: [update],
    });
  return provider.models.find((entry) => entry.slug === model || entry.aliases?.includes(model))
    ?.unavailableReason;
}

type MoveRecords = Pick<
  OrchestrationV2ThreadProjection,
  "runs" | "attempts" | "nodes" | "subagents" | "turnItems" | "providerThreads" | "checkpointScopes"
>;
type MoveEvent = {
  [K in OrchestrationV2DomainEvent["type"]]: Omit<
    Extract<OrchestrationV2DomainEvent, { type: K }>,
    "id"
  >;
}[OrchestrationV2DomainEvent["type"]];

/** A queued run, its attempt, its root and its checkpoint all start on the same native thread. */
function moveQueue(
  records: MoveRecords,
  queuedRuns: ReadonlyArray<OrchestrationV2Run>,
  previous: ModelSelection,
  target: ModelSelection,
  queueThreadId: NonNullable<OrchestrationV2Run["providerThreadId"]>,
  preserveQueuedOptions: boolean,
  /** A moved turn can no longer take a steer; a turn that stays where it is still can. */
  keepSteer: boolean,
  now: DateTime.Utc,
) {
  const events: MoveEvent[] = [];
  const base = {
    occurredAt: now,
    providerInstanceId: target.instanceId,
  };
  for (const run of queuedRuns) {
    const entry = { ...base, threadId: run.threadId, runId: run.id };
    const { steerWhenLiveRunId, ...queued } = run;
    events.push({
      ...entry,
      type: "run.updated",
      payload: {
        ...queued,
        ...(keepSteer && steerWhenLiveRunId !== undefined ? { steerWhenLiveRunId } : {}),
        // Options a message chose for itself survive an account change; the replaced
        // selection's own options do not.
        modelSelection:
          preserveQueuedOptions &&
          run.modelSelection.model === target.model &&
          !modelSelectionsEqual(run.modelSelection, previous)
            ? { ...run.modelSelection, instanceId: target.instanceId }
            : target,
        providerInstanceId: target.instanceId,
        providerThreadId: queueThreadId,
      },
    });
    const attempt = records.attempts.find((row) => row.id === run.activeAttemptId);
    if (attempt)
      events.push({
        ...entry,
        type: "run-attempt.updated",
        payload: {
          ...attempt,
          providerInstanceId: target.instanceId,
          providerThreadId: queueThreadId,
        },
      });
    const node = records.nodes.find((row) => row.id === run.rootNodeId);
    if (node && node.providerThreadId !== queueThreadId) {
      events.push({
        ...entry,
        type: "node.updated",
        payload: { ...node, providerThreadId: queueThreadId },
      });
      const scope = records.checkpointScopes.find((row) => row.id === node.checkpointScopeId);
      if (scope)
        events.push({
          ...entry,
          type: "checkpoint-scope.created",
          payload: { ...scope, providerThreadId: queueThreadId },
        });
    }
  }
  return events;
}

function cutBackgroundWork(records: MoveRecords, source: OrchestrationV2Run, now: DateTime.Utc) {
  const events: MoveEvent[] = [];
  const base = { threadId: source.threadId, occurredAt: now };
  const native = records.providerThreads.find((row) => row.id === source.providerThreadId);
  if (!native) return events;
  const nativeIds = new Set<string>();
  const work = records.turnItems.flatMap((item) => {
    if (
      (item.status !== "pending" && item.status !== "running" && item.status !== "waiting") ||
      (item.type === "subagent" && item.origin === "app_owned") ||
      (item.type === "command_execution" && item.input === WORKSPACE_PREPARATION_INPUT) ||
      (item.providerThreadId !== native.id && item.runId !== source.id)
    )
      return [];
    const cut = cancelledTurnItemWork(item);
    if (!cut) return [];
    if (item.nativeItemRef?.nativeId) nativeIds.add(item.nativeItemRef.nativeId);
    return [withDriverShellWake(cut, native.driver)];
  });
  for (const task of native.pendingBackgroundTasks ?? []) {
    if (!nativeIds.has(task.taskId))
      work.push(withDriverShellWake(cancelledRosterTaskWork(task), native.driver));
  }
  if (work.length)
    events.push({
      ...base,
      providerInstanceId: source.providerInstanceId,
      runId: source.id,
      type: "run.background-work-cancelled",
      payload: {
        runId: source.id,
        restartCancelledBackgroundWork: mergeRestartCancelledBackgroundWork(
          source.restartCancelledBackgroundWork ?? [],
          work,
        ),
      },
    });
  for (const task of records.subagents) {
    if (
      task.origin === "app_owned" &&
      task.runId === source.id &&
      task.completionWake === "settled_only" &&
      isOrchestrationV2WorkActive(task.status)
    )
      events.push({
        ...base,
        providerInstanceId: task.providerInstanceId,
        runId: source.id,
        nodeId: task.id,
        type: "subagent.updated",
        payload: { ...task, completionWake: "always", updatedAt: now },
      });
  }
  return events;
}

export const makeAccountMove = Effect.gen(function* () {
  const store = yield* ProjectionStoreV2;
  const settings = yield* ServerSettingsService;
  const registry = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
  const ids = yield* IdAllocator.IdAllocatorV2;
  const outbox = yield* EffectOutboxV2;
  const switches = yield* ProviderSwitchServiceV2;
  const adapters = yield* ProviderAdapterRegistryV2;
  const displayName = (instanceId: ModelSelection["instanceId"]) =>
    Option.isNone(registry)
      ? Effect.succeed(instanceId)
      : registry.value.getProviders.pipe(
          Effect.map(
            (providers) =>
              providers.find((p) => p.instanceId === instanceId)?.displayName ?? instanceId,
          ),
        );
  const prepare = Effect.fn("AccountMove.prepare")(function* (
    threadId: ThreadId,
    commandId: CommandId,
    target: ModelSelection,
    plan: ProviderSwitchPlanV2,
    now: DateTime.Utc,
  ) {
    const current = yield* store.getThreadRecords(threadId, ["runs"]);
    const latest = latestExecutedRun(current.runs);
    if (!latest) return;
    const pending = yield* pendingAccountMove(outbox, latest.id);
    const accountChange = plan.instanceChanged && plan.transition.type === "restart_and_resume";
    // Runs queued under the replaced selection follow the person's choice even when nothing moves.
    if (!pending && !accountChange && !current.runs.some((run) => run.status === "queued")) return;
    const readRecords = store.getThreadRecords(
      threadId,
      [
        "runs",
        "attempts",
        "nodes",
        "subagents",
        "providerThreads",
        "providerSessions",
        "providerTurns",
        "turnItems",
        "runtimeRequests",
        "checkpointScopes",
      ],
      {
        turnItemTypes: ["command_execution", "dynamic_tool", "subagent"],
        turnItemStatuses: ["pending", "running", "waiting"],
        liveNodesOnly: true,
      },
    );
    const movableSource = (records: Effect.Success<typeof readRecords>) => {
      const source = latestExecutedRun(records.runs);
      return source &&
        source.providerInstanceId === records.thread.providerInstanceId &&
        (["running", "starting", "preparing"].includes(source.status) ||
          // A finished turn ("waiting" is its checkpoint capture) moves only for awaited work.
          ((source.status === "waiting" || source.status === "completed") &&
            restartContinuationRun(records, now)?.id === source.id))
        ? source
        : undefined;
    };
    let records = yield* readRecords;
    let source = pending ? latest : accountChange ? movableSource(records) : undefined;
    let destination: ServerProvider | undefined;
    // An idle chat has nothing to move: do not wait on a quota refresh for it.
    if (source !== undefined) {
      // A bounded quota refresh can outlast the turn. Decide against its state after the probe.
      destination = Option.isNone(registry)
        ? undefined
        : (yield* registry.value.getProvidersForUsageLimits(target.instanceId)).find(
            (p) => p.instanceId === target.instanceId,
          );
      records = yield* readRecords;
      if (!pending) source = movableSource(records);
      // A Stop that already reached the turn wins: the selection applies to the next turn.
      if (
        !pending &&
        source !== undefined &&
        (yield* store.getThreadRecords(threadId, ["turnItems"], {
          turnItemTypes: ["run_interrupt_request"],
          turnItemRunIds: [source.id],
        })).turnItems.some((item) => item.type === "run_interrupt_request" && !item.forAccountMove)
      )
        source = undefined;
    }
    const moving = !pending && source !== undefined;
    const accountName = destination?.displayName ?? target.instanceId;
    if (moving || pending) {
      yield* assertProviderInstanceEnabled(yield* settings.getProviderPolicy.pipe(Effect.orDie), {
        projectId: records.thread.projectId,
        instanceId: target.instanceId,
      });
      const reason = destination
        ? destinationBlocker(destination, target.model, DateTime.toEpochMillis(now))
        : `${accountName} is unavailable.`;
      if (reason) return yield* new AccountMoveUnavailableError({ reason });
    }
    const queueSource = source ?? latest;
    const native = records.providerThreads.find((row) => row.id === queueSource.providerThreadId);
    if (!native) return;
    const previousSelection =
      moving && source !== undefined ? source.modelSelection : records.thread.modelSelection;
    const queued = records.runs.filter((run) => run.status === "queued");
    const following = queued.filter(
      (run) =>
        run.providerInstanceId === previousSelection.instanceId &&
        run.modelSelection.model === previousSelection.model &&
        !pending?.retainedQueueRunIds?.includes(run.id),
    );
    const events = moving && source !== undefined ? cutBackgroundWork(records, source, now) : [];
    if (following.length > 0) {
      // Subsequent selections may return to the source or leave its continuation group.
      const bindingPlan =
        native.providerInstanceId !== records.thread.providerInstanceId
          ? yield* switches.plan({
              projection: records,
              currentInstanceId: native.providerInstanceId,
              targetModelSelection: target,
            })
          : plan;
      const compatibleNative =
        native.providerInstanceId === target.instanceId ||
        (native.nativeThreadRef?.nativeId != null &&
          bindingPlan.transition.type === "restart_and_resume");
      const driver = compatibleNative
        ? native.driver
        : (yield* adapters.get(target.instanceId)).driver;
      const queueThreadId = compatibleNative
        ? native.id
        : (bindingPlan.targetProviderThreadId ??
          ids.derive.providerThread({
            driver,
            nativeThreadId: `account-move:${queueSource.id}:${target.instanceId}`,
          }));
      events.push(
        ...moveQueue(
          records,
          following,
          previousSelection,
          target,
          queueThreadId,
          !pending,
          !moving &&
            !pending &&
            previousSelection.instanceId === target.instanceId &&
            previousSelection.model === target.model,
          now,
        ),
      );
      if (!compatibleNative && bindingPlan.targetProviderThreadId === null) {
        events.unshift({
          type: "provider-thread.updated",
          threadId,
          providerInstanceId: target.instanceId,
          occurredAt: now,
          payload: {
            id: queueThreadId,
            driver,
            appThreadId: threadId,
            ownerNodeId: null,
            providerInstanceId: target.instanceId,
            providerSessionId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "not_loaded",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
    }
    // A move already in flight continues on this selection when its continuation is admitted.
    if (!moving || source === undefined) return { events, inFlight: pending !== undefined };
    const retained = queued.filter((run) => !following.includes(run));
    const continuation: PendingOrchestrationEffectV2 = {
      id: `effect:restart-continuation:${source.id}`,
      commandId,
      threadId,
      request: {
        type: "provider-runtime.continue",
        sourceRunId: source.id,
        accountMove: {
          modelSelection: target,
          accountName,
          ...(retained.length ? { retainedQueueRunIds: retained.map((run) => run.id) } : {}),
          settled: source.status === "waiting" || source.status === "completed",
        },
      },
    };
    return { events, inFlight: false, move: { source, continuation } };
  });
  return { prepare, displayName };
});
