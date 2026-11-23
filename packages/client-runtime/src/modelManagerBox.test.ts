import {
  MessageId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  modelManagerBoxView,
  modelManagerQuestionAnswers,
  modelManagerUserText,
  toggleModelManagerOption,
} from "./modelManagerBox.ts";
import { v2Now, v2Projection } from "./state/orchestrationV2TestFixtures.ts";

const reply = {
  threadId: v2Projection.thread.id,
  runId: RunId.make("models-run"),
  delivery: "started" as const,
};
function run(status: OrchestrationV2RunStatus) {
  return {
    id: reply.runId,
    threadId: reply.threadId,
    ordinal: 1,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("request"),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: v2Now,
    startedAt: v2Now,
    completedAt: status === "completed" ? v2Now : null,
    checkpointId: null,
    contextHandoffId: null,
  };
}
const baseItem = {
  id: TurnItemId.make("step"),
  threadId: reply.threadId,
  runId: reply.runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "running" as const,
  title: null,
  startedAt: v2Now,
  completedAt: null,
  updatedAt: v2Now,
};

describe("Models assistant box", () => {
  it("shows streaming replies and current work without tool output or prompt instructions", () => {
    const messages = ["Add vendor/model", "I am checking", "It works"].map((text, index) => ({
      id: MessageId.make(`message-${index}`),
      threadId: reply.threadId,
      runId: reply.runId,
      nodeId: null,
      role: index === 0 ? ("user" as const) : ("assistant" as const),
      text,
      streaming: index === 2,
      createdAt: v2Now,
      updatedAt: v2Now,
      attachments: [],
      createdBy: "user" as const,
      creationSource: "server" as const,
    }));
    const view = modelManagerBoxView(
      {
        ...v2Projection,
        messages,
        runs: [run("running")],
        turnItems: [
          {
            ...baseItem,
            type: "command_execution",
            input: "cat opencode.json",
            output: "large output",
          },
        ],
      },
      reply,
    );
    expect(view.messages.map((message) => message.text)).toEqual(["Add vendor/model", "It works"]);
    expect(view.activity).toBe("Running cat opencode.json");
    expect(
      modelManagerUserText(
        "Add vendor/model\n\nHarness: OpenCode (instance `opencode`, driver `opencode`).\nRead /state/PLAYBOOK.md first and follow it; SSHCode rewrites it for every request.",
      ),
    ).toBe("Add vendor/model");
    expect(modelManagerUserText("Keep my\n\nHarness: example")).toBe("Keep my\n\nHarness: example");
  });

  it.each(["completed", "failed", "interrupted", "cancelled"] as const)(
    "stops showing old activity when %s",
    (status) => {
      const view = modelManagerBoxView(
        {
          ...v2Projection,
          runs: [run(status)],
          turnItems: [{ ...baseItem, type: "file_change", fileName: "opencode.json" }],
        },
        reply,
      );
      expect(view.finished).toBe(true);
      expect(view.activity).toBeNull();
      expect(view.label).toContain(status === "completed" ? "Done" : "Stopped");
    },
  );

  it("keeps a queued request queued, then follows continuation runs after a question", () => {
    expect(modelManagerBoxView(null, { ...reply, delivery: "queued" }).status).toBe("queued");
    const next = { ...run("running"), id: RunId.make("answer-run"), ordinal: 2 };
    expect(
      modelManagerBoxView({ ...v2Projection, runs: [run("completed"), next] }, reply).status,
    ).toBe("running");
  });

  it("does not mistake an old completed run for a newly submitted request", () => {
    const projection = { ...v2Projection, runs: [run("completed")] };
    expect(
      modelManagerBoxView(projection, {
        ...reply,
        runId: RunId.make("new-run"),
        delivery: "queued",
      }).status,
    ).toBe("queued");
  });

  it("requires an explicit answer and preserves option ids, multiple selections and editable defaults", () => {
    const request = {
      requestId: RuntimeRequestId.make("question"),
      createdAt: "2026-06-20T00:00:00.000Z",
      responseCapability: "live" as const,
      dismissible: false,
      questions: [
        {
          id: "q",
          header: "Key",
          question: "Which?",
          multiSelect: true,
          allowCustomAnswer: false,
          options: [
            { label: "One", description: "", value: "one-id" },
            { label: "Two", description: "", value: "two-id" },
          ],
        },
      ],
    };
    expect(modelManagerQuestionAnswers(request, {}, {})).toBeNull();
    expect(toggleModelManagerOption(["one-id"], "two-id", true)).toEqual(["one-id", "two-id"]);
    expect(toggleModelManagerOption(["one-id"], "one-id", true)).toEqual([]);
    expect(
      modelManagerQuestionAnswers(request, { q: ["one-id", "two-id", "invalid"] }, {}),
    ).toEqual({ q: ["one-id", "two-id"] });
    expect(
      modelManagerQuestionAnswers(
        {
          ...request,
          questions: [
            {
              ...request.questions[0]!,
              multiSelect: false,
              allowCustomAnswer: true,
              initialAnswer: "default",
            },
          ],
        },
        {},
        { q: "" },
      ),
    ).toEqual({ q: "" });
  });
});
