import { encodeRequestPart } from "../orchestration-v2/taskReference.ts";
import {
  CommandId,
  OrchestratorMcpFailure,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type ThreadMetadataMcpAction,
  type ThreadMetadataMcpUpdateInput,
  type ThreadMetadataMcpUpdateMetadataResult,
  type ThreadMetadataMcpUpdateResult,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { dispatchFailure, resolveTaskThreadReference } from "./threadAccess.ts";

export class ThreadMetadataMcpService extends Context.Service<
  ThreadMetadataMcpService,
  {
    readonly update: (
      scope: McpInvocationScope,
      input: ThreadMetadataMcpUpdateInput,
    ) => Effect.Effect<ThreadMetadataMcpUpdateResult, OrchestratorMcpFailure>;
  }
>()("t3/mcp/ThreadMetadataMcpService") {}

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function threadLookupFailure(
  error: ThreadManagementService.ThreadManagementError,
): OrchestratorMcpFailure {
  return error._tag === "ThreadManagementThreadNotFoundError"
    ? failure("thread_not_found", error.message)
    : failure("orchestration_error", error.message);
}

function commandId(input: {
  readonly scope: McpInvocationScope;
  readonly threadId: ThreadId;
  readonly action: ThreadMetadataMcpAction;
  readonly requestKey: string;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      encodeRequestPart(input.scope.requestNamespace),
      "thread-update",
      encodeRequestPart(input.threadId),
      encodeRequestPart(input.action),
      encodeRequestPart(input.requestKey),
    ].join(":"),
  );
}

function updateCommand(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly projectId: OrchestrationV2AppThread["projectId"];
  readonly update: ThreadMetadataMcpUpdateInput;
}): Extract<
  OrchestrationV2Command,
  {
    readonly type:
      | "thread.metadata.update"
      | "thread.settle"
      | "thread.unsettle"
      | "queued-run.cancel";
  }
> {
  switch (input.update.action) {
    case "rename":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        title: input.update.title!,
      };
    case "regenerate_title":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        regenerateTitle: true,
      };
    case "link_pull_request":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        linkedPullRequest: {
          projectId: input.projectId,
          ...input.update.pullRequest!,
        },
      };
    case "unlink_pull_request":
      return {
        type: "thread.metadata.update",
        commandId: input.commandId,
        threadId: input.threadId,
        linkedPullRequest: null,
      };
    case "settle":
      return { type: "thread.settle", commandId: input.commandId, threadId: input.threadId };
    case "unsettle":
      return {
        type: "thread.unsettle",
        commandId: input.commandId,
        threadId: input.threadId,
        reason: "user",
      };
    case "cancel_queued":
      return {
        type: "queued-run.cancel",
        commandId: input.commandId,
        threadId: input.threadId,
        runId: input.update.runId!,
      };
  }
}

const RESULT_EVENT_TYPES = new Set([
  "thread.metadata-updated",
  "thread.settled",
  "thread.unsettled",
]);

function resultFromThread(input: {
  readonly action: ThreadMetadataMcpAction;
  readonly commandId: CommandId;
  readonly sequence: number;
  readonly thread: OrchestrationV2AppThread;
}): ThreadMetadataMcpUpdateMetadataResult {
  return {
    threadId: input.thread.id,
    action: input.action,
    commandId: input.commandId,
    sequence: input.sequence,
    title: input.thread.title,
    titleRegeneration:
      input.thread.titleRegeneration === undefined || input.thread.titleRegeneration === null
        ? null
        : {
            requestId: input.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(input.thread.titleRegeneration.startedAt),
          },
    linkedPullRequest: input.thread.linkedPullRequest ?? null,
    settled: input.thread.settledAt !== null,
    updatedAt: DateTime.formatIso(input.thread.updatedAt),
  };
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;

  const update = Effect.fn("ThreadMetadataMcpService.update")(function* (
    scope: McpInvocationScope,
    input: ThreadMetadataMcpUpdateInput,
  ) {
    if (!scope.capabilities.has("orchestration")) {
      return yield* failure(
        "capability_denied",
        "This MCP credential does not grant orchestration capabilities.",
      );
    }

    const requestedThreadId = input.threadId ?? scope.thread?.threadId;
    if (requestedThreadId === undefined) {
      return yield* failure(
        "target_required",
        "Pass threadId: this MCP client is not running inside a SSHCode thread.",
      );
    }
    const threadId = yield* resolveTaskThreadReference(
      threadManagement,
      scope.thread?.threadId,
      requestedThreadId,
    );
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to locate thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );
    if (shell === null || shell.deletedAt !== null) {
      return yield* failure("thread_not_found", `Thread ${threadId} was not found.`);
    }
    const target = yield* threadManagement
      .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [])
      .pipe(Effect.mapError(threadLookupFailure));
    const requestKey =
      input.clientRequestId === undefined
        ? yield* crypto.randomUUIDv4().pipe(Effect.orDie)
        : input.clientRequestId;
    const updateCommandId = commandId({
      scope,
      threadId,
      action: input.action,
      requestKey,
    });
    if (input.action === "settle") {
      const settled = yield* threadManagement
        .settleThread({
          threadId,
          commandId: updateCommandId,
          byOwnAgent: scope.thread?.threadId === threadId,
        })
        .pipe(Effect.mapError(dispatchFailure));
      if ("settlesWhenTurnEnds" in settled) return settled;
      const thread = (yield* threadManagement
        .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [])
        .pipe(Effect.mapError(threadLookupFailure))).thread;
      return resultFromThread({
        action: input.action,
        commandId: updateCommandId,
        sequence: settled.sequence,
        thread,
      });
    }
    const dispatched = yield* threadManagement
      .dispatch(
        updateCommand({
          commandId: updateCommandId,
          threadId,
          projectId: target.thread.projectId,
          update: input,
        }),
      )
      .pipe(
        Effect.mapError((error) =>
          input.action === "cancel_queued"
            ? dispatchFailure(error)
            : failure(
                "orchestration_error",
                `Unable to ${input.action} for thread ${threadId}: ${errorMessage(error)}`,
              ),
        ),
      );
    const resultEvent = dispatched.storedEvents.find((stored) =>
      RESULT_EVENT_TYPES.has(stored.event.type),
    )?.event;
    let thread =
      resultEvent?.type === "thread.metadata-updated" ||
      resultEvent?.type === "thread.settled" ||
      resultEvent?.type === "thread.unsettled"
        ? resultEvent.payload
        : input.action === "cancel_queued"
          ? target.thread
          : undefined;
    // Unsettling an active thread changes nothing and emits no event.
    if (thread === undefined && input.action === "unsettle") {
      thread = (yield* threadManagement
        .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [])
        .pipe(Effect.mapError(threadLookupFailure))).thread;
    }
    if (thread === undefined) {
      return yield* failure(
        "orchestration_error",
        `Thread ${threadId} metadata update completed without a resultant state.`,
      );
    }
    return resultFromThread({
      action: input.action,
      commandId: updateCommandId,
      sequence: dispatched.sequence,
      thread,
    });
  });

  return ThreadMetadataMcpService.of({ update });
});

export const layer: Layer.Layer<
  ThreadMetadataMcpService,
  never,
  Crypto.Crypto | ThreadManagementService.ThreadManagementService
> = Layer.effect(ThreadMetadataMcpService, make);
