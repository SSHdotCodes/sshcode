import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  NodeId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
const v2Now = DateTime.makeUnsafe("2026-06-20T00:00:00.000Z");
const providerInstanceId = ProviderInstanceId.make("opencode");
const threadId = ThreadId.make("models:saved");
const v2Projection: OrchestrationV2ThreadProjection = {
  thread: {
    id: threadId,
    projectId: ProjectId.make("models-project"),
    title: "Models",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "vendor/model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "server",
    createdAt: v2Now,
    updatedAt: v2Now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  runs: [],
  attempts: [],
  nodes: [],
  subagents: [],
  providerSessions: [],
  providerThreads: [],
  providerTurns: [],
  runtimeRequests: [],
  messages: [],
  plans: [],
  turnItems: [],
  checkpointScopes: [],
  checkpoints: [],
  contextHandoffs: [],
  contextTransfers: [],
  visibleTurnItems: [],
  updatedAt: v2Now,
};

export const modelManagerTestThreadId = ThreadId.make("models:saved");
export const modelManagerTestRequestId = RuntimeRequestId.make("models-question");
export function modelManagerTestProjection(
  status: OrchestrationV2RunStatus = "running",
): OrchestrationV2ThreadProjection {
  const runId = RunId.make("models-run");
  return {
    ...v2Projection,
    thread: { ...v2Projection.thread, id: modelManagerTestThreadId },
    runs: [
      {
        id: runId,
        threadId: modelManagerTestThreadId,
        ordinal: 1,
        providerInstanceId: v2Projection.thread.providerInstanceId,
        modelSelection: v2Projection.thread.modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("models-request"),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: v2Now,
        startedAt: v2Now,
        completedAt: status === "completed" ? v2Now : null,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: ["Add vendor/model", "Checking the config"].map((text, index) => ({
      id: MessageId.make(`models-${index}`),
      threadId: modelManagerTestThreadId,
      runId,
      nodeId: null,
      role: index === 0 ? "user" : "assistant",
      text,
      streaming: index === 1,
      createdAt: v2Now,
      updatedAt: v2Now,
      attachments: [],
      createdBy: "user",
      creationSource: "server",
    })),
    turnItems: [
      {
        id: TurnItemId.make("models-command"),
        threadId: modelManagerTestThreadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "running",
        title: null,
        startedAt: v2Now,
        completedAt: null,
        updatedAt: v2Now,
        type: "command_execution",
        input: "cat opencode.json",
      },
    ],
  };
}

export function modelManagerTestQuestion(): OrchestrationV2ThreadProjection {
  const projection = modelManagerTestProjection("completed");
  const command = projection.turnItems[0];
  if (command?.type !== "command_execution") throw new Error("Missing test command");
  return {
    ...projection,
    runtimeRequests: [
      {
        id: modelManagerTestRequestId,
        nodeId: NodeId.make("models-node"),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "message" },
        createdAt: v2Now,
        resolvedAt: null,
      },
    ],
    turnItems: [
      {
        ...command,
        type: "user_input_request",
        requestId: modelManagerTestRequestId,
        responseMode: "message",
        questions: [
          {
            id: "next",
            header: "Next",
            question: "Enable this model?",
            required: true,
            allowCustomAnswer: true,
            options: [{ label: "Enable", value: "enable-id", description: "Use this model" }],
          },
        ],
      },
    ],
  };
}
