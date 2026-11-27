import { botsActive, holdBotRoutine } from "../bots/botsRuntime.ts";
import {
  CommandId,
  MessageId,
  ProjectId,
  ThreadId,
  PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
  ScheduledTask,
  ScheduledTaskError,
  ScheduledTaskId,
  ScheduledTaskWebhookDeliveryId,
  type ScheduledTaskListRunsInput,
  type ScheduledTaskListRunsResult,
  type ScheduledTaskRunRecord,
  type ScheduledTaskPreviewWebhookInput,
  type ScheduledTaskPreviewWebhookResult,
  type ScheduledTaskDeleteInput,
  type ScheduledTaskDeleteResult,
  type ScheduledTaskGetWebhookDeliveryInput,
  type ScheduledTaskGetWebhookDeliveryResult,
  type ScheduledTaskListWebhookDeliveriesInput,
  type ScheduledTaskListWebhookDeliveriesResult,
  type ScheduledTaskRotateWebhookTokenInput,
  type ScheduledTaskWebhookDeliveryOutcome,
  type ScheduledTaskListResult,
  type ScheduledTaskMutationResult,
  type ScheduledTaskRunNowInput,
  type ScheduledTaskRunNowResult,
  type ScheduledTaskSetEnabledInput,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Metric from "effect/Metric";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ScheduledTaskState from "./ScheduledTaskState.ts";
import * as ScheduledTaskShells from "./ScheduledTaskShells.ts";
import { isMissedFixedTimeRun, isSameSchedule, nextScheduledRunAt } from "./Schedule.ts";
import {
  redactHeaders,
  redactQuery,
  renderWebhookPrompt,
  previewWebhookPrompt,
  type WebhookRequest,
} from "./webhookTemplate.ts";
import { constantTimeEquals, verifyWebhookSignature } from "./webhookVerification.ts";

/** Path prefix of the environment route that receives webhook requests. */
import { withLocalTracing } from "@t3tools/shared/relayTracing";

export const WEBHOOK_ROUTE_PREFIX = "/api/hooks";
/** Deliveries kept per task; older ones are pruned on insert. */
const WEBHOOK_DELIVERY_RETENTION = 50;
const RUN_HISTORY_PER_TASK = 50;
const RUN_HISTORY_TOTAL = 1000;
/** Body text kept in the delivery log. Larger bodies are cut and flagged. */
const WEBHOOK_DELIVERY_LOG_BODY_LIMIT = 64 * 1024;
/** Rendered prompt text kept in the delivery log. */
const WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT = 64 * 1024;
/** Deliveries one task may hold at once, running or waiting their turn. */
const WEBHOOK_MAX_QUEUED_PER_TASK = 20;
/** Accepted deliveries per task per minute, enforced here as well as on the relay because the tunnel hostname is public too. */
const WEBHOOK_RATE_LIMIT_PER_MINUTE = 60;

/**
 * Where a webhook task's public URL points: `${relayHookBaseUrl}/${taskId}/${token}`.
 * Null when the environment has no managed tunnel on T3 Connect; clients then show the path.
 */
interface WebhookOrigin {
  readonly relayHookBaseUrl: string | null;
}

const ENDPOINT_KEY = /^[0-9a-f]{16}$/;

/**
 * The relay's hook URL prefix for this environment. The relay finds the
 * environment by its managed tunnel's key (the tunnel name's last segment),
 * so the URL never reveals the environment id.
 */
export function relayHookBaseUrl(input: {
  readonly relayUrl: string;
  readonly tunnelName: string | undefined;
}): string | null {
  const endpointKey = input.tunnelName?.split("-").at(-1);
  const relayUrl = input.relayUrl.replace(/\/+$/, "");
  if (relayUrl === "" || endpointKey === undefined || !ENDPOINT_KEY.test(endpointKey)) {
    return null;
  }
  return `${relayUrl}/v1/hooks/${endpointKey}`;
}

export class ScheduledTaskWebhookOrigin extends Context.Reference<Effect.Effect<WebhookOrigin>>(
  "t3/scheduledTasks/ScheduledTaskWebhookOrigin",
  {
    defaultValue: () => Effect.succeed({ relayHookBaseUrl: null }),
  },
) {}

/** A webhook delivery that cannot run; `reason` is shown in the delivery log. */
class WebhookDeliverySkipped extends Data.TaggedError("WebhookDeliverySkipped")<{
  readonly reason: string;
}> {}

interface RateWindow {
  readonly accepted: ReadonlyArray<number>;
  /** Whether a rejection was already logged in this window. */
  readonly rejectedLogged: boolean;
}

export interface WebhookTriggerRequest extends WebhookRequest {
  readonly hookId: string;
  readonly token: string;
  readonly body: Uint8Array;
  /** Set by T3 Connect; the same id is never dispatched twice. */
  readonly relayDeliveryId?: string;
  /** When the relay received a held request; defaults to now. */
  readonly receivedAt?: string;
}

/** What the HTTP route should answer. `not_found` covers unknown hooks and wrong tokens alike. */
/**
 * What happened to one webhook request, as recorded in metrics and spans.
 * Sent back to the relay as `x-t3-hook-outcome`; never request contents.
 */
export type WebhookDeliveryOutcome =
  | "accepted"
  | "duplicate"
  | "prompt_too_long"
  | "queue_full"
  | "rate_limited"
  | "disabled"
  | "rejected_signature"
  | "expired"
  | "not_found"
  | "error";

export type WebhookTriggerResult =
  | {
      readonly _tag: "accepted";
      readonly deliveryId: ScheduledTaskWebhookDeliveryId;
      /** A 202 covers more than a started run; this says which. */
      readonly outcome: "accepted" | "duplicate" | "prompt_too_long";
    }
  | { readonly _tag: "not_found" }
  | { readonly _tag: "rejected_signature" }
  | { readonly _tag: "disabled" }
  | {
      readonly _tag: "rate_limited";
      /** Too many requests to this hook, or too many runs already waiting. */
      readonly outcome: "rate_limited" | "queue_full";
    }
  | { readonly _tag: "expired" };

const decodeTask = Schema.decodeUnknownEffect(ScheduledTask);
const decodeTaskId = Schema.decodeUnknownOption(ScheduledTaskId);
const decodeScheduleJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.schedule),
);
const decodeWorkspaceStrategyJson = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ScheduledTask.fields.workspaceStrategy),
);
const decodeModelSelectionJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeModelSelection = Schema.decodeUnknownEffect(ScheduledTask.fields.modelSelection);
const decodeAccountPin = Schema.decodeUnknownEffect(
  Schema.Struct({ accountPinned: ScheduledTask.fields.accountPinned }),
);
const HeadersJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const MissingFieldsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeHeadersJson = Schema.decodeUnknownOption(HeadersJson);
const decodeMissingFieldsJson = Schema.decodeUnknownOption(MissingFieldsJson);
const encodeHeadersJson = Schema.encodeSync(HeadersJson);
const encodeMissingFieldsJson = Schema.encodeSync(MissingFieldsJson);

interface ScheduledTaskRow {
  readonly task_id: string;
  readonly title: string;
  readonly prompt: string;
  readonly enabled: number;
  readonly schedule_json: string;
  readonly project_id: string;
  readonly thread_id: string | null;
  readonly workspace_strategy_json: string;
  readonly model_selection_json: string;
  readonly runtime_mode: string;
  readonly interaction_mode: string;
  readonly created_by: string;
  readonly creation_source: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly next_run_at: string | null;
  readonly last_run_at: string | null;
  readonly last_run_status: string;
  readonly last_run_error: string | null;
  readonly run_count: number;
  readonly webhook_token: string | null;
  readonly webhook_secret: string | null;
}

interface WebhookDeliveryRow {
  readonly delivery_id: string;
  readonly task_id: string;
  readonly received_at: string;
  readonly method: string;
  readonly query: string;
  readonly headers_json: string;
  readonly body: string;
  readonly body_bytes: number;
  readonly body_truncated: number;
  readonly outcome: string;
  readonly signature_verified: number;
  readonly missing_fields_json: string;
  readonly rendered_prompt: string | null;
  readonly error: string | null;
}

export class ScheduledTaskService extends Context.Service<
  ScheduledTaskService,
  {
    readonly list: () => Effect.Effect<ScheduledTaskListResult, ScheduledTaskError>;
    readonly listRuns: (
      input: ScheduledTaskListRunsInput,
    ) => Effect.Effect<ScheduledTaskListRunsResult, ScheduledTaskError>;
    readonly previewWebhook: (
      input: ScheduledTaskPreviewWebhookInput,
    ) => Effect.Effect<ScheduledTaskPreviewWebhookResult, ScheduledTaskError>;
    /** Emits the full task list on subscribe and again after every change (CRUD, run transitions, reschedules). */
    readonly subscribeList: () => Stream.Stream<ScheduledTaskListResult, ScheduledTaskError>;
    readonly upsert: (
      input: ScheduledTaskUpsertInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    /** Partial update flipping only the enabled flag; never touches other fields. */
    readonly setEnabled: (
      input: ScheduledTaskSetEnabledInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly delete: (
      input: ScheduledTaskDeleteInput,
    ) => Effect.Effect<ScheduledTaskDeleteResult, ScheduledTaskError>;
    readonly runNow: (
      input: ScheduledTaskRunNowInput,
    ) => Effect.Effect<ScheduledTaskRunNowResult, ScheduledTaskError>;
    /** Issues a new URL token for a webhook task; the old URL stops working at once. */
    readonly rotateWebhookToken: (
      input: ScheduledTaskRotateWebhookTokenInput,
    ) => Effect.Effect<ScheduledTaskMutationResult, ScheduledTaskError>;
    readonly listWebhookDeliveries: (
      input: ScheduledTaskListWebhookDeliveriesInput,
    ) => Effect.Effect<ScheduledTaskListWebhookDeliveriesResult, ScheduledTaskError>;
    readonly getWebhookDelivery: (
      input: ScheduledTaskGetWebhookDeliveryInput,
    ) => Effect.Effect<ScheduledTaskGetWebhookDeliveryResult, ScheduledTaskError>;
    /**
     * Verifies, logs and dispatches one webhook request. Returns as soon as the
     * delivery is logged; the run itself continues in the background so senders
     * with short timeouts get their answer immediately.
     */
    readonly triggerWebhook: (
      request: WebhookTriggerRequest,
    ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>;
  }
>()("t3/scheduledTasks/ScheduledTaskService") {}

function taskError(message: string, input?: { taskId?: ScheduledTaskId; cause?: unknown }) {
  return new ScheduledTaskError({
    message,
    ...(input?.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input?.cause === undefined ? {} : { cause: input.cause }),
  });
}

function iso(value: DateTime.DateTime): string {
  return DateTime.formatIso(DateTime.toUtc(value));
}

const localNow = DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone);

function nextRunAt(
  task: Pick<ScheduledTask, "enabled" | "schedule">,
  from: DateTime.DateTime,
): string | null {
  if (!task.enabled) return null;
  // A stored interval can decode yet overflow the representable DateTime
  // range; an unrepresentable occurrence means the task has no next run.
  try {
    const next = nextScheduledRunAt(task.schedule, from);
    return next !== null && Number.isFinite(DateTime.toEpochMillis(next)) ? iso(next) : null;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (Cause.isCause(error)) return Cause.pretty(error);
  if (error instanceof Error) return error.message;
  return String(error);
}

const isThreadNotFound = Schema.is(ThreadManagementService.ThreadManagementThreadNotFoundError);
const isThreadProjectionLoadError = Schema.is(
  ThreadManagementService.ThreadManagementProjectionLoadError,
);
const isOrchestratorProjectionError = Schema.is(Orchestrator.OrchestratorProjectionError);
const isProjectionThreadNotFound = Schema.is(ProjectionStore.ProjectionStoreThreadNotFoundError);

function missingThreadReason(failure: unknown): string | null {
  if (isThreadNotFound(failure)) {
    return failure.message;
  }
  // A deleted thread can still have a tombstone. A missing projection is also terminal.
  const projectionError = isThreadProjectionLoadError(failure) ? failure.cause : failure;
  if (
    isOrchestratorProjectionError(projectionError) &&
    isProjectionThreadNotFound(projectionError.cause)
  ) {
    return projectionError.cause.message;
  }
  return null;
}

function webhookPath(taskId: string, token: string): string {
  return `${WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(taskId)}/${token}`;
}

function webhookEndpoint(
  row: Pick<ScheduledTaskRow, "task_id" | "webhook_token" | "webhook_secret">,
  origin: WebhookOrigin | null,
): ScheduledTask["webhook"] {
  if (row.webhook_token === null) return undefined;
  const base = origin?.relayHookBaseUrl ?? null;
  return {
    path: webhookPath(row.task_id, row.webhook_token),
    url: base === null ? null : `${base}/${encodeURIComponent(row.task_id)}/${row.webhook_token}`,
    hasSecret: row.webhook_secret !== null,
  };
}

const decodeRow = (row: ScheduledTaskRow, origin: WebhookOrigin | null = null) =>
  Effect.gen(function* () {
    const schedule = yield* decodeScheduleJson(row.schedule_json);
    const webhook = schedule.type === "webhook" ? webhookEndpoint(row, origin) : undefined;
    const workspaceStrategy = yield* decodeWorkspaceStrategyJson(row.workspace_strategy_json);
    const storedSelection = yield* decodeModelSelectionJson(row.model_selection_json);
    const modelSelection = yield* decodeModelSelection(storedSelection);
    const { accountPinned } = yield* decodeAccountPin(storedSelection);
    return yield* decodeTask({
      // The stored id decodes through the task schema so a corrupt value fails
      // as a typed parse error, not a `ScheduledTaskId.make` defect.
      id: row.task_id,
      title: row.title,
      prompt: row.prompt,
      enabled: row.enabled === 1,
      schedule,
      projectId: row.project_id,
      threadId: row.thread_id,
      workspaceStrategy,
      modelSelection,
      ...(accountPinned === true ? { accountPinned: true } : {}),
      runtimeMode: row.runtime_mode,
      interactionMode: row.interaction_mode,
      createdBy: row.created_by,
      creationSource: row.creation_source,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastRunStatus: row.last_run_status,
      lastRunError: row.last_run_error,
      runCount: row.run_count,
      ...(webhook === undefined ? {} : { webhook }),
    });
  }).pipe(
    Effect.mapError((cause) => {
      // The typed diagnostic can only carry an id that itself decodes; a
      // corrupt stored id is omitted rather than re-thrown as a defect.
      const taskId = decodeTaskId(row.task_id);
      return taskError("Could not decode schedule task row.", {
        ...(Option.isSome(taskId) ? { taskId: taskId.value } : {}),
        cause,
      });
    }),
  );

/** Select poll candidates before decoding their schedules or other JSON payloads. */
export const listDueTasks = Effect.fn("ScheduledTaskService.listDueTasks")(function* (
  now: DateTime.DateTime,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<ScheduledTaskRow>`
    SELECT * FROM scheduled_tasks
    WHERE enabled = 1 AND next_run_at IS NOT NULL
      AND next_run_at <= ${iso(now)} AND last_run_status <> 'running'
    ORDER BY next_run_at ASC, task_id ASC
  `.pipe(NodeSqliteClient.readOnly);
  const tasks: ScheduledTask[] = [];
  for (const row of rows) {
    const decoded = yield* Effect.result(decodeRow(row));
    if (Result.isSuccess(decoded)) {
      const task = decoded.success;
      // next_run_at is a freeform string at the schema level; a stored value
      // that cannot parse as a DateTime would defect the poll below, so the
      // row is skipped here like any other corrupt row.
      if (task.nextRunAt === null || Option.isSome(DateTime.make(task.nextRunAt))) {
        tasks.push(task);
      } else {
        yield* Effect.logWarning("Skipping schedule task row with invalid next_run_at", {
          taskId: row.task_id,
        });
      }
    } else {
      yield* Effect.logWarning("Skipping undecodable schedule task row", {
        taskId: row.task_id,
        cause: decoded.failure,
      });
    }
  }
  return tasks;
});

export const layer = Layer.effect(
  ScheduledTaskService,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const crypto = yield* Crypto.Crypto;
    const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
    const threadManagement = yield* ThreadManagementService.ThreadManagementService;
    const secretRequests = yield* SecretRequests.SecretRequests;
    const scheduler = yield* Scheduler.Scheduler;
    const readWebhookOrigin = yield* ScheduledTaskWebhookOrigin;
    const durableState = yield* ScheduledTaskState.ScheduledTaskState;
    const acceptanceLock = yield* Semaphore.make(1);
    // A folder that is not a Git repository, No project included, cannot hold a worktree.
    const runnableWorkspaceStrategy = (
      projectId: ProjectId,
      strategy: ScheduledTask["workspaceStrategy"],
    ) =>
      strategy.type !== "worktree"
        ? Effect.succeed(strategy)
        : threadLaunch
            .isNonGitProject(projectId)
            .pipe(
              Effect.map((nonGit): ScheduledTask["workspaceStrategy"] =>
                nonGit ? { type: "root" } : strategy,
              ),
            );
    const delivering = new Set<string>();
    // Webhook deliveries for one task dispatch in arrival order rather than
    // being dropped while an earlier delivery is still dispatching.
    const webhookPermits = yield* Ref.make<ReadonlyMap<ScheduledTaskId, Semaphore.Semaphore>>(
      new Map(),
    );
    const webhookRateWindows = yield* Ref.make<ReadonlyMap<ScheduledTaskId, RateWindow>>(new Map());
    const activeRuns = yield* Ref.make<ReadonlySet<ScheduledTaskId>>(new Set());
    // Sliding(1) coalesces the dirty-signal: every notification triggers a
    // full list() re-emit anyway, so a slow subscriber only ever needs the
    // latest signal — an unbounded backlog would just grow memory.
    const changesPubSub = yield* PubSub.sliding<void>(1);
    const shellSchedules = yield* Effect.serviceOption(ScheduledTaskShells.ScheduledTaskShells);
    const notifyChanged = Effect.gen(function* () {
      if (Option.isSome(shellSchedules)) yield* shellSchedules.value.refresh;
      yield* PubSub.publish(changesPubSub, undefined);
    });

    const selectAllRows = () => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count,
        webhook_token,
        webhook_secret
      FROM scheduled_tasks
      ORDER BY updated_at DESC, task_id ASC
    `;

    // Strict decode for the API surface: a corrupt row is a visible error.
    const listRows = Effect.fn("ScheduledTaskService.listRows")(function* () {
      const rows = yield* selectAllRows();
      const origin = yield* readWebhookOrigin;
      return yield* Effect.forEach(rows, (row) => decodeRow(row, origin), { concurrency: 1 });
    });

    const getRows = (id: ScheduledTaskId) => sql<ScheduledTaskRow>`
      SELECT
        task_id,
        title,
        prompt,
        enabled,
        schedule_json,
        project_id,
        thread_id,
        workspace_strategy_json,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        created_by,
        creation_source,
        created_at,
        updated_at,
        next_run_at,
        last_run_at,
        last_run_status,
        last_run_error,
        run_count,
        webhook_token,
        webhook_secret
      FROM scheduled_tasks
      WHERE task_id = ${id}
    `;

    /** Load a task, returning `null` when it does not exist; real load/decode failures propagate. */
    const findTask = Effect.fn("ScheduledTaskService.findTask")(function* (id: ScheduledTaskId) {
      const rows = yield* getRows(id).pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );
      const row = rows[0];
      if (row === undefined) return null;
      return yield* decodeRow(row, yield* readWebhookOrigin);
    });

    // A pause clears next_run_at too. Only the receipt for this occurrence proves it ran.
    const completedOnce = Effect.fnUntraced(function* (task: ScheduledTask) {
      if (task.schedule.type !== "once" || task.nextRunAt !== null || task.runCount === 0)
        return false;
      const runAt = iso(DateTime.makeUnsafe(task.schedule.runAt));
      const [row] = yield* sql<{ tracked: number; counted: number }>`
        SELECT json_type(schedule_json, '$.countedOnceRuns') IS NOT NULL AS tracked,
               json_type(schedule_json, ${`$.countedOnceRuns."${runAt}"`}) IS NOT NULL AS counted
        FROM scheduled_tasks WHERE task_id = ${task.id}
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: task.id, cause }),
        ),
      );
      if (row?.tracked) return Boolean(row.counted);
      // Older rows predate receipts. Their retained history identifies the occurrence.
      const history = (yield* durableState.read).runs.filter((run) => run.taskId === task.id);
      return (
        history.length === 0 ||
        history.some(
          (run) =>
            run.id === `scheduled-task:${task.id}:once:${runAt}` &&
            (run.dispatchStatus === "dispatched" || run.dispatchStatus === "failed"),
        )
      );
    });

    const findWebhookCredentials = (id: ScheduledTaskId) =>
      getRows(id).pipe(
        Effect.map((rows) =>
          rows[0] === undefined
            ? null
            : { token: rows[0].webhook_token, secret: rows[0].webhook_secret },
        ),
        Effect.mapError((cause) =>
          taskError("Could not load schedule task.", { taskId: id, cause }),
        ),
      );

    const newWebhookToken = crypto.randomBytes(32).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.mapError((cause) => taskError("Could not generate webhook token.", { cause })),
    );

    const loadTask = Effect.fn("ScheduledTaskService.loadTask")(function* (id: ScheduledTaskId) {
      const task = yield* findTask(id);
      if (task === null) {
        return yield* taskError("Schedule task not found.", { taskId: id });
      }
      return task;
    });

    // Run-state columns (last_run_*, run_count) are intentionally absent from
    // the conflict clause: they are owned by the run transitions below, and a
    // concurrent settings save must not overwrite an in-flight increment.
    // Check existence in the write itself so an edit cannot undo a deletion
    // that landed after upsert loaded the previous task.
    const saveTask = (
      task: ScheduledTask,
      requireExisting: boolean,
      newOnceOccurrence: boolean,
      webhook: {
        readonly token: string | null;
        readonly secret: string | null;
        /** False when the save carried no new secret, so a concurrent change survives. */
        readonly secretChanged: boolean;
      },
    ) =>
      sql<{ task_id: string }>`
        INSERT INTO scheduled_tasks (
          task_id,
          title,
          prompt,
          enabled,
          schedule_json,
          project_id,
          thread_id,
          workspace_strategy_json,
          model_selection_json,
          runtime_mode,
          interaction_mode,
          created_by,
          creation_source,
          created_at,
          updated_at,
          next_run_at,
          last_run_at,
          last_run_status,
          last_run_error,
          run_count,
          webhook_token,
          webhook_secret
        )
        SELECT
          ${task.id},
          ${task.title},
          ${task.prompt},
          ${task.enabled ? 1 : 0},
          ${JSON.stringify(newOnceOccurrence ? { ...task.schedule, countedOnceRuns: {} } : task.schedule)},
          ${task.projectId},
          ${task.threadId},
          ${JSON.stringify(task.workspaceStrategy)},
          ${JSON.stringify(task.accountPinned ? { ...task.modelSelection, accountPinned: true } : task.modelSelection)},
          ${task.runtimeMode},
          ${task.interactionMode},
          ${task.createdBy},
          ${task.creationSource},
          ${task.createdAt},
          ${task.updatedAt},
          ${task.nextRunAt},
          ${task.lastRunAt},
          ${task.lastRunStatus},
          ${task.lastRunError},
          ${task.runCount},
          ${webhook.token},
          ${webhook.secret}
        WHERE ${requireExisting ? 0 : 1} = 1
           OR EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${task.id})
        ON CONFLICT (task_id)
        DO UPDATE SET
          title = excluded.title,
          prompt = excluded.prompt,
          enabled = excluded.enabled,
          schedule_json = CASE
            WHEN json_type(scheduled_tasks.schedule_json, '$.countedOnceRuns') IS NULL
            THEN excluded.schedule_json
            ELSE json_set(excluded.schedule_json, '$.countedOnceRuns',
                          json_extract(scheduled_tasks.schedule_json, '$.countedOnceRuns'))
          END,
          project_id = excluded.project_id,
          thread_id = excluded.thread_id,
          workspace_strategy_json = excluded.workspace_strategy_json,
          model_selection_json = excluded.model_selection_json,
          runtime_mode = excluded.runtime_mode,
          interaction_mode = excluded.interaction_mode,
          creation_source = excluded.creation_source,
          updated_at = excluded.updated_at,
          next_run_at = excluded.next_run_at,
          -- Only rotate changes a live token, so a save racing a rotation
          -- cannot bring the old URL back.
          webhook_token = CASE
            WHEN excluded.webhook_token IS NULL THEN NULL
            ELSE COALESCE(scheduled_tasks.webhook_token, excluded.webhook_token)
          END,
          webhook_secret = CASE
            WHEN ${webhook.secretChanged ? 1 : 0} = 1 THEN excluded.webhook_secret
            ELSE scheduled_tasks.webhook_secret
          END
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not save schedule task.", { taskId: task.id, cause }),
        ),
        Effect.flatMap((rows) =>
          rows.length > 0
            ? Effect.void
            : taskError("Schedule task not found.", { taskId: task.id }),
        ),
      );

    const deleteRow = (id: ScheduledTaskId) =>
      sql
        .withTransaction(
          sql`DELETE FROM scheduled_task_webhook_deliveries WHERE task_id = ${id}`.pipe(
            Effect.andThen(sql`DELETE FROM scheduled_tasks WHERE task_id = ${id}`),
          ),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not delete schedule task.", { taskId: id, cause }),
          ),
        );

    // Run-state transitions use targeted UPDATEs (never the full-row upsert) so
    // a completing run cannot resurrect a deleted task or clobber concurrent
    // edits to the task definition.
    const markRunning = (id: ScheduledTaskId, startedAtIso: string) =>
      sql<{ task_id: string }>`
        UPDATE scheduled_tasks
        SET updated_at = ${startedAtIso},
            last_run_at = ${startedAtIso},
            last_run_status = 'running',
            last_run_error = NULL
        WHERE task_id = ${id}
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not mark schedule task as running.", { taskId: id, cause }),
        ),
        // A task deleted after the re-read must not be dispatched from the stale snapshot.
        Effect.flatMap((rows) =>
          rows.length > 0 ? Effect.void : taskError("Schedule task not found.", { taskId: id }),
        ),
      );

    const markCompleted = (input: {
      readonly id: ScheduledTaskId;
      readonly completedAtIso: string;
      readonly nextRunAtIso: string | null;
      readonly status: "succeeded" | "failed";
      readonly error: string | null;
      readonly startedAtIso: string;
      readonly onceRunAt: string | null;
      readonly legacyReplay: boolean;
    }) => {
      // Commit the occurrence receipt and its count together, independent of the run history.
      const receiptPath =
        input.onceRunAt === null ? null : `$.countedOnceRuns."${input.onceRunAt}"`;
      return sql<{ run_count: number }>`
        UPDATE scheduled_tasks
        SET updated_at = ${input.completedAtIso},
            next_run_at = ${input.nextRunAtIso},
            last_run_status = ${input.status},
            last_run_error = ${input.error},
            run_count = run_count + CASE
              WHEN run_count > 0 AND ${receiptPath} IS NOT NULL AND (
                json_type(schedule_json, ${receiptPath}) IS NOT NULL OR
                (json_type(schedule_json, '$.countedOnceRuns') IS NULL AND ${input.legacyReplay ? 1 : 0} = 1)
              ) THEN 0
              ELSE 1
            END,
            schedule_json = CASE
              WHEN ${receiptPath} IS NULL THEN schedule_json
              ELSE json_set(schedule_json, ${receiptPath}, 1)
            END
        WHERE task_id = ${input.id}
          AND last_run_status = 'running'
          AND last_run_at = ${input.startedAtIso}
        RETURNING run_count
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not record schedule task run.", { taskId: input.id, cause }),
        ),
      );
    };

    // Best-effort escape hatch: if anything fails between markRunning and
    // markCompleted, write a full terminal record so runDueTasks neither skips
    // the task forever (it filters out 'running' rows) nor re-fires it
    // immediately for recurring work. One-shot messages instead retry their
    // stable dispatch identity, which can safely replay an accepted command.
    const releaseStuckRun = (task: ScheduledTask, message: string) =>
      Effect.gen(function* () {
        const now = yield* localNow;
        // Compute the next occurrence from the current row so a schedule
        // edited while the run was in flight is honoured; fall back to the
        // run's snapshot only if the re-read itself fails.
        const reread = yield* Effect.result(findTask(task.id));
        if (Result.isSuccess(reread) && reread.success === null) return; // deleted — nothing to release
        const source = Result.isSuccess(reread) && reread.success !== null ? reread.success : task;
        yield* sql`
          UPDATE scheduled_tasks
          SET last_run_status = 'failed',
              last_run_error = ${message},
              next_run_at = ${nextRunAt(source, now)},
              updated_at = ${iso(now)},
              run_count = run_count + ${task.schedule.type === "once" ? 0 : 1}
          WHERE task_id = ${task.id} AND last_run_status = 'running'
        `;
        yield* notifyChanged;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not release stuck schedule task run", {
            taskId: task.id,
            cause,
          }),
        ),
      );

    const saveRun = (record: ScheduledTaskRunRecord) =>
      durableState
        .update((state) => {
          const previous = state.runs.find((run) => run.id === record.id);
          const updated = { ...record, scheduledAt: previous?.scheduledAt ?? record.scheduledAt };
          const runs = [updated, ...state.runs.filter((run) => run.id !== record.id)];
          const counts = new Map<string, number>();
          return {
            ...state,
            runs: runs
              .filter((run) => {
                const count = (counts.get(run.taskId) ?? 0) + 1;
                counts.set(run.taskId, count);
                return count <= RUN_HISTORY_PER_TASK;
              })
              .slice(0, RUN_HISTORY_TOTAL),
          };
        })
        .pipe(Effect.asVoid);

    const hasQueuedOccurrence = Effect.fn("ScheduledTaskService.hasQueuedOccurrence")(function* (
      taskId: ScheduledTaskId,
      threadId: ThreadId,
    ) {
      const { runs } = yield* threadManagement.getThreadRecords(threadId, ["runs"]);
      const messageIds = runs
        .filter((run) => run.status === "queued")
        .map((run) => run.userMessageId);
      if (messageIds.length === 0) return false;
      const { messages } = yield* threadManagement.getThreadRecords(threadId, ["messages"], {
        messageIds,
      });
      return messages.some((message) => message.scheduledTaskId === taskId);
    });

    const runTask = Effect.fn("ScheduledTaskService.runTask")(function* (
      task: ScheduledTask,
      trigger: "scheduled" | "manual" | "webhook",
      webhook?: {
        readonly deliveryId: string;
        readonly prompt: string;
        readonly receivedAt: string;
      },
    ) {
      const run = Effect.gen(function* () {
        const startedAt = yield* localNow;
        const startedAtIso = iso(startedAt);

        // The in-memory snapshot may be stale: re-read before touching run
        // state. The task may have been deleted, paused, or postponed since
        // the poll loaded it — none of those may fire.
        const active = yield* findTask(task.id);
        if (active === null) {
          if (webhook !== undefined) {
            return yield* new WebhookDeliverySkipped({
              reason: "The task was deleted before this delivery ran.",
            });
          }
          // A manual run on a just-deleted task must fail loudly, not report
          // a successful run that never dispatched.
          if (trigger !== "scheduled") {
            return yield* taskError("Schedule task not found.", { taskId: task.id });
          }
          return task;
        }
        // A next_run_at corrupted between the poll read and this re-read must
        // not defect the poll; an unparseable value is treated as not due.
        const parsedNextRunAt =
          active.nextRunAt === null ? Option.none() : DateTime.make(active.nextRunAt);
        if (
          trigger === "scheduled" &&
          (!active.enabled ||
            Option.isNone(parsedNextRunAt) ||
            DateTime.toEpochMillis(parsedNextRunAt.value) > DateTime.toEpochMillis(startedAt))
        ) {
          return active;
        }
        // A busy chat keeps one occurrence; skipped intervals are never replayed.
        if (
          trigger === "scheduled" &&
          active.schedule.type !== "once" &&
          active.threadId !== null &&
          (yield* hasQueuedOccurrence(active.id, ThreadId.make(active.threadId)).pipe(
            Effect.orElseSucceed(() => false),
          ))
        ) {
          yield* rescheduleMissedRun(active, startedAt, "The previous occurrence is still queued.");
          return active;
        }
        // A queued delivery must not run a task that was paused, deleted and
        // recreated under the same id, or switched to another trigger while
        // it waited for its turn.
        if (webhook !== undefined) {
          const reason =
            active.createdAt !== task.createdAt
              ? "The task was replaced before this delivery ran."
              : active.schedule.type !== "webhook"
                ? "The task's trigger changed before this delivery ran."
                : !active.enabled
                  ? "The task was paused before this delivery ran."
                  : null;
          if (reason !== null) return yield* new WebhookDeliverySkipped({ reason });
        }

        // A webhook run is keyed by its delivery so the same delivery can
        // never dispatch twice.
        const onceRunAt =
          active.schedule.type === "once" ? iso(DateTime.makeUnsafe(active.schedule.runAt)) : null;
        const fireKey =
          webhook === undefined
            ? onceRunAt !== null
              ? // Stable across a crash between dispatch and recording completion.
                // The orchestrator's durable command receipt makes recovery a replay.
                `${active.id}:once:${onceRunAt}`
              : trigger === "manual"
                ? `${active.id}:manual:${yield* crypto.randomUUIDv4().pipe(Effect.mapError((cause) => taskError("Could not generate run id.", { cause })))}`
                : `${active.id}:${active.nextRunAt}:${trigger}`
            : `${active.id}:webhook:${webhook.deliveryId}`;
        const commandId = CommandId.make(`scheduled-task:${fireKey}`);
        const messageId = MessageId.make(`scheduled-task-message:${fireKey}`);
        // Older tasks recorded an occurrence in history and cleared its next run on completion.
        const legacyReplay =
          onceRunAt !== null &&
          active.nextRunAt === null &&
          active.runCount > 0 &&
          (active.lastRunStatus === "succeeded" || active.lastRunStatus === "failed") &&
          (yield* durableState.read).runs.some(
            (run) =>
              run.id === commandId &&
              (run.dispatchStatus === "dispatched" || run.dispatchStatus === "failed"),
          );
        // Dispatch from the fresh row so prompt/model/binding edits made
        // after the poll read are honoured. A webhook prompt was rendered
        // from the row when the request arrived.
        const prompt = webhook?.prompt ?? active.prompt;
        const occurrence: ScheduledTaskRunRecord = {
          id: commandId,
          taskId: active.id,
          projectId: active.projectId,
          scheduledAt:
            trigger === "scheduled"
              ? (active.nextRunAt ?? startedAtIso)
              : (webhook?.receivedAt ?? startedAtIso),
          trigger,
          dispatchStatus: "dispatching",
          dispatchedAt: null,
          error: null,
          threadId: active.threadId,
          messageId,
          runId: null,
          runStatus: null,
          finishedAt: null,
        };
        yield* saveRun(occurrence);
        yield* markRunning(active.id, startedAtIso);
        yield* notifyChanged;

        // Effect.exit (not Effect.result) so defects and interruptions in the
        // dispatch are also captured and recorded as a failed run instead of
        // aborting before markCompleted.
        const result = yield* Effect.exit(
          Effect.gen(function* () {
            const targetThreadId = active.threadId;
            const draftTarget =
              active.schedule.type === "once" &&
              active.schedule.prepareWorkspace === true &&
              targetThreadId !== null;
            // Launch uses this suffix for its initial message. Keep it even when a
            // manual send wins the draft, so recovery never changes message identity.
            const deliveryCommandId = draftTarget
              ? CommandId.make(`${commandId}:initial-message`)
              : commandId;
            const sendToTarget = () =>
              targetThreadId === null
                ? Effect.fail(
                    taskError("Schedule task has no target thread.", { taskId: active.id }),
                  )
                : threadManagement.sendToThread({
                    projectId: active.projectId,
                    commandId: deliveryCommandId,
                    threadId: targetThreadId,
                    messageId,
                    scheduledTaskId: active.id,
                    text: prompt,
                    attachments: [],
                    // No model: a chat that already exists keeps the one its owner picked.
                    // The schedule's stored model switched a bound chat every morning and
                    // it stayed switched until the owner's next message.
                    mode: active.schedule.type === "once" ? "auto" : "queue",
                    createdBy: active.createdBy,
                    creationSource: active.creationSource,
                  });
            const targetIsEmpty = () =>
              Effect.gen(function* () {
                if (targetThreadId === null) return false;
                const records = yield* threadManagement.getProjectThreadRecords(
                  { projectId: active.projectId, threadId: targetThreadId },
                  ["runs"],
                );
                return (
                  records.runs.length === 0 &&
                  (yield* threadManagement.getMessageCount(targetThreadId)) === 0
                );
              });
            // An accepted outer claim identifies a launch replay. An initial-message
            // receipt alone belongs to normal delivery after the draft was already
            // used (or lost its empty-thread claim), so replay that same send path.
            const prepareTarget =
              draftTarget &&
              ((yield* threadManagement.hasReceipt(commandId, { acceptedOnly: true })) ||
                (!(yield* threadManagement.hasReceipt(deliveryCommandId, { acceptedOnly: true })) &&
                  (yield* targetIsEmpty())));
            if (targetThreadId !== null) {
              // A paused bot holds its routines and gets them as one note when resumed;
              // while Bots are off, saved bots' routines must not run at all.
              const hold = holdBotRoutine(targetThreadId, prompt);
              if (hold !== null && (yield* hold))
                return yield* taskError(
                  botsActive() ? "Held: the bot is paused." : "Skipped: Bots are off.",
                  { taskId: active.id },
                );
            }
            if (targetThreadId !== null && !prepareTarget) {
              return yield* sendToTarget();
            }
            return yield* threadLaunch
              .launch({
                commandId,
                projectId: active.projectId,
                ...(prepareTarget && targetThreadId !== null
                  ? { threadId: targetThreadId, reuseExistingThread: true }
                  : {}),
                title: active.title,
                modelSelection: active.modelSelection,
                // Unpinned tasks use the account with room; a named choice stays exact.
                preferAccountWithRoom: !active.accountPinned,
                runtimeMode: active.runtimeMode,
                interactionMode: active.interactionMode,
                workspaceStrategy: yield* runnableWorkspaceStrategy(
                  active.projectId,
                  active.workspaceStrategy,
                ),
                initialMessage: {
                  messageId,
                  scheduledTaskId: active.id,
                  text: prompt,
                  attachments: [],
                  ...(prepareTarget ? { deliveryIntent: "auto" as const } : {}),
                },
                createdBy: active.createdBy,
                creationSource: active.creationSource,
              })
              .pipe(
                Effect.catchTags({
                  ThreadLaunchError: (failure) =>
                    Effect.gen(function* () {
                      if (
                        !prepareTarget ||
                        failure.operation !== "update-thread" ||
                        (yield* targetIsEmpty())
                      )
                        return yield* failure;
                      // A send committed between our read and the launch's empty-thread
                      // claim. Deliver normally against the now-current thread state.
                      return yield* sendToTarget();
                    }),
                }),
              );
          }),
        );

        const completedAt = yield* localNow;
        const runSucceeded = result._tag === "Success";
        const dispatched = result._tag === "Success" ? result.value : null;
        const failure =
          result._tag === "Failure"
            ? Option.getOrUndefined(Cause.findErrorOption(result.cause))
            : undefined;
        const missingTarget = webhook === undefined ? null : missingThreadReason(failure);
        const projection = dispatched?.projection;
        const run = projection?.runs.find((candidate) => candidate.userMessageId === messageId);
        yield* saveRun({
          ...occurrence,
          dispatchStatus: runSucceeded ? "dispatched" : "failed",
          dispatchedAt: runSucceeded ? iso(completedAt) : null,
          error: runSucceeded ? null : (missingTarget ?? "The message failed to dispatch."),
          threadId:
            dispatched !== null && "threadId" in dispatched
              ? dispatched.threadId
              : (projection?.thread.id ?? active.threadId),
          runId: run?.id ?? null,
          runStatus: run?.status ?? null,
          finishedAt:
            run?.completedAt === null || run?.completedAt === undefined
              ? null
              : iso(run.completedAt),
        });
        const lastRunStatus = runSucceeded ? ("succeeded" as const) : ("failed" as const);
        const lastRunError = runSucceeded ? null : (missingTarget ?? errorMessage(result.cause));
        // Re-read the task so the next run is computed from the schedule as it
        // is *now* (the user may have edited or deleted it while we ran).
        const current = yield* findTask(task.id);
        const scheduleSource = current ?? task;
        const completed: ScheduledTask = {
          ...scheduleSource,
          updatedAt: iso(completedAt),
          lastRunAt: startedAtIso,
          nextRunAt:
            scheduleSource.schedule.type === "once" &&
            isSameSchedule(active.schedule, scheduleSource.schedule)
              ? null
              : nextRunAt(scheduleSource, completedAt),
          lastRunStatus,
          lastRunError,
        };
        let runCount = completed.runCount;
        if (current?.createdAt === active.createdAt) {
          // startedAtIso in the guard ensures this writes only to the row this
          // run marked as running — a task deleted mid-run and recreated with
          // the same id (idempotent commandId replay) must not be stamped.
          const [stored] = yield* markCompleted({
            id: task.id,
            completedAtIso: completed.updatedAt,
            nextRunAtIso: completed.nextRunAt,
            status: lastRunStatus,
            error: lastRunError,
            startedAtIso,
            onceRunAt,
            legacyReplay,
          });
          runCount = stored?.run_count ?? runCount;
          yield* notifyChanged;
        }
        if (missingTarget !== null)
          return yield* new WebhookDeliverySkipped({ reason: missingTarget });
        return { ...completed, runCount };
      }).pipe(Effect.onError((cause) => releaseStuckRun(task, errorMessage(cause))));
      // Acquisition and cleanup must remain attached even if dispatch is interrupted.
      return yield* Effect.acquireUseRelease(
        Ref.modify(activeRuns, (active) => {
          if (active.has(task.id)) return [false, active] as const;
          return [true, new Set(active).add(task.id)] as const;
        }),
        (reserved) =>
          reserved
            ? run
            : trigger === "scheduled"
              ? Effect.succeed(task)
              : Effect.fail(taskError("Schedule task is already running.", { taskId: task.id })),
        (reserved) =>
          reserved
            ? Ref.update(activeRuns, (active) => {
                const next = new Set(active);
                next.delete(task.id);
                return next;
              })
            : Effect.void,
      );
    });

    // A due fixed-time run that is long past its slot (server was off or
    // asleep) is skipped and re-aimed at its next occurrence, not fired late.
    const rescheduleMissedRun = Effect.fn("ScheduledTaskService.rescheduleMissedRun")(function* (
      task: ScheduledTask,
      now: DateTime.DateTime,
      reason = "The scheduled time was missed.",
    ) {
      const next = nextRunAt(task, now);
      const updated = yield* sql<{ task_id: string }>`
        UPDATE scheduled_tasks
        SET next_run_at = ${next},
            updated_at = ${iso(now)}
        WHERE task_id = ${task.id}
          AND created_at = ${task.createdAt}
          AND updated_at = ${task.updatedAt}
          AND next_run_at = ${task.nextRunAt}
          AND enabled = 1
          AND last_run_status != 'running'
        RETURNING task_id
      `.pipe(
        Effect.mapError((cause) =>
          taskError("Could not reschedule missed schedule task run.", { taskId: task.id, cause }),
        ),
      );
      // The poll snapshot can outlive an edit, pause, deletion or manual run.
      // Only advance the exact row that was due when this poll loaded it.
      if (updated.length === 0) return;
      yield* saveRun({
        id: CommandId.make(`scheduled-task:${task.id}:${task.nextRunAt}:scheduled`),
        taskId: task.id,
        projectId: task.projectId,
        scheduledAt: task.nextRunAt!,
        trigger: "scheduled",
        dispatchStatus: "skipped",
        dispatchedAt: null,
        error: reason,
        threadId: task.threadId,
        messageId: MessageId.make(`scheduled-task-message:${task.id}:${task.nextRunAt}:scheduled`),
        runId: null,
        runStatus: null,
        finishedAt: null,
      });
      yield* Effect.logInfo("Skipping schedule task run", {
        reason,
        taskId: task.id,
        missedRunAt: task.nextRunAt,
        rescheduledTo: next,
      });
      yield* notifyChanged;
    });

    const runDueTasks = Effect.fn("ScheduledTaskService.runDueTasks")(function* () {
      const now = yield* localNow;
      const tasks = yield* listDueTasks(now).pipe(
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );
      const due = tasks.flatMap((task) =>
        task.nextRunAt === null ? [] : [{ task, dueAt: DateTime.makeUnsafe(task.nextRunAt) }],
      );
      yield* Effect.forEach(
        due,
        ({ task, dueAt }) =>
          Effect.suspend(() =>
            isMissedFixedTimeRun(task.schedule, dueAt, now)
              ? rescheduleMissedRun(task, now)
              : runTask(task, "scheduled"),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Scheduled task run failed", { taskId: task.id, cause }),
            ),
          ),
        { concurrency: 1, discard: true },
      );
    });

    // Recover from a crash or hard shutdown mid-run: rows stuck in 'running'
    // would otherwise be skipped by the due-task filter forever. The dispatch
    // may already have gone out before the crash. Recurring work advances and
    // counts the attempt. One-shot messages keep the occurrence and replay its
    // stable command identity, so an interrupted delivery is neither lost nor
    // accepted twice. Schedules are JSON, so recovery runs per row.
    yield* Effect.gen(function* () {
      const rows = yield* selectAllRows();
      const stuck = rows.filter((row) => row.last_run_status === "running");
      if (stuck.length === 0) return;
      const now = yield* localNow;
      yield* Effect.forEach(
        stuck,
        (row) =>
          Effect.gen(function* () {
            const decoded = yield* Effect.result(decodeRow(row));
            if (Result.isSuccess(decoded)) {
              yield* sql`
                UPDATE scheduled_tasks
                SET last_run_status = 'failed',
                    last_run_error = 'Run was interrupted by a server restart.',
                    next_run_at = ${nextRunAt(decoded.success, now)},
                    updated_at = ${iso(now)},
                    run_count = run_count + ${decoded.success.schedule.type === "once" ? 0 : 1}
                WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
              `;
              return;
            }
            // The schedule cannot be decoded, so the next occurrence cannot
            // be computed — still release the row so it is not stuck in
            // 'running' (the lenient poller skips it, so it cannot re-fire).
            yield* Effect.logWarning(
              "Recovering undecodable schedule task row without rescheduling",
              { taskId: row.task_id, cause: decoded.failure },
            );
            yield* sql`
              UPDATE scheduled_tasks
              SET last_run_status = 'failed',
                  last_run_error = 'Run was interrupted by a server restart.',
                  updated_at = ${iso(now)},
                  run_count = run_count + 1
              WHERE task_id IS ${row.task_id} AND last_run_status = 'running'
            `;
          }),
        { concurrency: 1, discard: true },
      );
      yield* notifyChanged;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not reset interrupted schedule task runs", { cause }),
      ),
    );

    const list: ScheduledTaskService["Service"]["list"] = () =>
      listRows().pipe(
        Effect.map((tasks) => ({ tasks })),
        Effect.mapError((cause) => taskError("Could not list schedule tasks.", { cause })),
      );

    const subscribeList: ScheduledTaskService["Service"]["subscribeList"] = () =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before taking the snapshot so a change landing between
          // the two is buffered by the subscription rather than dropped.
          const subscription = yield* PubSub.subscribe(changesPubSub);
          return Stream.concat(
            Stream.fromEffect(list()),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => list())),
          );
        }),
      );

    const saveDefinition: ScheduledTaskService["Service"]["upsert"] = (input) =>
      Effect.gen(function* () {
        const now = yield* localNow;
        const uuid =
          input.commandId === undefined
            ? yield* crypto
                .randomUUIDv4()
                .pipe(
                  Effect.mapError((cause) =>
                    taskError("Could not generate schedule task id.", { cause }),
                  ),
                )
            : null;
        const id =
          input.id ??
          ScheduledTaskId.make(
            input.commandId ? `scheduled-task:${input.commandId}` : `scheduled-task:${uuid}`,
          );
        const existingTask = yield* findTask(id);
        if (existingTask !== null && input.id === undefined && input.commandId !== undefined) {
          return { task: existingTask };
        }
        // Keep the existing next_run_at when the schedule itself is untouched:
        // editing a title or prompt must not postpone (or resurrect) a due
        // run — only schedule/enabled changes restart the clock.
        const schedule: ScheduledTask["schedule"] =
          input.schedule.type === "webhook"
            ? {
                type: "webhook",
                signature:
                  input.schedule.signature == null
                    ? null
                    : {
                        header: input.schedule.signature.header.toLowerCase(),
                        encoding: input.schedule.signature.encoding,
                        prefix: input.schedule.signature.prefix,
                      },
                maxDeliveryAgeMinutes: input.schedule.maxDeliveryAgeMinutes ?? null,
              }
            : input.schedule;
        if (
          schedule.type === "once" &&
          (existingTask === null || !isSameSchedule(existingTask.schedule, schedule)) &&
          Date.parse(schedule.runAt) <= DateTime.toEpochMillis(now)
        ) {
          return yield* taskError("Choose a future date and time for the message.", { taskId: id });
        }
        const webhook =
          input.schedule.type === "webhook"
            ? yield* Effect.gen(function* () {
                const existing = existingTask === null ? null : yield* findWebhookCredentials(id);
                // Saving a webhook task keeps its URL; only rotate changes it.
                const token = existing?.token ?? (yield* newWebhookToken);
                const signature =
                  input.schedule.type === "webhook" ? input.schedule.signature : null;
                // A secretRef is a value the user entered for an agent; this
                // save consumes it, so it cannot be used again. A replay of a
                // save that already used it keeps the secret that save stored.
                const replay = input.commandId !== undefined && existing?.secret != null;
                const fromRef =
                  signature?.secretRef === undefined
                    ? undefined
                    : yield* secretRequests
                        .consume({ ref: signature.secretRef, projectId: input.projectId })
                        .pipe(
                          Effect.catch((error) =>
                            replay
                              ? Effect.succeed(undefined)
                              : Effect.fail(taskError(error.message, { taskId: id })),
                          ),
                        );
                // A ref, when given, is the only source: a plain secret sent
                // alongside it must not replace what a replayed save stored.
                const provided = signature?.secretRef === undefined ? signature?.secret : fromRef;
                const secret = signature == null ? null : (provided ?? existing?.secret ?? null);
                const secretChanged =
                  signature == null || provided !== undefined || existing === null;
                if (signature != null && secret === null) {
                  return yield* taskError("A webhook signature check needs a signing secret.", {
                    taskId: id,
                  });
                }
                return { token, secret, secretChanged };
              })
            : { token: null, secret: null, secretChanged: true };
        const scheduleUnchanged =
          existingTask !== null &&
          existingTask.enabled === input.enabled &&
          isSameSchedule(existingTask.schedule, schedule);
        const keepCompleted =
          existingTask !== null &&
          input.enabled &&
          !scheduleUnchanged &&
          isSameSchedule(existingTask.schedule, schedule) &&
          (yield* completedOnce(existingTask));
        const task: ScheduledTask = {
          id,
          title: input.title,
          prompt: input.prompt,
          enabled: input.enabled,
          schedule,
          projectId: input.projectId,
          threadId: input.threadId ?? null,
          workspaceStrategy: yield* runnableWorkspaceStrategy(
            input.projectId,
            input.workspaceStrategy,
          ),
          modelSelection: input.modelSelection,
          ...(input.accountPinned === true ? { accountPinned: true } : {}),
          runtimeMode: input.runtimeMode,
          interactionMode: input.interactionMode,
          createdBy: existingTask?.createdBy ?? input.createdBy ?? "user",
          creationSource: input.creationSource ?? "web",
          createdAt: existingTask?.createdAt ?? iso(now),
          updatedAt: iso(now),
          nextRunAt: keepCompleted
            ? null
            : scheduleUnchanged
              ? existingTask.nextRunAt
              : nextRunAt({ enabled: input.enabled, schedule }, now),
          lastRunAt: existingTask?.lastRunAt ?? null,
          lastRunStatus: existingTask?.lastRunStatus ?? "never",
          lastRunError: existingTask?.lastRunError ?? null,
          runCount: existingTask?.runCount ?? 0,
        };
        const newOnceOccurrence =
          schedule.type === "once" &&
          (existingTask === null || !isSameSchedule(existingTask.schedule, schedule));
        yield* saveTask(task, input.requireExisting === true, newOnceOccurrence, webhook);
        yield* notifyChanged;
        return { task: (yield* findTask(id)) ?? task };
      });

    const createLock = yield* KeyedLock.make<string>();
    const upsert: ScheduledTaskService["Service"]["upsert"] = (input) =>
      input.id === undefined && input.commandId !== undefined
        ? createLock.withLock(input.commandId, saveDefinition(input))
        : saveDefinition(input);

    const setEnabled: ScheduledTaskService["Service"]["setEnabled"] = (input) =>
      Effect.gen(function* () {
        const existing = yield* loadTask(input.id);
        if (existing.enabled === input.enabled) return { task: existing };
        const now = yield* localNow;
        const next =
          input.enabled && (yield* completedOnce(existing))
            ? null
            : nextRunAt({ enabled: input.enabled, schedule: existing.schedule }, now);
        // RETURNING so a task deleted between the load and this UPDATE is a
        // visible not-found error, not a false success.
        const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET enabled = ${input.enabled ? 1 : 0},
              next_run_at = ${next},
              updated_at = ${iso(now)}
          WHERE task_id = ${input.id}
          RETURNING task_id
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not update schedule task.", { taskId: input.id, cause }),
          ),
        );
        if (updated.length === 0) {
          return yield* taskError("Schedule task not found.", { taskId: input.id });
        }
        yield* notifyChanged;
        return {
          task: { ...existing, enabled: input.enabled, nextRunAt: next, updatedAt: iso(now) },
        };
      });

    const deleteTask: ScheduledTaskService["Service"]["delete"] = (input) =>
      deleteRow(input.id).pipe(
        Effect.andThen(
          Effect.all([
            Ref.update(webhookRateWindows, (windows) => {
              const next = new Map(windows);
              next.delete(input.id);
              return next;
            }),
            Ref.update(webhookPermits, (permits) => {
              const next = new Map(permits);
              next.delete(input.id);
              return next;
            }),
          ]),
        ),
        Effect.andThen(notifyChanged),
        Effect.as({ id: input.id }),
      );

    const runNow: ScheduledTaskService["Service"]["runNow"] = (input: ScheduledTaskRunNowInput) =>
      Effect.gen(function* () {
        const task = yield* loadTask(input.id);
        if (task.schedule.type === "webhook") {
          // There is no request to render the prompt from.
          return yield* taskError("Webhook tasks run when their URL receives a request.", {
            taskId: input.id,
          });
        }
        const next = yield* runTask(task, "manual").pipe(
          Effect.mapError((cause) =>
            taskError("Could not run schedule task.", { taskId: input.id, cause }),
          ),
        );
        return { task: next };
      });

    const rotateWebhookToken: ScheduledTaskService["Service"]["rotateWebhookToken"] = (input) =>
      Effect.gen(function* () {
        const task = yield* loadTask(input.id);
        if (task.schedule.type !== "webhook") {
          return yield* taskError("Only webhook tasks have a URL token.", { taskId: input.id });
        }
        const token = yield* newWebhookToken;
        const now = yield* localNow;
        // Matching created_at keeps a rotation from landing on a task deleted
        // and recreated under the same id since it was loaded.
        const updated = yield* sql<{ task_id: string }>`
          UPDATE scheduled_tasks
          SET webhook_token = ${token}, updated_at = ${iso(now)}
          WHERE task_id = ${input.id} AND created_at = ${task.createdAt}
          RETURNING task_id
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not rotate webhook token.", { taskId: input.id, cause }),
          ),
        );
        if (updated.length === 0) {
          return yield* taskError("Schedule task was deleted or replaced.", { taskId: input.id });
        }
        yield* notifyChanged;
        return { task: yield* loadTask(input.id) };
      });

    const deliveryHeaders = (row: WebhookDeliveryRow): Readonly<Record<string, string>> =>
      Option.getOrElse(decodeHeadersJson(row.headers_json), () => ({}));
    const decodeDeliverySummary = (row: WebhookDeliveryRow) => ({
      id: ScheduledTaskWebhookDeliveryId.make(row.delivery_id),
      taskId: ScheduledTaskId.make(row.task_id),
      receivedAt: row.received_at,
      method: row.method,
      contentType: deliveryHeaders(row)["content-type"] ?? null,
      bodyBytes: row.body_bytes,
      outcome: row.outcome as ScheduledTaskWebhookDeliveryOutcome,
      signatureVerified: row.signature_verified === 1,
      missingFields: Option.getOrElse(decodeMissingFieldsJson(row.missing_fields_json), () => []),
      error: row.error,
    });

    const listWebhookDeliveries: ScheduledTaskService["Service"]["listWebhookDeliveries"] = (
      input,
    ) =>
      sql<WebhookDeliveryRow>`
        SELECT * FROM scheduled_task_webhook_deliveries
        WHERE task_id = ${input.id}
        ORDER BY received_at DESC, rowid DESC
      `.pipe(
        Effect.map((rows) => ({ deliveries: rows.map(decodeDeliverySummary) })),
        Effect.mapError((cause) =>
          taskError("Could not list webhook deliveries.", { taskId: input.id, cause }),
        ),
      );

    const getWebhookDelivery: ScheduledTaskService["Service"]["getWebhookDelivery"] = (input) =>
      Effect.gen(function* () {
        const rows = yield* sql<WebhookDeliveryRow>`
          SELECT * FROM scheduled_task_webhook_deliveries
          WHERE task_id = ${input.id} AND delivery_id = ${input.deliveryId}
        `.pipe(
          Effect.mapError((cause) =>
            taskError("Could not load webhook delivery.", { taskId: input.id, cause }),
          ),
        );
        const row = rows[0];
        if (row === undefined) {
          return yield* taskError("Webhook delivery not found.", { taskId: input.id });
        }
        return {
          delivery: {
            ...decodeDeliverySummary(row),
            query: row.query,
            headers: deliveryHeaders(row),
            body: row.body,
            bodyTruncated: row.body_truncated === 1,
            renderedPrompt: row.rendered_prompt,
          },
        };
      });

    const recordDelivery = (input: {
      readonly id: string;
      readonly taskId: ScheduledTaskId;
      readonly receivedAt: string;
      readonly request: WebhookTriggerRequest;
      readonly outcome: ScheduledTaskWebhookDeliveryOutcome;
      readonly signatureVerified: boolean;
      readonly missing: ReadonlyArray<string>;
      readonly renderedPrompt: string | null;
      readonly error?: string;
    }) => {
      const truncated = input.request.body.byteLength > WEBHOOK_DELIVERY_LOG_BODY_LIMIT;
      const loggedBody = truncated
        ? new TextDecoder().decode(input.request.body.subarray(0, WEBHOOK_DELIVERY_LOG_BODY_LIMIT))
        : input.request.bodyText;
      return sql
        .withTransaction(
          Effect.gen(function* () {
            // Conditional on the task existing, so a delivery racing a delete
            // cannot leave rows that a recreated task with the same id would show.
            yield* sql`
              INSERT INTO scheduled_task_webhook_deliveries (
                delivery_id, task_id, received_at, method, query, headers_json, body,
                body_bytes, body_truncated, outcome, signature_verified,
                missing_fields_json, rendered_prompt, error
              )
              SELECT
                ${input.id}, ${input.taskId}, ${input.receivedAt}, ${input.request.method},
                ${redactQuery(input.request.query)},
                ${encodeHeadersJson(redactHeaders(input.request.headers))},
                ${loggedBody},
                ${input.request.body.byteLength}, ${truncated ? 1 : 0}, ${input.outcome},
                ${input.signatureVerified ? 1 : 0}, ${encodeMissingFieldsJson(input.missing)},
                ${input.renderedPrompt?.slice(0, WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT) ?? null},
                ${input.error ?? null}
              WHERE EXISTS (SELECT 1 FROM scheduled_tasks WHERE task_id = ${input.taskId})
              -- A held request retried after a rate limit reuses its relay
              -- delivery id; the newer attempt replaces the logged one.
              ON CONFLICT (delivery_id) DO UPDATE SET
                outcome = excluded.outcome,
                signature_verified = excluded.signature_verified,
                missing_fields_json = excluded.missing_fields_json,
                rendered_prompt = excluded.rendered_prompt,
                error = excluded.error
            `;
            yield* sql`
            DELETE FROM scheduled_task_webhook_deliveries
            WHERE task_id = ${input.taskId}
              AND delivery_id NOT IN (
                SELECT delivery_id FROM scheduled_task_webhook_deliveries
                WHERE task_id = ${input.taskId}
                -- rowid breaks timestamp ties in arrival order; delivery ids are random.
                ORDER BY received_at DESC, rowid DESC
                LIMIT ${WEBHOOK_DELIVERY_RETENTION}
              )
          `;
          }),
        )
        .pipe(
          Effect.mapError((cause) =>
            taskError("Could not record webhook delivery.", { taskId: input.taskId, cause }),
          ),
        );
    };

    const markDeliveryFailed = (deliveryId: string, message: string) =>
      sql`
        UPDATE scheduled_task_webhook_deliveries
        SET outcome = 'dispatch_failed', error = ${message}
        WHERE delivery_id = ${deliveryId}
      `.pipe(Effect.ignore);

    /**
     * Sliding one-minute window counting every request with a valid token,
     * including ones the signature check later rejects.
     */
    const takeRateSlot = (id: ScheduledTaskId, nowMs: number) =>
      Ref.modify(
        webhookRateWindows,
        (
          windows,
        ): readonly [
          "allowed" | "first_rejected" | "rejected",
          ReadonlyMap<ScheduledTaskId, RateWindow>,
        ] => {
          const current = windows.get(id);
          const recent = (current?.accepted ?? []).filter((at) => nowMs - at < 60_000);
          if (recent.length >= WEBHOOK_RATE_LIMIT_PER_MINUTE) {
            const first = current?.rejectedLogged !== true;
            return [
              first ? "first_rejected" : "rejected",
              new Map(windows).set(id, { accepted: recent, rejectedLogged: true }),
            ];
          }
          return [
            "allowed",
            new Map(windows).set(id, { accepted: [...recent, nowMs], rejectedLogged: false }),
          ];
        },
      );

    const webhookPermit = (id: ScheduledTaskId) =>
      Effect.gen(function* () {
        const existing = (yield* Ref.get(webhookPermits)).get(id);
        if (existing !== undefined) return existing;
        const created = yield* Semaphore.make(1);
        return yield* Ref.modify(webhookPermits, (permits) => {
          const raced = permits.get(id);
          return raced === undefined
            ? [created, new Map(permits).set(id, created)]
            : [raced, permits];
        });
      });

    // Detached from the request so the HTTP response does not wait for the
    // run; scoped to the service so shutdown interrupts it.
    const serviceScope = yield* Effect.scope;

    /**
     * Records one handled request on the span and in metrics. `outcome` is
     * finer than the result tag: it separates a full queue and an oversized
     * prompt from the rest, which is what an operator needs to act on.
     */
    const observeDelivery = (
      request: WebhookTriggerRequest,
      outcome: WebhookDeliveryOutcome,
      receivedAt: DateTime.DateTime | undefined,
      now: DateTime.DateTime | undefined,
    ) =>
      Effect.gen(function* () {
        const source = request.relayDeliveryId === undefined ? "direct" : "relay";
        yield* Effect.annotateCurrentSpan({
          "scheduled_task.webhook.outcome": outcome,
          "scheduled_task.webhook.source": source,
        });
        yield* Metrics.increment(Metrics.webhookDeliveriesTotal, { outcome, source });
        if (request.receivedAt !== undefined && receivedAt !== undefined && now !== undefined) {
          const heldMs = Math.max(
            0,
            DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt),
          );
          yield* Effect.annotateCurrentSpan({ "scheduled_task.webhook.held_ms": heldMs });
          yield* Metric.update(Metrics.webhookHeldDelay, Duration.millis(heldMs));
        }
      });

    const claimDelivery = (
      delivery: Pick<
        ScheduledTaskState.PendingWebhookDelivery,
        "taskId" | "deliveryId" | "relayDeliveryId"
      >,
    ) =>
      Effect.gen(function* () {
        if (delivery.relayDeliveryId === null) return;
        const now = yield* localNow;
        yield* sql`INSERT INTO scheduled_task_webhook_relay_deliveries (relay_delivery_id, task_id, seen_at)
        VALUES (${delivery.relayDeliveryId}, ${delivery.taskId}, ${iso(now)})
        ON CONFLICT (relay_delivery_id) DO NOTHING`.pipe(
          Effect.mapError((cause) =>
            taskError("Could not record webhook delivery.", { taskId: delivery.taskId, cause }),
          ),
        );
      });

    const enqueueDelivery = (delivery: ScheduledTaskState.PendingWebhookDelivery) => {
      const settle = claimDelivery(delivery).pipe(
        Effect.andThen(
          durableState.update((state) => ({
            ...state,
            deliveries: state.deliveries.filter(
              (entry) => entry.deliveryId !== delivery.deliveryId,
            ),
          })),
        ),
      );
      const dispatch = Effect.gen(function* () {
        const task = yield* findTask(delivery.taskId);
        if (task === null || task.createdAt !== delivery.taskCreatedAt) {
          yield* markDeliveryFailed(delivery.deliveryId, "The task was deleted or replaced.");
          yield* settle;
          return;
        }
        const completed = yield* runTask(task, "webhook", {
          deliveryId: delivery.deliveryId,
          prompt: delivery.prompt,
          receivedAt: delivery.receivedAt,
        });
        if (completed.lastRunStatus === "failed") {
          yield* markDeliveryFailed(
            delivery.deliveryId,
            "The message failed to dispatch. It will retry.",
          );
          yield* Metrics.increment(Metrics.webhookRunsTotal, { outcome: "failed" });
          return;
        }
        yield* sql`UPDATE scheduled_task_webhook_deliveries SET outcome = 'accepted', error = NULL
            WHERE delivery_id = ${delivery.deliveryId}`.pipe(
          Effect.mapError((cause) =>
            taskError("Could not record webhook dispatch.", { taskId: delivery.taskId, cause }),
          ),
        );
        yield* settle;
        yield* Metrics.increment(Metrics.webhookRunsTotal, { outcome: "started" });
      }).pipe(
        Effect.catchTags({
          WebhookDeliverySkipped: (skipped) =>
            markDeliveryFailed(delivery.deliveryId, skipped.reason).pipe(
              Effect.andThen(settle),
              Effect.asVoid,
            ),
        }),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning("Webhook dispatch remains pending", {
                taskId: delivery.taskId,
                cause,
              }),
        ),
        Effect.withSpan("ScheduledTaskService.runWebhookDelivery", {
          root: true,
          attributes: {
            "scheduled_task.id": delivery.taskId,
            "scheduled_task.webhook.delivery_id": delivery.deliveryId,
          },
        }),
      );
      // The worker owns the reservation, including waiting for its task's permit.
      return Effect.acquireUseRelease(
        Effect.sync(() => {
          if (delivering.has(delivery.deliveryId)) return false;
          delivering.add(delivery.deliveryId);
          return true;
        }),
        (reserved) =>
          reserved
            ? webhookPermit(delivery.taskId).pipe(
                Effect.flatMap((permit) => dispatch.pipe(permit.withPermits(1))),
              )
            : Effect.void,
        (reserved) =>
          Effect.sync(() => {
            if (reserved) delivering.delete(delivery.deliveryId);
          }),
      ).pipe(
        // A relay-delivered webhook is traced to the relay; the run it starts is local
        // work whose spans carry workspace paths (upstream #42450).
        withLocalTracing,
        Effect.forkIn(serviceScope, { startImmediately: true }),
        Effect.asVoid,
      );
    };

    const recoverDeliveries = Effect.gen(function* () {
      for (const delivery of (yield* durableState.read).deliveries)
        yield* enqueueDelivery(delivery);
    });

    const triggerWebhook: ScheduledTaskService["Service"]["triggerWebhook"] = (request) =>
      triggerWebhookUnobserved(request).pipe(
        Effect.tapError(() => observeDelivery(request, "error", undefined, undefined)),
        Metrics.withMetrics({ timer: Metrics.webhookDeliveryDuration }),
        Effect.withSpan("ScheduledTaskService.triggerWebhook", {
          attributes: {
            "scheduled_task.webhook.method": request.method,
            "scheduled_task.webhook.body_bytes": request.body.byteLength,
            "scheduled_task.webhook.source":
              request.relayDeliveryId === undefined ? "direct" : "relay",
          },
        }),
      );

    const triggerWebhookUnobserved = (request: WebhookTriggerRequest) =>
      Effect.gen(function* () {
        const taskId = decodeTaskId(request.hookId);
        const notFound = observeDelivery(request, "not_found", undefined, undefined).pipe(
          Effect.as({ _tag: "not_found" as const }),
        );
        if (Option.isNone(taskId)) return yield* notFound;
        const rows = yield* getRows(taskId.value).pipe(
          Effect.mapError((cause) =>
            taskError("Could not load schedule task.", { taskId: taskId.value, cause }),
          ),
        );
        const row = rows[0];
        // A wrong token is indistinguishable from an unknown hook, so the URL
        // does not reveal which hooks exist.
        if (
          row === undefined ||
          row.webhook_token === null ||
          !constantTimeEquals(request.token, row.webhook_token)
        ) {
          return yield* notFound;
        }
        const task = yield* decodeRow(row);
        yield* Effect.annotateCurrentSpan({ "scheduled_task.id": task.id });
        const schedule = task.schedule;
        if (schedule.type !== "webhook") return yield* notFound;

        const now = yield* localNow;
        // Anyone can reach the tunnel directly and set the relay's header, so
        // a receive time is never later than now: a future one would pin the
        // delivery in the log and slip past the task's max age.
        const receivedAt =
          request.receivedAt === undefined
            ? now
            : DateTime.min(
                Option.getOrElse(DateTime.make(request.receivedAt), () => now),
                now,
              );
        const observe = (outcome: WebhookDeliveryOutcome) =>
          observeDelivery(request, outcome, receivedAt, now);
        const deliveryId = ScheduledTaskWebhookDeliveryId.make(
          request.relayDeliveryId === undefined
            ? `delivery:${yield* crypto
                .randomUUIDv4()
                .pipe(
                  Effect.mapError((cause) =>
                    taskError("Could not generate delivery id.", { cause }),
                  ),
                )}`
            : `delivery:relay:${request.relayDeliveryId}`,
        );
        // Serialize admission with durable ownership; cancellation cannot leave a
        // saved delivery without its recovery owner.
        return yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (request.relayDeliveryId !== undefined) {
              const pending = (yield* durableState.read).deliveries.find(
                (entry) => entry.deliveryId === deliveryId,
              );
              if (pending !== undefined) {
                yield* enqueueDelivery(pending);
                yield* observe("duplicate");
                return { _tag: "accepted" as const, deliveryId, outcome: "duplicate" as const };
              }
              const claimed = yield* sql<{ relay_delivery_id: string }>`
                SELECT relay_delivery_id FROM scheduled_task_webhook_relay_deliveries
                WHERE relay_delivery_id = ${request.relayDeliveryId}
              `.pipe(
                Effect.mapError((cause) =>
                  taskError("Could not load webhook delivery.", { taskId: task.id, cause }),
                ),
              );
              if (claimed.length > 0) {
                // Claims are written only after dispatch or a terminal refusal.
                yield* observe("duplicate");
                return { _tag: "accepted" as const, deliveryId, outcome: "duplicate" as const };
              }
              // Older claims can no longer be replayed by the relay.
              yield* sql`
                DELETE FROM scheduled_task_webhook_relay_deliveries
                WHERE seen_at < ${iso(DateTime.subtract(now, { hours: 48 }))}
              `.pipe(Effect.ignore);
            }
            const log = (
              outcome: ScheduledTaskWebhookDeliveryOutcome,
              details: {
                readonly signatureVerified?: boolean;
                readonly missing?: ReadonlyArray<string>;
                readonly renderedPrompt?: string;
                readonly error?: string;
              } = {},
            ) =>
              recordDelivery({
                id: deliveryId,
                taskId: task.id,
                receivedAt: iso(receivedAt),
                request,
                outcome,
                signatureVerified: details.signatureVerified ?? false,
                missing: details.missing ?? [],
                renderedPrompt: details.renderedPrompt ?? null,
                ...(details.error === undefined ? {} : { error: details.error }),
              });

            // Only the first rejected request in a window is logged, so a flood
            // cannot write rows or push the real deliveries out of the log.
            const slot = yield* takeRateSlot(task.id, DateTime.toEpochMillis(now));
            if (slot !== "allowed") {
              if (slot === "first_rejected") yield* log("rate_limited");
              yield* observe("rate_limited");
              return { _tag: "rate_limited" as const, outcome: "rate_limited" as const };
            }
            if (!task.enabled) {
              yield* log("disabled");
              yield* claimDelivery({
                deliveryId,
                taskId: task.id,
                relayDeliveryId: request.relayDeliveryId ?? null,
              });
              yield* observe("disabled");
              return { _tag: "disabled" as const };
            }
            const signature = schedule.signature;
            if (signature !== null) {
              const verified =
                row.webhook_secret !== null &&
                verifyWebhookSignature({
                  signature,
                  secret: row.webhook_secret,
                  headers: request.headers,
                  body: request.body,
                });
              if (!verified) {
                yield* log("rejected_signature");
                yield* claimDelivery({
                  deliveryId,
                  taskId: task.id,
                  relayDeliveryId: request.relayDeliveryId ?? null,
                });
                yield* observe("rejected_signature");
                return { _tag: "rejected_signature" as const };
              }
            }
            const maxAgeMinutes = schedule.maxDeliveryAgeMinutes ?? null;
            if (
              maxAgeMinutes !== null &&
              DateTime.toEpochMillis(now) - DateTime.toEpochMillis(receivedAt) >
                maxAgeMinutes * 60_000
            ) {
              yield* log("expired", { signatureVerified: signature !== null });
              yield* claimDelivery({
                deliveryId,
                taskId: task.id,
                relayDeliveryId: request.relayDeliveryId ?? null,
              });
              yield* observe("expired");
              return { _tag: "expired" as const };
            }

            const rendered = renderWebhookPrompt(task.prompt, request);
            // A provider refuses a turn this long, so it is not started. The
            // delivery is not retryable, so the claim is kept. Providers trim
            // the prompt before checking, so whitespace around it is free.
            if (rendered.prompt.trim().length > PROVIDER_SEND_TURN_MAX_INPUT_CHARS) {
              yield* log("dispatch_failed", {
                signatureVerified: signature !== null,
                missing: rendered.missing,
                renderedPrompt: rendered.prompt,
                error: "The filled-in prompt is too long.",
              });
              yield* claimDelivery({
                deliveryId,
                taskId: task.id,
                relayDeliveryId: request.relayDeliveryId ?? null,
              });
              yield* observe("prompt_too_long");
              return { _tag: "accepted" as const, deliveryId, outcome: "prompt_too_long" as const };
            }
            const state = yield* durableState.read;
            if (
              state.deliveries.filter(
                (entry) => entry.taskId === task.id && entry.taskCreatedAt === task.createdAt,
              ).length >= WEBHOOK_MAX_QUEUED_PER_TASK
            ) {
              yield* observe("queue_full");
              return { _tag: "rate_limited" as const, outcome: "queue_full" as const };
            }
            const delivery: ScheduledTaskState.PendingWebhookDelivery = {
              deliveryId,
              taskId: task.id,
              taskCreatedAt: task.createdAt,
              receivedAt: iso(receivedAt),
              relayDeliveryId: request.relayDeliveryId ?? null,
              prompt: rendered.prompt,
            };
            // This file owns execution before the log or HTTP acceptance. A crash
            // at any later instruction can replay the same command identity.
            yield* durableState.update((current) => ({
              ...current,
              deliveries: [...current.deliveries, delivery],
            }));
            yield* log("accepted", {
              signatureVerified: signature !== null,
              missing: rendered.missing,
              renderedPrompt: rendered.prompt,
            });
            yield* observe("accepted");
            yield* enqueueDelivery(delivery);
            return { _tag: "accepted" as const, deliveryId, outcome: "accepted" as const };
          }).pipe(acceptanceLock.withPermits(1)),
        );
      });

    const listRuns: ScheduledTaskService["Service"]["listRuns"] = (input) =>
      Effect.gen(function* () {
        const state = yield* durableState.read;
        const history = state.runs.filter((run) => run.taskId === input.id);
        const cursor =
          input.before === undefined ? -1 : history.findIndex((run) => run.id === input.before);
        if (input.before !== undefined && cursor === -1)
          return yield* taskError("Run history changed. Reload the latest runs.", {
            taskId: input.id,
          });
        const start = cursor + 1;
        const page = history.slice(start, start + (input.limit ?? 20));
        const threadIds = new Set(
          page.flatMap((entry) => (entry.threadId === null ? [] : [entry.threadId])),
        );
        const projections = new Map(
          yield* Effect.forEach(threadIds, (threadId) =>
            threadManagement.getThreadRecords(threadId, ["runs"]).pipe(
              // Keep the persisted run history accessible after its chat is removed.
              Effect.catchIf(
                (cause) => missingThreadReason(cause) !== null,
                () => Effect.succeed(null),
              ),
              Effect.map((projection) => [threadId, projection] as const),
              Effect.mapError((cause) =>
                taskError("Could not read scheduled task run.", { taskId: input.id, cause }),
              ),
            ),
          ),
        );
        const refreshed = page.map((entry) => {
          const run =
            entry.threadId === null
              ? undefined
              : projections
                  .get(entry.threadId)
                  ?.runs.find((candidate) => candidate.userMessageId === entry.messageId);
          if (run === undefined) return entry;
          const finishedAt = run.completedAt === null ? null : iso(run.completedAt);
          return entry.runId === run.id &&
            entry.runStatus === run.status &&
            entry.finishedAt === finishedAt
            ? entry
            : { ...entry, runId: run.id, runStatus: run.status, finishedAt };
        });
        if (page.some((entry, index) => entry !== refreshed[index])) {
          const updates = new Map(refreshed.map((run) => [run.id, run]));
          const originals = new Map(page.map((run) => [run.id, run]));
          yield* durableState.update((current) => ({
            ...current,
            runs: current.runs.map((run) =>
              run === originals.get(run.id) ? (updates.get(run.id) ?? run) : run,
            ),
          }));
        }
        return {
          runs: refreshed,
          nextCursor: start + page.length < history.length ? (page.at(-1)?.id ?? null) : null,
        };
      });

    const previewWebhook: ScheduledTaskService["Service"]["previewWebhook"] = (input) =>
      Effect.gen(function* () {
        const task = yield* findTask(input.id);
        if (task?.schedule.type !== "webhook")
          return yield* taskError("Webhook task not found.", { taskId: input.id });
        const rendered = previewWebhookPrompt(
          input.template ?? task.prompt,
          {
            ...input,
            headers: Object.fromEntries(
              Object.entries(input.headers).map(([name, value]) => [name.toLowerCase(), value]),
            ),
          },
          WEBHOOK_DELIVERY_LOG_PROMPT_LIMIT,
        );
        return {
          prompt: rendered.prompt,
          missing: rendered.missing,
          characterCount: rendered.characterCount,
          tooLong: rendered.trimmedCharacterCount > PROVIDER_SEND_TURN_MAX_INPUT_CHARS,
          truncated: rendered.truncated,
        };
      });

    yield* durableState.update((state) =>
      state.runs.some((run) => run.dispatchStatus === "dispatching")
        ? {
            ...state,
            runs: state.runs.map((run) =>
              run.dispatchStatus === "dispatching"
                ? {
                    ...run,
                    dispatchStatus: "interrupted" as const,
                    error: "Dispatch was interrupted by a server restart.",
                  }
                : run,
            ),
          }
        : state,
    );
    yield* scheduler.register(
      "scheduled-tasks",
      recoverDeliveries.pipe(Effect.andThen(runDueTasks())),
    );
    return ScheduledTaskService.of({
      list,
      listRuns,
      previewWebhook,
      subscribeList,
      upsert,
      setEnabled,
      delete: deleteTask,
      runNow,
      rotateWebhookToken,
      listWebhookDeliveries,
      getWebhookDelivery,
      triggerWebhook,
    });
  }),
);
