import {
  CommandId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  OrchestrationV2UserInputQuestion,
  type RunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { reportLabel } from "@t3tools/provider-core/server/notification";

import { forkParked } from "../serverActivation.ts";
import { taskReference } from "./taskReference.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

/** Questions read per startup recovery page. */
const PENDING_QUESTION_RECOVERY_LIMIT = 100;
const encodeQuestions = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(OrchestrationV2UserInputQuestion)),
);

/**
 * Wakes the parent of an app-owned delegated task when the task asks a question. The question
 * blocks the task until someone answers it, and the user rarely watches child threads, so the
 * parent agent is told to answer it or to ask the user. Only questions are routed: approvals
 * cannot be answered through the pending request tools.
 */
export class DelegatedTaskQuestionReactor extends Context.Service<
  DelegatedTaskQuestionReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/DelegatedTaskQuestionReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const wakeParent = Effect.fnUntraced(function* (
    task: OrchestrationV2Subagent,
    request: OrchestrationV2RuntimeRequest,
  ) {
    if (task.childThreadId === null || task.remote !== undefined) return;
    const key = `${task.threadId}:${request.id}`;
    const label = reportLabel(task.title?.trim() || task.prompt);
    const state = request.responseCapability.type === "message" ? "still working" : "blocked";
    const situation = `Subagent ${taskReference(task.id)}: question (${task.providerInstanceId}/${task.model ?? "default"}), ${state}.`;
    const { item } = yield* projections.getRuntimeResponseContext(task.childThreadId, request.id);
    const target = `{threadId:"${task.childThreadId}",requestId:"${request.id}"}`;
    const question =
      item?.type === "user_input_request" && item.questions.length > 0
        ? encodeQuestions(item.questions)
        : `Read t3_pending_request_read(${target}).`;
    yield* engine
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:delegated-task-question:${key}`),
        threadId: task.threadId,
        messageId: MessageId.make(`message:delegated-task-question:${key}`),
        text: `${situation}\n${question}\nAnswer via t3_pending_request_respond with ${target} and answers from task/user instructions; otherwise ask_user and relay the reply.`,
        notification: {
          source: { kind: "delegated_task", taskIds: [task.id], childThreadId: task.childThreadId },
          outcome: "updated",
          summary: `Delegated task${label === undefined ? "" : ` "${label}"`} has a question`,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        // A dispatch that fails before it commits records nothing, so the same command can still
        // go through. A rejected one stays rejected.
        Effect.retry({
          times: 3,
          schedule: Schedule.exponential("500 millis"),
          while: (error) => error._tag !== "OrchestratorCommandPreviouslyRejectedError",
        }),
      );
  });

  const relayQuestion = Effect.fnUntraced(function* (
    child: OrchestrationV2AppThread,
    request: OrchestrationV2RuntimeRequest,
    runId: RunId | undefined,
  ) {
    const parentThreadId = child.lineage.parentThreadId;
    if (parentThreadId === null || child.lineage.parentEnvironmentId !== undefined) return;
    const parent = yield* projections.getThreadRecords(parentThreadId, ["subagents", "runs"]);
    const { runs } = yield* projections.getThreadRecords(child.id, ["runs"]);
    const run =
      runs.find((run) => run.id === runId) ?? runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
    const taskId =
      run?.delegatedTaskId ??
      (child.forkedFrom?.type === "node" ? child.forkedFrom.nodeId : undefined);
    const task = parent.subagents.find(
      (candidate) =>
        candidate.origin === "app_owned" &&
        candidate.remote === undefined &&
        candidate.id === taskId,
    );
    if (
      task === undefined ||
      parent.thread.archivedAt !== null ||
      parent.thread.deletedAt !== null
    ) {
      return;
    }
    // A blocking delegate_task wait delivers the question itself.
    if (
      task.completionWake === "settled_only" &&
      request.responseCapability.type === "live" &&
      parent.runs.some(
        (run) =>
          run.id === task.runId &&
          (run.status === "preparing" || run.status === "starting" || run.status === "running"),
      )
    ) {
      return;
    }
    yield* wakeParent(task, request);
  });

  const handle: DelegatedTaskQuestionReactor["Service"]["handle"] = (event) =>
    Effect.gen(function* () {
      if (event.type === "run.updated") {
        if (!["completed", "failed", "waiting"].includes(event.payload.status)) return;
        const parent = yield* projections.getThreadRecords(event.threadId, ["subagents"]);
        if (parent.thread.archivedAt !== null || parent.thread.deletedAt !== null) return;
        for (const task of parent.subagents) {
          if (
            task.origin !== "app_owned" ||
            task.remote !== undefined ||
            task.runId !== event.payload.id ||
            task.completionWake !== "settled_only" ||
            task.completionDelivery?.state === "disposed" ||
            task.childThreadId === null ||
            ["completed", "failed", "cancelled", "interrupted"].includes(task.status)
          ) {
            continue;
          }
          const child = yield* projections.getThreadRecords(task.childThreadId, [
            "runtimeRequests",
          ]);
          for (const request of child.runtimeRequests) {
            if (
              request.kind !== "user_input" ||
              request.status !== "pending" ||
              request.responseCapability.type !== "live"
            ) {
              continue;
            }
            yield* wakeParent(task, request).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("catching up a delegated task question failed", {
                  taskId: task.id,
                  requestId: request.id,
                  cause,
                }),
              ),
            );
          }
        }
        return;
      }
      if (event.type !== "runtime-request.updated" || event.payload.kind !== "user_input") {
        return;
      }
      const child = yield* projections.getThread(event.threadId);
      const parentThreadId = child.lineage.parentThreadId;
      if (parentThreadId === null || child.lineage.parentEnvironmentId !== undefined) return;
      const request = yield* projections.getRuntimeRequest(event.threadId, event.payload.id);
      // Keyed by the request, so a request updated while still pending wakes the parent once.
      const key = `${parentThreadId}:${event.payload.id}`;
      const messageId = MessageId.make(`message:delegated-task-question:${key}`);
      if (event.payload.status !== "pending" || request?.status !== "pending") {
        const parent = yield* projections.getThreadRecords(parentThreadId, ["runs"]);
        const queued = parent.runs.find(
          (run) => run.status === "queued" && run.userMessageId === messageId,
        );
        if (queued !== undefined) {
          yield* engine.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`server:delegated-task-question-cancel:${key}`),
            threadId: parentThreadId,
            runId: queued.id,
          });
        }
        return;
      }
      yield* relayQuestion(child, request, event.runId);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("waking the parent of a delegated task question failed", {
          threadId: event.threadId,
          cause,
        }),
      ),
    );

  // The live tail misses a question committed before a crash, or one whose notice failed. The
  // notice keeps its command id, so one already delivered is not repeated.
  const relayPendingQuestions = Effect.gen(function* () {
    let before: Parameters<typeof projections.getPendingChildQuestions>[1];
    while (true) {
      const questions = yield* projections.getPendingChildQuestions(
        PENDING_QUESTION_RECOVERY_LIMIT,
        before,
      );
      for (const { threadId, runId, request } of questions) {
        yield* projections.getThread(threadId).pipe(
          Effect.flatMap((child) => relayQuestion(child, request, runId ?? undefined)),
          Effect.catchCause((cause) =>
            Effect.logWarning("relaying a pending delegated task question failed", {
              threadId,
              requestId: request.id,
              cause,
            }),
          ),
        );
      }
      if (questions.length < PENDING_QUESTION_RECOVERY_LIMIT) break;
      const last = questions[questions.length - 1]!.request;
      before = { createdAt: last.createdAt, requestId: last.id };
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("reading pending delegated task questions failed", { cause }),
    ),
  );

  const start: DelegatedTaskQuestionReactor["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        // Questions up to this cursor are relayed from the projection, later ones from the tail.
        const afterSequence = yield* eventSink.latestSequence();
        yield* relayPendingQuestions;
        // Each stream keeps one type before buffering, so a notice waiting on a busy parent
        // retains no transcript events. The handlers read the projection, so the two types
        // need not interleave in commit order.
        yield* Stream.runForEach(
          Stream.merge(
            eventSink.stream({ afterSequence, eventType: "run.updated" }),
            eventSink.stream({ afterSequence, eventType: "runtime-request.updated" }),
          ),
          (stored) => handle(stored.event),
        );
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("delegated task question event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies DelegatedTaskQuestionReactor["Service"];
});

export const layer = Layer.effect(DelegatedTaskQuestionReactor, make);
