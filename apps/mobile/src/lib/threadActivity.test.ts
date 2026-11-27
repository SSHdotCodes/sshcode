import {
  ContextHandoffId,
  MessageId,
  CheckpointId,
  CheckpointScopeId,
  RuntimeRequestId,
  NodeId,
  PlanId,
  ProviderInstanceId,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  RunAttemptId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { resolveUserMessagePresentation } from "@t3tools/client-runtime/user-message";
import { summarizeToolGroup } from "@t3tools/client-runtime/work-log/presentation";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  workEntryRowLabel,
  isContextHandoffActivityGroup,
  buildThreadFeed,
  deriveThreadFeedPresentation,
  filterDiscordThreadFeed,
  threadFeedActivityIsVisible,
  threadFeedRunIsUnsettled,
  type ThreadFeedActivity,
  type ThreadFeedEntry,
  togglePendingUserInputOptionSelection,
  setPendingUserInputCustomAnswer,
  isPendingUserInputOptionSelected,
  buildPendingUserInputAnswers,
} from "./threadActivity";
import { createStableThreadFeedProjector } from "./threadFeedProjection";

const threadId = ThreadId.make("thread-1");
const sourceThreadId = ThreadId.make("thread-source");
const runId = RunId.make("run-1");

it("keeps historical plan detail accessible from its paged turn item", () => {
  const item = {
    ...base("historical-plan", "2026-08-29T00:00:00.000Z", 1),
    type: "proposed_plan",
    planId: "plan-historical",
    markdown: "Full historical plan text",
    streaming: false,
  } as OrchestrationV2TurnItem;

  const entries = buildThreadFeed([projected(item, 0)]);
  const activity = entries.flatMap((entry) =>
    entry.type === "activity-group" ? entry.activities : [],
  )[0];
  expect(activity?.detail).toBe("Full historical plan text");
  expect(activity?.getFullDetail()).toContain("Full historical plan text");
});

it("shows only the structured path in expanded mobile read details", () => {
  const item: OrchestrationV2TurnItem = {
    ...base("read-detail", "2026-06-20T00:00:03.000Z", 2),
    type: "dynamic_tool",
    toolName: "Read",
    title: "Read src/env.ts",
    input: { path: "src/env.ts" },
    output: "---\nname: env\n---\nsecret content",
  };
  const activity = buildThreadFeed([projected(item, 0)]).flatMap((entry) =>
    entry.type === "activity-group" ? entry.activities : [],
  )[0];

  expect(activity?.getFullDetail()).toBe("src/env.ts");
  expect(activity?.canExpand).toBe(true);
  expect(activity?.getCopyText()).not.toContain("secret content");
  expect(activity?.getFullDetail()).not.toContain("sourceThreadId");

  const withoutPath = buildThreadFeed([
    projected({ ...item, id: TurnItemId.make("read-without-path"), input: {} }, 0),
  ]).flatMap((entry) => (entry.type === "activity-group" ? entry.activities : []))[0];
  expect(withoutPath?.getFullDetail()).toBeNull();
  expect(withoutPath?.canExpand).toBe(false);
});

it("expands a SSHCode notice to the prompt the agent got", () => {
  const item = {
    ...base("restart-notice", "2026-06-20T00:00:03.000Z", 2),
    type: "notification",
    source: { kind: "system" },
    outcome: "updated",
    summary: "SSHCode restarted and resumed this turn",
    detail: "Continue where you left off.",
  } as OrchestrationV2TurnItem;
  const [activity] = buildThreadFeed([projected(item, 0)]).flatMap((entry) =>
    entry.type === "activity-group" ? entry.activities : [],
  );

  expect(activity?.summary).toBe("SSHCode restarted and resumed this turn");
  expect(activity?.canExpand).toBe(true);
  expect(activity?.getFullDetail()).toBe("Continue where you left off.");
});

it("draws a saved secret's notice only as its card's row", () => {
  const card = {
    ...base("turn-item:secret-request:thread-1:modal-token", "2026-06-20T00:00:01.000Z", 1),
    type: "secret_request",
    label: "Modal token",
    reason: "Runs the GPU job",
    fields: [{ label: "Token ID" }, { label: "Token secret" }],
    secretStatus: "saved",
  } as OrchestrationV2TurnItem;
  // As stored: the notice row's id encodes the message the server sent the agent.
  const notice = {
    ...base(
      `turn-item:message:${encodeURIComponent(`message:secret-request-answer:${card.id}`)}`,
      "2026-06-20T00:00:03.000Z",
      2,
    ),
    type: "notification",
    source: { kind: "system" },
    outcome: "completed",
    summary: 'The user saved "Modal token".',
  } as OrchestrationV2TurnItem;
  const itemIds = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
    buildThreadFeed(items.map((item, index) => projected(item, index))).flatMap((entry) =>
      entry.type === "activity-group"
        ? entry.activities.map((activity) => activity.projectedItem.item.id)
        : [],
    );

  expect(itemIds([card, notice])).toEqual([card.id]);
  // Without its card in the feed, the notice is the only record and keeps its row.
  expect(itemIds([notice])).toEqual([notice.id]);
});

it("labels file searches with the adapter title and its search target", () => {
  const item: OrchestrationV2TurnItem = {
    ...base("file-search", "2026-06-20T00:00:03.000Z", 2),
    type: "file_search",
    title: "Searched TODO in web",
    pattern: "TODO",
  };
  const activity = buildThreadFeed([projected(item, 0)]).flatMap((entry) =>
    entry.type === "activity-group" ? entry.activities : [],
  )[0];

  expect(activity?.summary).toBe("Searched TODO in web");
  expect(activity ? workEntryRowLabel(activity.workEntry) : null).toBe("Searched TODO in web");
});

it("keeps approval prompts rather than presenting them as tool work", () => {
  const approval = (
    id: string,
    requestKind: "file-read" | "command" | "file-change",
    ordinal: number,
  ) =>
    ({
      ...base(id, `2026-06-20T00:00:0${ordinal}.000Z`, ordinal),
      type: "approval_request",
      requestId: RuntimeRequestId.make(`request-${id}`),
      requestKind,
      prompt: `Allow ${requestKind}?`,
    }) satisfies OrchestrationV2TurnItem;
  const feed = buildThreadFeed([
    projected(approval("approve-read", "file-read", 1), 0),
    projected(approval("approve-command", "command", 2), 1),
    projected(approval("approve-edit", "file-change", 3), 2),
  ]);
  const activities = feed.flatMap((entry) =>
    entry.type === "activity-group" ? entry.activities : [],
  );

  expect(activities.map((activity) => workEntryRowLabel(activity.workEntry))).toEqual([
    "Allow file-read?",
    "Allow command?",
    "Allow file-change?",
  ]);
  expect(activities[0]?.canExpand).toBe(true);
  expect(
    summarizeToolGroup(activities.slice(1).map((activity) => activity.workEntry)).summary,
  ).not.toMatch(/Ran|changed/);
});

function base(id: string, updatedAt: string, ordinal: number) {
  const timestamp = DateTime.makeUnsafe(updatedAt);
  return {
    id: TurnItemId.make(id),
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: timestamp,
    completedAt: timestamp,
    updatedAt: timestamp,
  };
}

function projected(
  item: OrchestrationV2TurnItem,
  position: number,
  visibility: OrchestrationV2ProjectedTurnItem["visibility"] = "local",
): OrchestrationV2ProjectedTurnItem {
  return {
    position,
    visibility,
    sourceThreadId: visibility === "local" ? threadId : sourceThreadId,
    sourceItemId: item.id,
    item,
  };
}

function userMessage(updatedAt = "2026-06-20T00:00:01.000Z") {
  return {
    ...base("item-user", updatedAt, 0),
    type: "user_message" as const,
    messageId: MessageId.make("message-user"),
    createdBy: "user" as const,
    creationSource: "mobile" as const,
    inputIntent: "turn_start" as const,
    text: "Run checks",
    attachments: [],
  };
}

it.each(["completed", "pending"] as const)(
  "keeps %s queued messages out of the feed only while they await delivery",
  (status) => {
    const item = { ...userMessage(), inputIntent: "queued_turn" as const, status };
    const feed = buildThreadFeed([projected(item, 0)]);
    expect(feed.filter((entry) => entry.type === "message")).toHaveLength(
      status === "pending" ? 0 : 1,
    );
  },
);

it("keeps a pending native steer visible in the feed", () => {
  const item = { ...userMessage(), inputIntent: "steer" as const, status: "pending" as const };
  expect(buildThreadFeed([projected(item, 0)])[0]).toMatchObject({
    type: "message",
    message: { id: item.messageId },
  });
});

it("marks a steer that reached a waiting agent", () => {
  const item = { ...userMessage(), inputIntent: "steer" as const, agentWasWaiting: true as const };
  expect(buildThreadFeed([projected(item, 0)])[0]).toMatchObject({
    type: "message",
    message: { inputIntent: "steer", agentWasWaiting: true },
  });
});

function command(updatedAt = "2026-06-20T00:00:02.000Z") {
  return {
    ...base("item-command", updatedAt, 1),
    type: "command_execution" as const,
    input: "vp check",
    output: "ok",
    exitCode: 0,
  };
}

function assistantMessage(updatedAt = "2026-06-20T00:00:03.000Z") {
  return {
    ...base("item-assistant", updatedAt, 2),
    type: "assistant_message" as const,
    messageId: MessageId.make("message-assistant"),
    text: "Done",
    streaming: false,
  };
}

describe("buildThreadFeed", () => {
  it("folds async answers into an answer row that carries the question", () => {
    const requestId = RuntimeRequestId.make("question");
    const question: OrchestrationV2TurnItem = {
      ...base("question", "2026-06-20T00:00:01.000Z", 0),
      type: "user_input_request",
      requestId,
      questions: [],
      questionAnswer: { requestId, answers: { color: "Blue" }, attachmentsByQuestionId: {} },
    };
    const reply: OrchestrationV2TurnItem = {
      ...userMessage(),
      id: TurnItemId.make("answer"),
      messageId: MessageId.make(`async-answer:${requestId}`),
    };
    const feed = buildThreadFeed([projected(question, 0), projected(reply, 1)]);
    expect(feed).toHaveLength(2);
    expect(feed[0]).toMatchObject({
      type: "activity-group",
      activities: [{ workEntry: { questionAnswer: question.questionAnswer } }],
    });
    // The answer keeps its place in the feed, carrying the question it answers.
    expect(feed[1]).toMatchObject({
      type: "message",
      message: { role: "user", questionAnswer: question.questionAnswer },
    });
    expect(buildThreadFeed([projected(reply, 0)])[0]?.type).toBe("message");
  });

  it("does not create a work group for a message and checkpoint", () => {
    const checkpoint: OrchestrationV2TurnItem = {
      ...base("checkpoint", "2026-06-20T00:00:04.000Z", 3),
      type: "checkpoint",
      checkpointId: CheckpointId.make("checkpoint"),
      scopeId: CheckpointScopeId.make("scope"),
      files: [],
    };
    const feed = buildThreadFeed([projected(assistantMessage(), 0), projected(checkpoint, 1)]);
    expect(feed.map((entry) => entry.type)).toEqual(["message"]);
  });

  it("omits cached tool output and patch bodies from expanded and copied activity", () => {
    const rawOutput = "RAW_TOOL_OUTPUT";
    const items: OrchestrationV2TurnItem[] = [
      { ...command(), output: rawOutput },
      {
        ...base("dynamic-output", "2026-06-20T00:00:03.000Z", 2),
        type: "dynamic_tool",
        toolName: "example",
        input: { query: "keep input" },
        output: { text: rawOutput },
      },
      {
        ...base("file-output", "2026-06-20T00:00:04.000Z", 3),
        type: "file_change",
        fileName: "src/example.ts",
        diffStr: rawOutput,
        oldStr: rawOutput,
        newStr: rawOutput,
      },
    ];
    const activities = buildThreadFeed(items.map((item, index) => projected(item, index))).flatMap(
      (entry) => (entry.type === "activity-group" ? entry.activities : []),
    );
    expect(activities).toHaveLength(3);
    for (const activity of activities) {
      expect(activity.workEntry.detail).toBeUndefined();
      expect(activity.getFullDetail()).not.toContain(rawOutput);
      expect(activity.getCopyText()).not.toContain(rawOutput);
    }
    expect(activities[0]?.detail).toBe("vp check");
    expect(activities[1]?.getFullDetail()).toContain("keep input");
    expect(activities[2]?.detail).toBe("src/example.ts");
    expect(items[0]).toMatchObject({ output: rawOutput });
  });

  it("expands tool rows only when they have detail or withheld output", () => {
    const items: OrchestrationV2TurnItem[] = [
      { ...command(), input: "", outputOmitted: true },
      {
        ...base("dynamic-empty", "2026-06-20T00:00:03.000Z", 2),
        type: "dynamic_tool",
        toolName: "example",
        input: {},
      },
      {
        ...base("read-omitted", "2026-06-20T00:00:04.000Z", 3),
        type: "dynamic_tool",
        toolName: "Read",
        input: { path: "src/env.ts" },
        outputOmitted: true,
      },
    ];
    const activities = buildThreadFeed(items.map((item, index) => projected(item, index))).flatMap(
      (entry) => (entry.type === "activity-group" ? entry.activities : []),
    );
    expect(
      activities.map(({ canExpand, fetchesDetail }) => ({ canExpand, fetchesDetail })),
    ).toEqual([
      { canExpand: true, fetchesDetail: true },
      { canExpand: false, fetchesDetail: false },
      { canExpand: true, fetchesDetail: true },
    ]);
  });

  it("recognizes automation attribution after projecting a user message", () => {
    const feed = buildThreadFeed([
      projected(
        {
          ...userMessage(),
          createdBy: "agent",
          creationSource: "server",
          scheduledTaskId: ScheduledTaskId.make("daily-audit"),
        },
        0,
      ),
    ]);
    const messageEntry = feed.find((entry) => entry.type === "message");

    expect(messageEntry).toBeDefined();
    expect(resolveUserMessagePresentation(messageEntry!.message)).toMatchObject({
      text: "Run checks",
      attribution: "automation",
    });
  });

  it("keeps the sender of an agent message distinct from its timeline source", () => {
    const feed = buildThreadFeed([
      projected(
        {
          ...userMessage(),
          createdBy: "agent",
          creationSource: "mcp",
          senderThreadId: sourceThreadId,
        },
        0,
      ),
    ]);
    const messageEntry = feed.find((entry) => entry.type === "message");
    expect(messageEntry?.message.senderThreadId).toBe(sourceThreadId);
    expect(messageEntry?.message.sourceThreadId).toBe(threadId);
  });

  it("anchors feedback before later committed turns", () => {
    const laterUser = {
      ...userMessage("2026-08-29T00:00:05.000Z"),
      id: TurnItemId.make("item-later-user"),
      messageId: MessageId.make("message-later-user"),
      ordinal: 2,
      text: "Later user turn",
    };
    const laterAssistant = {
      ...assistantMessage("2026-08-29T00:00:04.000Z"),
      id: TurnItemId.make("item-later-assistant"),
      messageId: MessageId.make("message-later-assistant"),
      ordinal: 3,
      text: "Later assistant turn",
    };
    const localMessage = (id: string, role: "user" | "assistant") => ({
      id: MessageId.make(id),
      role,
      text: id,
      turnId: null,
      streaming: false,
      createdAt: "2026-08-29T00:00:03.000Z",
      updatedAt: "2026-08-29T00:00:03.000Z",
    });
    const feed = buildThreadFeed(
      [
        projected(userMessage("2026-08-29T00:00:01.000Z"), 0),
        projected(laterUser, 1),
        projected(laterAssistant, 2),
      ],
      {
        anchoredMessages: [
          localMessage("feedback-user", "user"),
          localMessage("feedback-assistant", "assistant"),
          localMessage("message-later-user", "user"),
        ],
      },
    );
    const messages = feed.filter((entry) => entry.type === "message");

    expect(messages.map((entry) => entry.id)).toEqual([
      "message-user",
      "feedback-user",
      "feedback-assistant",
      "message-later-user",
      "message-later-assistant",
    ]);
    expect(
      messages
        .filter((entry) => entry.id.startsWith("feedback-"))
        .every((entry) => entry.message.projectedItem === undefined),
    ).toBe(true);
  });

  it("keeps prominent activity visible while it is running", () => {
    expect(
      threadFeedActivityIsVisible({ prominent: true, status: "neutral", toolLike: true }),
    ).toBe(true);
    expect(
      threadFeedActivityIsVisible({ prominent: false, status: "neutral", toolLike: true }),
    ).toBe(false);
  });

  it("keeps provider notices visible outside completed work folds without failure styling", () => {
    const message = "Safeguards flagged this message. Switched to Opus 4.8.";
    const item = {
      ...base("item-system-notice", "2026-06-20T00:00:02.000Z", 1),
      type: "system_notice" as const,
      message,
    };
    const feed = buildThreadFeed([projected(item, 0)]);
    const presented = deriveThreadFeedPresentation(feed, null, new Set());
    const activities = presented.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(activities).toHaveLength(1);
    expect(activities[0]).toMatchObject({
      summary: message,
      detail: message,
      prominent: true,
      toolLike: false,
      status: null,
      icon: "warning",
      workEntry: { tone: "info", itemType: "system_notice" },
    });
    expect(presented.some((entry) => entry.type === "run-fold")).toBe(false);
  });

  it("presents a usage-limit stop as a warning while preserving its explanation", () => {
    const message = "Plan usage limit reached. Try again after reset.";
    const entries = buildThreadFeed([
      projected(
        {
          ...base("item-limit", "2026-06-20T00:00:02.000Z", 1),
          type: "error",
          status: "failed",
          title: "Usage limit reached",
          failure: { class: "usage_limit", message, code: "usageLimitExceeded", retryable: null },
        },
        0,
      ),
    ]);
    const activity = entries.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    )[0];
    expect(activity).toMatchObject({
      summary: "Usage limit reached",
      status: "neutral",
      icon: "warning",
    });
    expect(activity?.getFullDetail()).toContain(message);
  });

  it("shows server automatic retry state and remaining attempts on mobile", () => {
    const item = {
      ...base("automatic-retry", "2026-06-20T00:00:02.000Z", 1),
      type: "error" as const,
      status: "failed" as const,
      title: "Provider error",
      failure: {
        class: "provider_error" as const,
        message: "At capacity",
        code: "serverOverloaded",
        retryable: true,
      },
      automaticProviderRetry: {
        attempt: 2,
        status: "scheduled" as const,
        scheduledAt: "2026-06-20T00:01:00.000Z",
      },
    };
    const feed = buildThreadFeed([projected(item, 0)]);
    const activity = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    )[0];
    expect(activity?.summary).toBe("Automatic provider retry (2/5)");
    expect(activity?.detail).toContain("3 automatic retries remain");
    expect(activity?.detail).not.toContain("2026-06-20T");
  });

  it.each(["transport_error", "usage_limit"] as const)(
    "presents %s retries and clears warning markers on recovery",
    (failureClass) => {
      const retryBase = {
        ...base("item-provider-retry", "2026-06-20T00:00:02.000Z", 1),
        type: "error" as const,
        failure: {
          class: failureClass,
          message: "The response stream disconnected.",
          code: "responseStreamDisconnected",
          retryable: true,
        },
        retry: {
          attempt: 2,
          maxAttempts: 5,
          retryDelayMs: null,
        },
      };
      const runningFeed = buildThreadFeed([
        projected(
          {
            ...retryBase,
            status: "running",
            title: "Provider retry",
            completedAt: null,
          },
          0,
        ),
      ]);
      const recoveredFeed = buildThreadFeed([
        projected(
          {
            ...retryBase,
            status: "completed",
            title: "Provider recovered",
          },
          0,
        ),
      ]);
      if (failureClass === "usage_limit") {
        const recoveredActivity = recoveredFeed.flatMap((entry) =>
          entry.type === "activity-group" ? entry.activities : [],
        )[0];
        expect(recoveredActivity).toMatchObject({ status: "success", icon: "check" });
      }
      const failedFeed = buildThreadFeed([
        projected(
          {
            ...retryBase,
            status: "failed",
            title: "Provider retry failed",
          },
          0,
        ),
        projected(command("2026-06-20T00:00:03.000Z"), 1),
      ]);
      const runningActivity = runningFeed.find((entry) => entry.type === "activity-group")
        ?.activities[0];
      const recoveredActivity = recoveredFeed.find((entry) => entry.type === "activity-group")
        ?.activities[0];
      if (runningActivity === undefined || recoveredActivity === undefined) {
        throw new Error("Expected provider retry work-log activities.");
      }

      expect(runningActivity).toMatchObject({
        summary: "Provider retry",
        status: "neutral",
        toolLike: false,
      });
      expect(threadFeedActivityIsVisible(runningActivity)).toBe(true);
      expect(recoveredActivity).toMatchObject({
        summary: "Provider recovered",
        status: "success",
        toolLike: false,
      });
      const failedPresentation = deriveThreadFeedPresentation(
        failedFeed,
        { runId, status: "running", startedAt: null, completedAt: null },
        new Set(),
      );
      expect(failedPresentation.map((entry) => entry.type)).toEqual([
        "activity-group",
        "activity-group",
      ]);
      expect(
        failedPresentation[0]?.type === "activity-group"
          ? failedPresentation[0].activities[0]?.summary
          : null,
      ).toBe("Provider retry failed");
    },
  );

  it.each(["pending", "running", "completed"] as const)(
    "shows %s task progress alongside adjacent conversation items",
    (stepStatus) => {
      const todoItem = {
        ...base("item-tasks", "2026-06-20T00:00:02.500Z", 2),
        type: "todo_list" as const,
        planId: PlanId.make("plan-tasks"),
        steps: [{ id: "step-1", text: "Verify the change", status: stepStatus }],
      } satisfies OrchestrationV2TurnItem;
      const user = projected(userMessage(), 0);
      const tool = projected(command(), 1);
      const assistant = projected(assistantMessage(), 3);

      const feed = buildThreadFeed([user, tool, projected(todoItem, 2), assistant]);
      expect(feed[0]?.type).toBe("message");
      expect(feed.at(-1)?.type).toBe("message");
      const presented = deriveThreadFeedPresentation(
        feed,
        { runId, status: "running", startedAt: null, completedAt: null },
        new Set(),
      );
      const plan = presented
        .flatMap((entry) => (entry.type === "activity-group" ? entry.activities : []))
        .find((activity) => activity.projectedItem.item.type === "todo_list");
      expect(plan).toMatchObject({
        summary: "Plan updated",
        detail: `${stepStatus === "completed" ? 1 : 0}/1 completed`,
        canExpand: true,
        projectedItem: { item: todoItem },
      });
      expect(workEntryRowLabel(plan!.workEntry)).toBe(
        `Plan · ${stepStatus === "completed" ? 1 : 0}/1 completed`,
      );
    },
  );

  it("hides synthetic workspace preparation activity", () => {
    const workspacePreparation = projected(
      {
        ...command(),
        title: "Workspace ready",
        input: "Preparing workspace",
        output: "Workspace preparation completed.",
      },
      0,
    );

    expect(buildThreadFeed([workspacePreparation])).toEqual([]);
  });

  it("does not treat a queued-only run as live feed activity", () => {
    expect(
      threadFeedRunIsUnsettled({
        runId,
        status: "queued",
        startedAt: null,
        completedAt: null,
      }),
    ).toBe(false);
    expect(
      threadFeedRunIsUnsettled({
        runId,
        status: "running",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: null,
      }),
    ).toBe(true);
    expect(
      threadFeedRunIsUnsettled({
        runId,
        status: "completed",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: null,
      }),
    ).toBe(true);
    expect(
      threadFeedRunIsUnsettled({
        runId,
        status: "waiting",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: null,
      }),
    ).toBe(true);
  });

  it("adds queued input only after dispatch creates its turn item", () => {
    const dispatchedRunId = RunId.make("run-dispatched-queued");
    const dispatchedMessageId = MessageId.make("message-dispatched-queued");
    expect(buildThreadFeed([])).toEqual([]);

    const promotedEntries = buildThreadFeed([
      projected(
        {
          ...userMessage(),
          id: TurnItemId.make("item-dispatched-queued"),
          runId: dispatchedRunId,
          messageId: dispatchedMessageId,
          inputIntent: "turn_start",
        },
        0,
      ),
    ]);
    expect(promotedEntries.map((entry) => entry.id)).toEqual([dispatchedMessageId]);
    expect(
      promotedEntries[0]?.type === "message" ? promotedEntries[0].message.inputIntent : undefined,
    ).toBe("turn_start");
  });

  it("hides the interruption request and keeps the terminal result", () => {
    const request = projected(
      {
        ...base("item-interrupt-request", "2026-06-20T00:00:02.000Z", 1),
        type: "run_interrupt_request",
        message: "Interrupt requested",
      },
      0,
    );
    const result = projected(
      {
        ...base("item-interrupt-result", "2026-06-20T00:00:03.000Z", 2),
        type: "run_interrupt_result",
        message: "Run interrupted before provider start",
      },
      1,
    );

    const activities = buildThreadFeed([request, result]).flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );

    expect(activities).toHaveLength(1);
    expect(activities[0]?.summary).toBe("Run interrupted");
    expect(activities[0]?.detail).toBe("Run interrupted before provider start");
    expect(
      deriveThreadFeedPresentation(
        buildThreadFeed([request, result]),
        {
          runId,
          status: "interrupted",
          startedAt: "2026-06-20T00:00:01.000Z",
          completedAt: "2026-06-20T00:00:03.000Z",
        },
        new Set(),
      ).some((entry) => entry.type === "run-fold"),
    ).toBe(false);
  });

  it("preserves authoritative V2 order instead of sorting reconstructed collections", () => {
    const rows = [
      projected(userMessage("2026-06-20T00:00:03.000Z"), 0),
      projected(command("2026-06-20T00:00:01.000Z"), 1),
      projected(assistantMessage("2026-06-20T00:00:02.000Z"), 2),
    ];

    const feed = buildThreadFeed(rows);
    expect(feed.map((entry) => entry.type)).toEqual(["message", "activity-group", "message"]);
    expect(feed.map((entry) => entry.id)).toEqual([
      "message-user",
      "local:thread-1:item-command",
      "message-assistant",
    ]);
    const activity = feed.find((entry) => entry.type === "activity-group")?.activities[0];
    expect(activity?.projectedItem).toBe(rows[1]);
    expect(activity?.getFullDetail()).toContain('"input": "vp check"');
  });

  it("keeps adjacent work from different V2 attempts in separate groups", () => {
    const firstRootNodeId = NodeId.make("node-attempt-1");
    const secondRootNodeId = NodeId.make("node-attempt-2");
    const firstCommand = { ...command(), nodeId: firstRootNodeId };
    const secondCommand = {
      ...command("2026-06-20T00:00:03.000Z"),
      id: TurnItemId.make("item-command-retry"),
      ordinal: 2,
      nodeId: secondRootNodeId,
    };
    const attempts = [
      {
        id: RunAttemptId.make("attempt-1"),
        runId,
        attemptOrdinal: 1,
        rootNodeId: firstRootNodeId,
        providerInstanceId: ProviderInstanceId.make("provider-instance-1"),
        providerThreadId: ProviderThreadId.make("provider-thread-1"),
        providerTurnId: null,
        reason: "initial",
        status: "completed",
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:01.000Z"),
        completedAt: DateTime.makeUnsafe("2026-06-20T00:00:02.000Z"),
      },
      {
        id: RunAttemptId.make("attempt-2"),
        runId,
        attemptOrdinal: 2,
        rootNodeId: secondRootNodeId,
        providerInstanceId: ProviderInstanceId.make("provider-instance-1"),
        providerThreadId: ProviderThreadId.make("provider-thread-1"),
        providerTurnId: null,
        reason: "retry",
        status: "completed",
        startedAt: DateTime.makeUnsafe("2026-06-20T00:00:02.000Z"),
        completedAt: DateTime.makeUnsafe("2026-06-20T00:00:03.000Z"),
      },
    ] satisfies ReadonlyArray<OrchestrationV2RunAttempt>;

    const childId = NodeId.make("node-in-retry");
    let nodeIndexReads = 0;
    const node = {
      get id() {
        nodeIndexReads++;
        return childId;
      },
      rootNodeId: secondRootNodeId,
      parentNodeId: secondRootNodeId,
      threadId,
      runId,
      kind: "tool_call" as const,
      status: "completed" as const,
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: attempts[1]!.startedAt,
      completedAt: attempts[1]!.completedAt,
    };
    const nodes = [node];
    const rows = [projected(firstCommand, 0), projected({ ...secondCommand, nodeId: childId }, 1)];
    const groups = (feed: ReadonlyArray<ThreadFeedEntry>) =>
      feed.map((entry) =>
        entry.type === "activity-group" ? entry.activities[0]?.attemptId : null,
      );
    expect(groups(buildThreadFeed(rows, { attempts, nodes }))).toEqual(["attempt-1", "attempt-2"]);
    expect(nodeIndexReads).toBe(1);
    const appended = [...rows, projected(assistantMessage(), 2)];
    expect(groups(buildThreadFeed(appended, { attempts, nodes }))).toEqual([
      "attempt-1",
      "attempt-2",
      null,
    ]);
    expect(nodeIndexReads).toBe(1);
    expect(
      groups(
        buildThreadFeed(rows, { attempts, nodes: [{ ...node, rootNodeId: firstRootNodeId }] }),
      ),
    ).toEqual(["attempt-1"]);
  });

  it("retains inherited and synthetic rows with their original projected identity", () => {
    const inherited = projected(command(), 0, "inherited");
    const { providerThreadId: _providerThreadId, ...forkBase } = base(
      "item-fork",
      "2026-06-20T00:00:03.000Z",
      2,
    );
    const synthetic = projected(
      {
        ...forkBase,
        type: "fork",
        source: { type: "run", threadId: sourceThreadId, runId },
        targetThreadId: threadId,
      },
      1,
      "synthetic",
    );

    const feed = buildThreadFeed([inherited, synthetic]);
    const activities = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(activities.map((activity) => activity.projectedItem)).toEqual([inherited, synthetic]);
    expect(activities.map((activity) => activity.projectedItem.visibility)).toEqual([
      "inherited",
      "synthetic",
    ]);
    expect(activities.at(-1)?.prominent).toBe(true);
  });

  it("keeps orchestration relationship cards visible when a completed run is folded", () => {
    const { providerThreadId: _providerThreadId, ...forkBase } = base(
      "item-fork",
      "2026-06-20T00:00:02.500Z",
      2,
    );
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(command(), 1),
      projected(
        {
          ...forkBase,
          type: "fork",
          source: { type: "run", threadId, runId },
          targetThreadId: sourceThreadId,
        },
        2,
      ),
      projected(assistantMessage(), 3),
    ]);

    const collapsed = deriveThreadFeedPresentation(
      feed,
      {
        runId,
        status: "completed",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: "2026-06-20T00:00:03.000Z",
      },
      new Set(),
    );

    expect(
      collapsed.some(
        (entry) =>
          entry.type === "activity-group" &&
          entry.activities.some((activity) => activity.projectedItem.item.type === "fork"),
      ),
    ).toBe(true);
    expect(
      collapsed.some(
        (entry) =>
          entry.type === "activity-group" &&
          entry.activities.some(
            (activity) => activity.projectedItem.item.type === "command_execution",
          ),
      ),
    ).toBe(false);
  });

  it.each([true, false])("keeps prose between consecutive tool groups, working=%s", (isWorking) => {
    const opening = {
      ...assistantMessage("2026-06-20T00:00:01.500Z"),
      id: TurnItemId.make("item-opening"),
      messageId: MessageId.make("message-opening"),
      text: "Found it",
    };
    const middle = {
      ...assistantMessage("2026-06-20T00:00:02.500Z"),
      id: TurnItemId.make("item-middle"),
      messageId: MessageId.make("message-middle"),
      text: "Fixed",
    };
    const feed = buildThreadFeed(
      [
        userMessage(),
        opening,
        command(),
        { ...command(), id: TurnItemId.make("tool-2") },
        middle,
        { ...command(), id: TurnItemId.make("tool-3") },
        { ...command(), id: TurnItemId.make("tool-4") },
        {
          ...base("thinking", "2026-06-20T00:00:02.900Z", 7),
          type: "reasoning" as const,
          text: "Private reasoning",
          streaming: false,
        },
        { ...assistantMessage(), text: "Sprites pricing", streaming: isWorking },
      ].map((item, index) => projected(item, index)),
    );
    const latestRun = {
      runId,
      status: isWorking ? ("running" as const) : ("completed" as const),
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: isWorking ? null : "2026-06-20T00:00:03.000Z",
    };
    const presented = deriveThreadFeedPresentation(
      feed,
      latestRun,
      new Set(),
      new Set(),
      isWorking ? latestRun.startedAt : null,
    );
    expect(presented.filter((entry) => entry.type !== "thinking").map((entry) => entry.id)).toEqual(
      [
        "message-user",
        "message-opening",
        "work-toggle:work-group:local:thread-1:item-command",
        "message-middle",
        "work-toggle:work-group:local:thread-1:tool-3",
        "message-assistant",
      ],
    );
    expect(presented.filter((entry) => entry.type === "work-toggle")).toMatchObject([
      { hiddenCount: 2, expanded: false },
      { hiddenCount: 2, expanded: false },
    ]);
    expect(
      presented.filter((entry) => entry.type === "message").map((entry) => entry.message.text),
    ).toEqual(["Run checks", "Found it", "Fixed", "Sprites pricing"]);
  });

  it("keeps an opening message visible without tool work, like web", () => {
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(
        {
          ...assistantMessage("2026-06-20T00:00:02.000Z"),
          id: TurnItemId.make("item-opening"),
          messageId: MessageId.make("message-opening"),
          text: "The result is ready.",
        },
        1,
      ),
      projected(assistantMessage(), 2),
    ]);

    const presented = deriveThreadFeedPresentation(feed, null, new Set());
    expect(presented.map((entry) => entry.id)).toEqual([
      "message-user",
      "message-opening",
      "message-assistant",
    ]);
  });

  it("folds subagents while keeping created-thread and fork cards visible", () => {
    const { providerThreadId: _providerThreadId, ...forkBase } = base(
      "item-fork",
      "2026-06-20T00:00:02.000Z",
      2,
    );
    const resourceItems = [
      {
        ...base("item-subagent", "2026-06-20T00:00:01.500Z", 1),
        type: "subagent",
        subagentId: NodeId.make("child-agent"),
        origin: "app_owned",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        childThreadId: sourceThreadId,
        prompt: "Inspect the deployment configuration",
        result: "Configuration is valid",
      },
      {
        ...forkBase,
        type: "fork",
        source: { type: "run", threadId, runId },
        targetThreadId: sourceThreadId,
      },
      {
        ...base("item-created-thread", "2026-06-20T00:00:04.000Z", 4),
        type: "thread_created",
        targetThreadId: sourceThreadId,
        targetRunId: null,
        targetProviderInstanceId: ProviderInstanceId.make("codex"),
        targetModel: "gpt-5.4",
      },
    ] satisfies ReadonlyArray<OrchestrationV2TurnItem>;
    const projectedResources = [
      projected(resourceItems[0]!, 1),
      projected(resourceItems[1]!, 2),
      projected(resourceItems[2]!, 4),
    ];
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projectedResources[0]!,
      projectedResources[1]!,
      projected(command("2026-06-20T00:00:03.000Z"), 3),
      projectedResources[2]!,
      projected(assistantMessage("2026-06-20T00:00:05.000Z"), 5),
    ]);

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    expect(collapsed.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "activity-group",
      "activity-group",
      "message",
    ]);
    expect(collapsed[1]).toMatchObject({
      type: "run-fold",
      createdAt: "2026-06-20T00:00:01.500Z",
    });
    expect(
      collapsed.flatMap((entry) =>
        entry.type === "activity-group"
          ? entry.activities.map((activity) => activity.projectedItem)
          : [],
      ),
    ).toEqual(projectedResources.slice(1));
    const expanded = deriveThreadFeedPresentation(feed, null, new Set([runId]));
    expect(
      expanded.some(
        (entry) =>
          entry.type === "activity-group" &&
          entry.activities.some((activity) => activity.projectedItem.item.type === "subagent"),
      ),
    ).toBe(true);
  });

  it("keeps a settled run's still-running subagents visible while its other work folds", () => {
    const subagent = (
      id: string,
      updatedAt: string,
      ordinal: number,
      status: OrchestrationV2TurnItem["status"],
    ): OrchestrationV2TurnItem => ({
      ...base(id, updatedAt, ordinal),
      providerTurnId: ProviderTurnId.make("provider-turn-1"),
      status,
      completedAt: status === "running" ? null : DateTime.makeUnsafe(updatedAt),
      type: "subagent",
      subagentId: NodeId.make(id),
      origin: "app_owned",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: sourceThreadId,
      prompt: `Inspect ${id}`,
      result: null,
    });
    const latestRun = {
      runId,
      status: "completed" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:05.000Z",
    };
    const present = (children: ReadonlyArray<OrchestrationV2TurnItem>) =>
      deriveThreadFeedPresentation(
        buildThreadFeed([
          projected(userMessage(), 0),
          projected(command("2026-06-20T00:00:02.000Z"), 1),
          ...children.map((child, index) => projected(child, index + 2)),
          projected(assistantMessage("2026-06-20T00:00:05.000Z"), 5),
        ]),
        latestRun,
        new Set(),
      );
    const visibleSubagentIds = (presented: ReadonlyArray<ThreadFeedEntry>) =>
      presented.flatMap((entry) =>
        entry.type === "activity-group"
          ? entry.activities.flatMap((activity) =>
              activity.projectedItem.item.type === "subagent"
                ? [activity.projectedItem.item.id]
                : [],
            )
          : [],
      );

    const live = present([subagent("item-live", "2026-06-20T00:00:03.000Z", 2, "running")]);
    expect(live.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "activity-group",
      "message",
    ]);
    expect(visibleSubagentIds(live)).toEqual(["item-live"]);

    // A launch batch stays whole while any member is live.
    const mixed = present([
      subagent("item-done", "2026-06-20T00:00:03.000Z", 2, "completed"),
      subagent("item-live", "2026-06-20T00:00:04.000Z", 3, "running"),
    ]);
    expect(visibleSubagentIds(mixed)).toEqual(["item-done", "item-live"]);

    const finished = present([subagent("item-done", "2026-06-20T00:00:03.000Z", 2, "completed")]);
    expect(finished.map((entry) => entry.type)).toEqual(["message", "run-fold", "message"]);
  });

  it("folds settled V2 run work while keeping the terminal assistant message visible", () => {
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(command(), 1),
      projected(assistantMessage(), 2),
    ]);
    const latestRun = {
      runId,
      status: "completed" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:03.000Z",
    };

    const collapsed = deriveThreadFeedPresentation(feed, latestRun, new Set());
    expect(collapsed.map((entry) => entry.type)).toEqual(["message", "run-fold", "message"]);

    const expanded = deriveThreadFeedPresentation(feed, latestRun, new Set([runId]));
    expect(expanded.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "work-toggle",
      "message",
    ]);
  });

  it("uses run timestamps for the latest turn, even when its message ends earlier", () => {
    const feed = buildThreadFeed([
      projected(userMessage("2026-06-20T00:00:00.000Z"), 0),
      projected(command("2026-06-20T00:00:00.100Z"), 1),
      projected(assistantMessage("2026-06-20T00:00:00.318Z"), 2),
    ]);
    const entries = deriveThreadFeedPresentation(
      feed,
      {
        runId,
        status: "completed",
        startedAt: "2026-06-20T00:00:00.000Z",
        completedAt: "2026-06-20T00:00:00.341Z",
      },
      new Set(),
    );
    expect(entries.find((entry) => entry.type === "run-fold")?.label).toBe("Worked for 341ms");
  });

  it("keeps earlier runs' timings, stopped labels, and failed unfolding after a newer run starts", () => {
    const run2 = RunId.make("run-2");
    const run3 = RunId.make("run-3");
    const run4 = RunId.make("run-4");
    const feed = buildThreadFeed([
      projected(userMessage("2026-06-20T00:00:00.000Z"), 0),
      projected(command("2026-06-20T00:05:00.050Z"), 1),
      projected(assistantMessage("2026-06-20T00:05:00.198Z"), 2),
      projected(
        {
          ...userMessage("2026-06-20T00:06:00.000Z"),
          id: TurnItemId.make("u-2"),
          runId: run2,
          messageId: MessageId.make("m-u2"),
        },
        3,
      ),
      projected(
        { ...command("2026-06-20T00:06:05.000Z"), id: TurnItemId.make("c-2"), runId: run2 },
        4,
      ),
      projected(
        {
          ...userMessage("2026-06-20T00:07:00.000Z"),
          id: TurnItemId.make("u-3"),
          runId: run3,
          messageId: MessageId.make("m-u3"),
        },
        5,
      ),
      projected(
        { ...command("2026-06-20T00:07:02.000Z"), id: TurnItemId.make("c-3"), runId: run3 },
        6,
      ),
    ]);
    const entries = deriveThreadFeedPresentation(
      feed,
      {
        runId: run4,
        status: "running",
        startedAt: "2026-06-20T00:08:00.000Z",
        completedAt: null,
      },
      new Set(),
      new Set(),
      "2026-06-20T00:08:00.000Z",
      false,
      [
        {
          id: runId,
          status: "completed",
          startedAt: DateTime.makeUnsafe("2026-06-20T00:05:00.000Z"),
          completedAt: DateTime.makeUnsafe("2026-06-20T00:05:00.198Z"),
        },
        {
          id: run2,
          status: "interrupted",
          startedAt: DateTime.makeUnsafe("2026-06-20T00:06:00.000Z"),
          completedAt: DateTime.makeUnsafe("2026-06-20T00:06:47.000Z"),
        },
        {
          id: run3,
          status: "failed",
          startedAt: DateTime.makeUnsafe("2026-06-20T00:07:00.000Z"),
          completedAt: DateTime.makeUnsafe("2026-06-20T00:07:03.000Z"),
        },
      ],
    );
    const folds = entries.filter((entry) => entry.type === "run-fold");
    expect(folds).toEqual([
      expect.objectContaining({ runId, label: "Worked for 198ms" }),
      expect.objectContaining({ runId: run2, label: "You stopped after 47s" }),
    ]);
  });

  it("uses the last work entry rather than the start of a grouped historical turn", () => {
    const first = command("2026-06-20T00:00:00.318Z");
    const last = { ...command("2026-06-20T00:00:00.341Z"), id: TurnItemId.make("last-work") };
    const feed = buildThreadFeed([
      projected(userMessage("2026-06-20T00:00:00.000Z"), 0),
      projected(first, 1),
      projected(last, 2),
    ]);
    expect(feed.filter((entry) => entry.type === "activity-group")).toHaveLength(1);
    const entries = deriveThreadFeedPresentation(feed, null, new Set());
    expect(entries.find((entry) => entry.type === "run-fold")?.label).toBe("Worked for 341ms");
  });

  it("keeps an active run expanded and detects failures from completed command output", () => {
    const failedCommand: OrchestrationV2TurnItem = {
      ...command(),
      output: "sh: missing-command: command not found",
    };
    const feed = buildThreadFeed([projected(userMessage(), 0), projected(failedCommand, 1)]);
    const presented = deriveThreadFeedPresentation(
      feed,
      {
        runId,
        status: "running",
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: null,
      },
      new Set(),
    );

    expect(presented.some((entry) => entry.type === "run-fold")).toBe(false);
    expect(presented.find((entry) => entry.type === "work-toggle")).toMatchObject({
      summary: "vp check",
      hiddenCount: 1,
      hasFailure: true,
      live: false,
    });
  });

  it("folds each run of a provider-native subagent thread like a normal turn", () => {
    // A Claude subagent's child thread, as projected: no runs, and a user
    // prompt for the launch and for a SendMessage resume.
    const runless = <T extends OrchestrationV2TurnItem>(item: T, id: string, ordinal: number) => ({
      ...item,
      id: TurnItemId.make(id),
      runId: null,
      ordinal,
    });
    const prompt = (id: string, ordinal: number, at: string) =>
      runless(
        { ...userMessage(at), messageId: MessageId.make(id), creationSource: "provider" as const },
        id,
        ordinal,
      );
    const answer = (id: string, ordinal: number, at: string) =>
      runless({ ...assistantMessage(at), messageId: MessageId.make(id) }, id, ordinal);
    const { exitCode: _exitCode, ...completedCommand } = command("2026-06-20T00:01:17.000Z");
    const feed = (resumeRunning: boolean) =>
      buildThreadFeed(
        [
          prompt("launch", 1, "2026-06-20T00:00:00.000Z"),
          runless(command("2026-06-20T00:00:04.000Z"), "launch-ls", 2),
          answer("launch-answer", 3, "2026-06-20T00:00:08.000Z"),
          prompt("resume", 4, "2026-06-20T00:01:12.000Z"),
          resumeRunning
            ? runless(
                { ...completedCommand, status: "running", completedAt: null, output: "" },
                "resume-ls",
                5,
              )
            : runless(command("2026-06-20T00:01:17.000Z"), "resume-ls", 5),
          ...(resumeRunning ? [] : [answer("resume-answer", 6, "2026-06-20T00:01:20.000Z")]),
        ].map((item, position) => projected(item, position)),
      );
    const shape = (entries: ReadonlyArray<ThreadFeedEntry>) =>
      entries.map((entry) =>
        entry.type === "run-fold"
          ? `fold:${entry.label}`
          : entry.type === "message"
            ? `${entry.message.role}:${entry.message.id}`
            : entry.type,
      );

    const settled = deriveThreadFeedPresentation(feed(false), null, new Set());
    expect(shape(settled)).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8.0s",
      "assistant:resume-answer",
    ]);
    const launchFold = settled.find((entry) => entry.type === "run-fold");
    if (launchFold?.type !== "run-fold") throw new Error("Expected the launch fold");
    expect(
      shape(deriveThreadFeedPresentation(feed(false), null, new Set([launchFold.runId]))),
    ).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "work-toggle",
      "assistant:launch-answer",
      "user:resume",
      "fold:Worked for 8.0s",
      "assistant:resume-answer",
    ]);

    // While the resume runs, only the settled launch folds.
    expect(
      shape(
        deriveThreadFeedPresentation(
          feed(true),
          null,
          new Set(),
          new Set(),
          "2026-06-20T00:01:12.000Z",
          true,
        ),
      ),
    ).toEqual([
      "user:launch",
      "fold:Worked for 8.0s",
      "assistant:launch-answer",
      "user:resume",
      "work-toggle",
    ]);
  });

  it("keeps imported V1 prose visible once the thread's first V2 run starts", () => {
    const imported = <T extends OrchestrationV2TurnItem>(item: T, id: string) => ({
      ...item,
      id: TurnItemId.make(id),
      runId: null,
    });
    const presented = (start: OrchestrationV2TurnItem) =>
      deriveThreadFeedPresentation(
        buildThreadFeed(
          [
            imported(userMessage("2026-06-20T00:00:00.000Z"), "imported-prompt"),
            imported(
              {
                ...assistantMessage("2026-06-20T00:00:02.000Z"),
                messageId: MessageId.make("update"),
              },
              "imported-update",
            ),
            imported(command("2026-06-20T00:00:04.000Z"), "imported-ls"),
            imported(
              {
                ...assistantMessage("2026-06-20T00:00:08.000Z"),
                messageId: MessageId.make("answer"),
              },
              "imported-answer",
            ),
            start,
          ].map((item, position) => projected(item, position)),
        ),
        { runId, status: "running", startedAt: "2026-06-20T00:01:00.000Z", completedAt: null },
        new Set(),
        new Set(),
        "2026-06-20T00:01:00.000Z",
      )
        .slice(0, 4)
        .map((entry) => (entry.type === "message" ? entry.message.role : entry.type));

    // A sent prompt and an automatic wake both start V2 work below the import.
    expect(
      presented({
        ...userMessage("2026-06-20T00:01:00.000Z"),
        id: TurnItemId.make("new-prompt"),
        messageId: MessageId.make("new-prompt"),
      }),
    ).toEqual(["user", "assistant", "work-toggle", "assistant"]);
    expect(
      presented({
        ...base("wake", "2026-06-20T00:01:00.000Z", 4),
        type: "notification",
        source: { kind: "background_task" },
        outcome: "completed",
        summary: "Background task finished",
      }),
    ).toEqual(["user", "assistant", "work-toggle", "assistant"]);
  });

  it("keeps a provider-native subagent's runless tool call live while it works", () => {
    const startedAt = "2026-06-20T00:00:01.000Z";
    const { exitCode: _exitCode, ...completedCommand } = command();
    const runningCommand: OrchestrationV2TurnItem = {
      ...completedCommand,
      runId: null,
      status: "running",
      completedAt: null,
      output: "",
    };
    const feed = buildThreadFeed([
      projected({ ...userMessage(), runId: null }, 0),
      projected(runningCommand, 1),
    ]);

    const presented = deriveThreadFeedPresentation(
      feed,
      null,
      new Set(),
      new Set(),
      startedAt,
      true,
    );
    expect(presented.find((entry) => entry.type === "work-toggle")).toMatchObject({
      summary: "Running vp…",
      live: true,
      shimmer: true,
    });
    expect(presented.some((entry) => entry.type === "thinking")).toBe(false);
  });

  it("keeps the newest running tool in the live slot below later text", () => {
    const startedAt = "2026-06-20T00:00:01.000Z";
    const run = { runId, status: "running" as const, startedAt, completedAt: null };
    const stabilize = createStableThreadFeedProjector<ThreadFeedEntry>();
    const tool = (program: string, at: string, running: boolean) => ({
      ...command(at),
      id: TurnItemId.make(program),
      input: program,
      status: running ? ("running" as const) : ("completed" as const),
      completedAt: running ? null : DateTime.makeUnsafe(at),
      exitCode: running ? undefined : 0,
    });
    const present = (sshRunning: boolean, gitRunning: boolean) =>
      stabilize(
        deriveThreadFeedPresentation(
          buildThreadFeed([
            projected(userMessage(), 0),
            projected(tool("git", "2026-06-20T00:00:03.000Z", gitRunning), 1),
            projected(tool("ssh", "2026-06-20T00:00:02.000Z", sshRunning), 2),
            projected(assistantMessage("2026-06-20T00:00:04.000Z"), 3),
          ]),
          run,
          new Set(),
          new Set(),
          startedAt,
        ),
      );

    const running = present(true, true);
    expect(running.map((entry) => entry.type)).toEqual([
      "message",
      "work-toggle",
      "message",
      "thinking",
    ]);
    expect(running[1]).toMatchObject({ type: "work-toggle", shimmer: false });
    expect(running.at(-1)).toMatchObject({
      id: "live-activity-row",
      label: "Running git…",
      shimmer: true,
    });
    // The group's live header already names ssh, so the tail doesn't repeat it.
    const sshOnly = present(true, false);
    expect(sshOnly.map((entry) => entry.type)).toEqual(["message", "work-toggle", "message"]);
    expect(sshOnly[1]).toMatchObject({ type: "work-toggle", summary: "Running ssh" });
    expect(present(false, false).at(-1)).toEqual({
      type: "thinking",
      id: "live-activity-row",
      createdAt: startedAt,
      runId,
      label: "Thinking…",
    });
  });

  it("doesn't repeat a running tool at the tail when its own row already names it", () => {
    const startedAt = "2026-06-20T00:00:01.000Z";
    const run = { runId, status: "running" as const, startedAt, completedAt: null };
    const ssh = {
      ...command("2026-06-20T00:00:02.000Z"),
      id: TurnItemId.make("ssh"),
      input: "ssh",
      status: "running" as const,
      completedAt: null,
      exitCode: undefined,
    };
    const presented = deriveThreadFeedPresentation(
      buildThreadFeed([
        projected(userMessage(), 0),
        projected(ssh, 1),
        projected(assistantMessage("2026-06-20T00:00:04.000Z"), 2),
      ]),
      run,
      new Set(),
      new Set(),
      startedAt,
    );
    expect(presented.map((entry) => entry.type)).toEqual(["message", "work-toggle", "message"]);
    expect(presented[1]).toMatchObject({ summary: "Running ssh" });

    // A thought in the same group still leaves the header naming the one tool.
    const withThought = deriveThreadFeedPresentation(
      buildThreadFeed([
        projected(userMessage(), 0),
        projected(
          {
            ...base("thought", "2026-06-20T00:00:01.500Z", 1),
            type: "reasoning" as const,
            text: "Loading the model",
            streaming: false,
          },
          1,
        ),
        projected(ssh, 2),
        projected(assistantMessage("2026-06-20T00:00:04.000Z"), 3),
      ]),
      run,
      new Set(),
      new Set(),
      startedAt,
    );
    expect(withThought.some((entry) => entry.type === "thinking")).toBe(false);

    // A steer sent mid-turn sits below a group of several tools whose live header names
    // the running one: the tail adds no second line for it.
    const steered = deriveThreadFeedPresentation(
      buildThreadFeed([
        projected(userMessage(), 0),
        projected(command("2026-06-20T00:00:01.500Z"), 1),
        projected(ssh, 2),
        projected(
          {
            ...userMessage("2026-06-20T00:00:03.000Z"),
            id: TurnItemId.make("item-steer"),
            messageId: MessageId.make("message-steer"),
            inputIntent: "steer" as const,
            text: "Also check the other one",
          },
          3,
        ),
      ]),
      run,
      new Set(),
      new Set(),
      startedAt,
    );
    expect(steered.some((entry) => entry.type === "thinking")).toBe(false);
    expect(steered.find((entry) => entry.type === "work-toggle")).toMatchObject({
      summary: "Running ssh",
    });
  });

  it("keeps a runless tail folded while a normal thread waits for its sent run", () => {
    // Right after a send the local clock runs before the server creates the
    // run, and the latest run may still be queued: neither is runless work,
    // so the settled tail must not reopen and shift the feed.
    const startedAt = "2026-06-20T00:00:05.000Z";
    const feed = buildThreadFeed([
      projected({ ...userMessage(), runId: null }, 0),
      projected({ ...command(), runId: null }, 1),
    ]);
    for (const latestRun of [
      null,
      { runId, status: "queued" as const, startedAt: null, completedAt: null },
    ]) {
      const presented = deriveThreadFeedPresentation(
        feed,
        latestRun,
        new Set(),
        new Set(),
        startedAt,
      );
      expect(presented.map((entry) => entry.type)).toEqual(["message", "run-fold", "thinking"]);
    }
  });

  it("waits for workspace preparation before showing provider activity", () => {
    const startedAt = "2026-04-01T00:00:01.000Z";
    const run = { runId, status: "preparing" as const, startedAt: null, completedAt: null };
    expect(deriveThreadFeedPresentation([], run, new Set(), new Set(), startedAt)).toEqual([]);
    expect(
      deriveThreadFeedPresentation(
        [],
        { ...run, status: "running", startedAt },
        new Set(),
        new Set(),
        startedAt,
      ),
    ).toEqual([
      {
        type: "thinking",
        id: "live-activity-row",
        createdAt: startedAt,
        runId,
        label: "Thinking…",
      },
    ]);
  });

  it("uses a stable Thinking row while work has started without a projected item", () => {
    const startedAt = "2026-04-01T00:00:01.000Z";
    const presented = deriveThreadFeedPresentation([], null, new Set(), new Set(), startedAt);

    expect(presented).toEqual([
      {
        type: "thinking",
        id: "live-activity-row",
        createdAt: startedAt,
        runId: null,
        label: "Thinking…",
      },
    ]);
    expect(deriveThreadFeedPresentation([], null, new Set(), new Set(), startedAt)[0]).toBe(
      presented[0],
    );
  });

  it("keeps expanded work in one group with stable row identities", () => {
    const activity = (
      id: string,
      createdAt: string,
      status: ThreadFeedActivity["status"] = "success",
    ): ThreadFeedActivity => ({
      id,
      createdAt,
      runId: null,
      attemptId: null,
      summary: `Tool ${id}`,
      detail: null,
      canExpand: false,
      fetchesDetail: false,
      getFullDetail: () => null,
      getCopyText: () => id,
      icon: "command",
      logo: null,
      toolLike: true,
      prominent: false,
      status,
      lifecycleStatus: status === "neutral" ? "inProgress" : "completed",
      workEntry: {
        id,
        createdAt,
        label: `Tool ${id}`,
        tone: "tool",
        command: "vp check",
        itemType: "command_execution",
        toolLifecycleStatus: status === "neutral" ? "inProgress" : "completed",
      },
      projectedItem: projected(command(createdAt), 0),
    });
    const feed: ThreadFeedEntry[] = [
      {
        type: "activity-group",
        id: "work-group-1",
        createdAt: "2026-04-01T00:00:01.000Z",
        runId: null,
        activities: [
          activity("activity-neutral", "2026-04-01T00:00:01.000Z", "neutral"),
          activity("activity-1", "2026-04-01T00:00:02.000Z"),
          activity("activity-2", "2026-04-01T00:00:03.000Z"),
          activity("activity-3", "2026-04-01T00:00:04.000Z"),
        ],
      },
    ];

    const collapsed = deriveThreadFeedPresentation(feed, null, new Set());
    expect(collapsed.map((entry) => entry.id)).toEqual(["work-toggle:work-group:activity-neutral"]);
    expect(collapsed[0]).toMatchObject({
      type: "work-toggle",
      groupId: "work-group:activity-neutral",
      hiddenCount: 3,
      expanded: false,
      summary: "Ran 3 commands",
    });

    const expanded = deriveThreadFeedPresentation(
      feed,
      null,
      new Set(),
      new Set(["work-group:activity-neutral"]),
    );
    expect(expanded.map((entry) => entry.id)).toEqual([
      "work-toggle:work-group:activity-neutral",
      "work-details:work-group:activity-neutral",
    ]);
    expect(expanded[0]).toMatchObject({
      type: "work-toggle",
      expanded: true,
    });
    expect(expanded[1]).toMatchObject({
      type: "activity-group",
      activities: [
        { id: "activity-1", groupedToolDetail: true, live: false },
        { id: "activity-2", groupedToolDetail: true, live: false },
        { id: "activity-3", groupedToolDetail: true, live: false },
      ],
    });
  });

  it("retains Claude Read image previews without tool output", () => {
    const item = {
      ...base("image-read", "2026-06-20T00:00:04.000Z", 3),
      type: "dynamic_tool" as const,
      toolName: "Read",
      input: { file_path: "/workspace/reference.png" },
      viewedImagePath: "/workspace/reference.png",
    } satisfies OrchestrationV2TurnItem;
    const feed = buildThreadFeed([projected(item, 0)]);
    const activity = feed[0]?.type === "activity-group" ? feed[0].activities[0] : null;
    expect(activity?.workEntry.viewedImagePath).toBe("/workspace/reference.png");
  });

  it("pretty prints T3 MCP dynamic tool activities and attaches the product logo", () => {
    const toolItem: OrchestrationV2TurnItem = {
      ...base("item-t3-tool", "2026-06-20T00:00:04.000Z", 3),
      type: "dynamic_tool",
      toolName: "mcp__t3-code__t3_thread_read",
      input: { threadId: "thread-child" },
      output: { messages: [] },
    };

    const feed = buildThreadFeed([projected(toolItem, 0)]);
    const activity = feed[0]?.type === "activity-group" ? feed[0].activities[0] : null;

    expect(activity?.summary).toBe("Read a chat");
    expect(activity?.logo).toBe("t3-code");
    expect(activity?.getCopyText().split("\n")[0]).toBe("Read a chat");
  });

  it("renders a merged browser action like its retained single-purpose call", () => {
    const item: OrchestrationV2TurnItem = {
      ...base("merged-browser", "2026-06-20T00:00:04.000Z", 3),
      type: "dynamic_tool",
      toolName: "mcp__t3-code__preview_act",
      input: { action: "click", locator: "aria-ref=button" },
    };
    const merged = buildThreadFeed([projected(item, 0)]);
    const legacy = buildThreadFeed([
      projected({ ...item, toolName: "mcp__t3-code__preview_click" }, 0),
    ]);
    const summary = (feed: typeof merged) =>
      feed[0]?.type === "activity-group" ? feed[0].activities[0]?.summary : null;
    expect(summary(merged)).toBe(summary(legacy));
    expect(summary(merged)).toContain("Click");
  });

  it.each(["cua_repl.js", "node_repl.js", "js"])(
    "uses the %s action title in the mobile feed",
    (toolName) => {
      const item: OrchestrationV2TurnItem = {
        ...base("cua", "2026-09-23T20:20:00.000Z", 1),
        type: "dynamic_tool",
        toolName,
        input: {
          code: "await game.getAXStateAndScreenshot();",
          title: "Inspect Saga music screen",
        },
      };
      const feed = buildThreadFeed([projected(item, 0)]);
      const activity = feed[0]?.type === "activity-group" ? feed[0].activities[0] : null;
      expect(activity?.summary).toBe("Inspect Saga music screen");
    },
  );

  it.each([
    [
      "failed",
      "await sky.type_text({app:'SSHCode (Nightly)',text:'debug(ga.run)'});",
      "Restrict the breakpoint to Git actions",
      "computer",
    ],
    [
      "completed",
      "await fetch('http://127.0.0.1/json/list');",
      "Discover the live Electron debugging endpoint",
      "code",
    ],
  ] as const)("recovers the retained js title and %s call icon", (status, code, title, icon) => {
    const item: OrchestrationV2TurnItem = {
      ...base("retained-js", "2026-09-23T20:20:00.000Z", 1),
      type: "dynamic_tool",
      status,
      title: "js",
      toolName: "node_repl.js",
      toolSource: { key: "mcp:node_repl", name: "node repl", kind: "integration" },
      input: { code, title },
    };
    const feed = buildThreadFeed([projected(item, 0)]);
    const activity = feed[0]?.type === "activity-group" ? feed[0].activities[0] : null;
    expect(activity?.summary).toBe(title);
    expect(activity?.icon).toBe(icon);
    expect(activity?.workEntry.toolSource?.kind).toBe(
      icon === "computer" ? "computer" : "integration",
    );
  });

  it("uses canonical T3 orchestration summaries in compact work groups", () => {
    const rows = [
      projected(command("2026-06-20T00:00:01.000Z"), 0),
      ...["mcp__t3-code__t3_thread_send", "t3_code.t3_thread_send", "t3_thread_send"].map(
        (toolName, index) =>
          projected(
            {
              ...base(`item-send-${index}`, `2026-06-20T00:00:0${index + 2}.000Z`, index + 2),
              type: "dynamic_tool" as const,
              toolName,
              input: { threadId: `thread-${index}`, message: "Continue" },
              output: { threadId: `thread-${index}`, messageId: `message-${index}` },
            },
            index + 1,
          ),
      ),
      projected(
        {
          ...command("2026-06-20T00:00:06.000Z"),
          id: TurnItemId.make("item-command-2"),
          ordinal: 6,
        },
        4,
      ),
    ];

    const presented = deriveThreadFeedPresentation(
      buildThreadFeed(rows),
      { runId, status: "running", startedAt: null, completedAt: null },
      new Set(),
    );

    expect(presented).toMatchObject([
      {
        type: "work-toggle",
        summary: "Ran 2 commands and sent messages to 3 threads",
        hiddenCount: 5,
        hasFailure: false,
      },
    ]);
  });

  it("presents project calls and summarizes successful clones through the mobile feed", () => {
    const items: OrchestrationV2TurnItem[] = [
      {
        ...base("list", "2026-09-19T00:00:01.000Z", 1),
        type: "dynamic_tool",
        title: "Custom provider title",
        toolName: "T3-code.t3_project_list",
        input: {},
        output: { projects: [] },
      },
      {
        ...base("clone", "2026-09-19T00:00:02.000Z", 2),
        type: "dynamic_tool",
        title: "Custom provider title",
        toolName: "mcp__t3_code__t3_project_clone",
        input: {},
        output: { cwd: "/tmp/repo" },
      },
      {
        ...base("failed-clone", "2026-09-19T00:00:03.000Z", 3),
        type: "dynamic_tool",
        title: "Custom provider title",
        toolName: "t3_project_clone",
        input: {},
        output: { isError: true },
      },
    ];
    const feed = buildThreadFeed(items.map((item, position) => projected(item, position)));
    const activities = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(workEntryRowLabel(activities[0]!.workEntry)).toBe("Listed projects");
    expect(workEntryRowLabel(activities[1]!.workEntry)).toBe("Cloned a repository");
    expect(workEntryRowLabel(activities[2]!.workEntry)).toBe("Failed to clone a repository");
    expect(activities.every((activity) => activity.logo === "t3-code")).toBe(true);
    const presented = deriveThreadFeedPresentation(
      feed,
      { runId, status: "running", startedAt: null, completedAt: null },
      new Set(),
    );
    expect(presented.find((entry) => entry.type === "work-toggle")).toMatchObject({
      summary: "Listed projects 1 time and cloned 1 repository",
      hasFailure: true,
    });
  });
});

describe("retained v2 feed presentation", () => {
  it("retains unchanged rows while the assistant streams", () => {
    const rows = [
      projected(userMessage(), 0),
      projected(command(), 1),
      projected({ ...assistantMessage(), streaming: true }, 2),
    ];
    const latestRun = {
      runId,
      status: "running" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: null,
    };
    const before = buildThreadFeed(rows);
    const beforePresentation = deriveThreadFeedPresentation(
      before,
      latestRun,
      new Set(),
      new Set(),
      latestRun.startedAt,
    );
    const after = buildThreadFeed([
      rows[0]!,
      rows[1]!,
      projected(
        { ...assistantMessage("2026-06-20T00:00:04.000Z"), text: "Still working", streaming: true },
        2,
      ),
    ]);
    const afterPresentation = deriveThreadFeedPresentation(
      after,
      latestRun,
      new Set(),
      new Set(),
      latestRun.startedAt,
    );
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).not.toBe(before[2]);
    expect(afterPresentation[0]).toBe(beforePresentation[0]);
    expect(afterPresentation[1]).toBe(beforePresentation[1]);
  });

  it.each(["running", "completed", "interrupted"] as const)(
    "uses the compaction row as the live activity only while %s",
    (status) => {
      const compact = projected(
        {
          ...base("compacted", "2026-06-20T00:00:02.000Z", 1),
          type: "compaction",
          status,
          driver: null,
          beforeTokenCount: 899_000,
          ...(status === "completed" ? { afterTokenCount: 19_000 } : {}),
        },
        1,
      );
      const latestRun = {
        runId,
        status: "running" as const,
        startedAt: "2026-06-20T00:00:01.000Z",
        completedAt: null,
      };
      const rows = deriveThreadFeedPresentation(
        buildThreadFeed([projected(userMessage(), 0), compact]),
        latestRun,
        new Set(),
        new Set(),
        latestRun.startedAt,
      );
      expect(rows.some((row) => row.type === "thinking")).toBe(status !== "running");
      expect(rows.find((row) => row.type === "activity-group")).toMatchObject({
        activities: [
          {
            summary:
              status === "running"
                ? "Compacting context"
                : status === "completed"
                  ? "Context compacted 899K → 19K tokens"
                  : "Context compaction stopped",
          },
        ],
      });
    },
  );

  it.each(["running", "completed", "failed"] as const)(
    "keeps a %s handoff separate from commands and visible through folds",
    (status) => {
      const handoff = projected(
        {
          ...base("handoff", "2026-06-20T00:00:02.000Z", 1),
          type: "handoff",
          status,
          contextHandoffId: ContextHandoffId.make("handoff"),
          fromProviderThreadIds: [],
          toProviderThreadId: ProviderThreadId.make("target"),
          fromProviderInstanceIds: [ProviderInstanceId.make("codex")],
          toProviderInstanceId: ProviderInstanceId.make("claudeAgent"),
          strategy: "full_thread_summary",
          summary: "Private full conversation summary",
        },
        1,
      );
      const feed = buildThreadFeed([
        projected(userMessage(), 0),
        handoff,
        projected(command("2026-06-20T00:00:03.000Z"), 2),
        projected(assistantMessage("2026-06-20T00:00:04.000Z"), 3),
      ]);
      for (const expanded of [new Set<RunId>(), new Set([runId])]) {
        const rows = deriveThreadFeedPresentation(feed, null, expanded);
        const divider = rows.filter(
          (entry) => entry.type === "activity-group" && isContextHandoffActivityGroup(entry),
        );
        expect(divider).toHaveLength(1);
        expect(divider[0]).toMatchObject({ activities: [{ projectedItem: handoff }] });
      }
      const alone = deriveThreadFeedPresentation(
        buildThreadFeed([projected(userMessage(), 0), handoff]),
        null,
        new Set(),
      );
      expect(alone.map((entry) => entry.type)).toEqual(["message", "activity-group"]);
    },
  );

  it("keeps a standalone compaction visible and folds it with other completed work", () => {
    const compact = projected(
      {
        ...base("compacted", "2026-06-20T00:00:02.000Z", 1),
        type: "compaction",
        driver: null,
        summary: "Shorter context",
      },
      1,
    );
    const latestRun = {
      runId,
      status: "completed" as const,
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:04.000Z",
    };
    const onlyCompaction = deriveThreadFeedPresentation(
      buildThreadFeed([projected(userMessage(), 0), compact]),
      latestRun,
      new Set(),
    );
    expect(onlyCompaction.map((entry) => entry.type)).toEqual(["message", "activity-group"]);
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      compact,
      projected(command("2026-06-20T00:00:03.000Z"), 2),
      projected(assistantMessage("2026-06-20T00:00:04.000Z"), 3),
    ]);
    expect(
      deriveThreadFeedPresentation(feed, latestRun, new Set()).map((entry) => entry.type),
    ).toEqual(["message", "run-fold", "message"]);
    const expanded = deriveThreadFeedPresentation(feed, latestRun, new Set([runId]));
    expect(
      expanded.find(
        (entry) =>
          entry.type === "activity-group" &&
          entry.activities[0]?.projectedItem.item.type === "compaction",
      ),
    ).toMatchObject({ activities: [{ summary: "Context compacted" }] });
  });

  it("retains assistant image attachments from the wire", () => {
    const image = {
      type: "image" as const,
      id: "assistant-image",
      name: "result.png",
      mimeType: "image/png",
      sizeBytes: 100,
    };
    const feed = buildThreadFeed([
      projected({ ...assistantMessage(), text: "", attachments: [image] }, 0),
    ]);
    expect(feed).toMatchObject([
      { type: "message", message: { role: "assistant", attachments: [image] } },
    ]);
  });

  it("keeps native application icons and source identity in collapsed and expanded work", () => {
    const icon = {
      _tag: "native-app" as const,
      app: { _tag: "app-id" as const, appId: "com.example.Editor" },
    };
    const source = {
      key: "native-app:com.example.editor",
      name: "Editor",
      kind: "computer" as const,
      icon,
    };
    const rows = [0, 1].map((index) =>
      projected(
        {
          ...base(`native-${index}`, `2026-06-20T00:00:0${index + 2}.000Z`, index + 1),
          type: "dynamic_tool" as const,
          toolName: "computer.click",
          input: { x: index, y: 1 },
          output: null,
          toolSurface: "computer" as const,
          toolIcon: icon,
          toolSource: source,
        },
        index,
      ),
    );
    const feed = buildThreadFeed(rows);
    const latestRun = { runId, status: "running" as const, startedAt: null, completedAt: null };
    const collapsed = deriveThreadFeedPresentation(feed, latestRun, new Set());
    const toggle = collapsed[0];
    if (toggle?.type !== "work-toggle") throw new Error("Expected a collapsed work group");
    const presented = deriveThreadFeedPresentation(
      feed,
      latestRun,
      new Set(),
      new Set([toggle.groupId]),
    );
    expect(presented[0]).toMatchObject({
      type: "work-toggle",
      summary: "Used Editor",
      toolSurface: "computer",
      toolIcon: icon,
    });
    expect(presented[1]).toMatchObject({
      type: "activity-group",
      activities: [
        { icon: "computer", workEntry: { toolSource: source, toolIcon: icon } },
        { icon: "computer", workEntry: { toolSource: source, toolIcon: icon } },
      ],
    });
  });

  it.each([
    ["failed", "Failed to click in the preview browser", true],
    ["cancelled", "Stopped clicking in the preview browser", false],
  ] as const)(
    "keeps %s calls terminal while the parent run remains live",
    (status, summary, hasFailure) => {
      const feed = buildThreadFeed([
        projected(
          {
            ...base("preview-click", "2026-06-20T00:00:02.000Z", 1),
            type: "dynamic_tool",
            status,
            toolName: "mcp__t3-code__preview_click",
            input: { element: "button" },
            output: null,
          },
          0,
        ),
      ]);
      const rows = deriveThreadFeedPresentation(
        feed,
        { runId, status: "running", startedAt: "2026-06-20T00:00:01.000Z", completedAt: null },
        new Set(),
        new Set(),
        "2026-06-20T00:00:01.000Z",
      );
      expect(rows[0]).toMatchObject({ type: "work-toggle", summary, hasFailure, shimmer: false });
    },
  );

  it.each([
    { envelope: "direct", output: { taskId: "a" } },
    { envelope: "structured", output: { structuredContent: { taskId: "a" } } },
    { envelope: "text", output: { content: [{ type: "text", text: '{"taskId":"a"}' }] } },
    { envelope: "short handle", output: { taskId: "handle-a", childThreadId: "child-a" } },
  ])(
    "folds $envelope delegations into their cards, keeping failed calls and calls without a card",
    ({ output }) => {
      const agent = (
        id: string,
        index: number,
        origin = "app_owned" as "app_owned" | "provider_native",
      ) =>
        projected(
          {
            ...base(id, "2026-06-20T00:00:01.000Z", index),
            type: "subagent",
            subagentId: NodeId.make(id),
            origin,
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            childThreadId: ThreadId.make(`child-${id}`),
            prompt: "Identical task",
            result: "Done",
          },
          index,
        );
      const delegation = (
        id: string,
        index: number,
        overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>> = {},
      ) =>
        projected(
          {
            ...base(id, "2026-06-20T00:00:02.000Z", index),
            type: "dynamic_tool",
            toolName: "t3-code.delegate_task",
            input: { task: "Identical task" },
            output,
            ...overrides,
          },
          index,
        );
      const feed = buildThreadFeed([
        agent("a", 1),
        delegation("matched", 2),
        agent("b", 3),
        delegation("pending", 4, { status: "running", output: null }),
        delegation("unmatched", 5, { output: { taskId: "missing" } }),
        delegation("failed", 6, { status: "failed" }),
        delegation("error-output", 7, { output: { taskId: "a", isError: true } }),
        delegation("other-run", 8, { runId: RunId.make("other-run") }),
        agent("native", 9, "provider_native"),
        delegation("native-delegation", 10, { output: { taskId: "native" } }),
      ]);
      const groups = feed.flatMap((entry) =>
        entry.type === "activity-group"
          ? [entry.activities.map((activity) => activity.projectedItem.item.id)]
          : [],
      );
      expect(groups[0]).toEqual(["a", "b"]);
      // The pending call has no output yet; it takes the run's unclaimed card b.
      expect(groups.flat()).toEqual([
        "a",
        "b",
        "unmatched",
        "failed",
        "error-output",
        "other-run",
        "native",
        "native-delegation",
      ]);
      const presented = deriveThreadFeedPresentation(
        feed,
        null,
        new Set([runId, RunId.make("other-run")]),
      );
      expect(
        presented.find(
          (entry) =>
            entry.type === "activity-group" && entry.activities[0]?.projectedItem.item.id === "a",
        )?.continuesWorkLog,
      ).toBeUndefined();
    },
  );

  it("shows a finished delegation without output as its card, below the group's other tools", () => {
    const feed = buildThreadFeed([
      projected(command(), 1),
      projected(
        {
          ...base("delegation", "2026-06-20T00:00:03.000Z", 2),
          type: "dynamic_tool",
          toolName: "mcp__t3-code__delegate_task",
          input: { task: "Review the fix" },
        },
        2,
      ),
      projected(
        {
          ...base("card", "2026-06-20T00:00:04.000Z", 3),
          type: "subagent",
          subagentId: NodeId.make("card"),
          origin: "app_owned",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          childThreadId: ThreadId.make("child-card"),
          prompt: "Review the fix",
          result: null,
        },
        3,
      ),
    ]);
    const groups = feed.flatMap((entry) =>
      entry.type === "activity-group" ? [entry.activities] : [],
    );
    expect(groups.map((group) => group.map((activity) => activity.projectedItem.item.id))).toEqual([
      ["item-command"],
      ["card"],
    ]);
    expect(
      summarizeToolGroup(groups[0]!.map((activity) => activity.workEntry)).summary,
    ).not.toMatch(/elegat/);
  });

  it("keeps subagents from different provider turns in separate cards", () => {
    const agent = (id: string, index: number) =>
      projected(
        {
          ...base(id, "2026-06-20T00:00:01.000Z", index),
          type: "subagent",
          subagentId: NodeId.make(id),
          origin: "provider_native",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerTurnId: ProviderTurnId.make(id),
          childThreadId: null,
          prompt: "Task",
          result: null,
        },
        index,
      );
    expect(
      buildThreadFeed([agent("a", 1), agent("b", 2)]).flatMap((entry) =>
        entry.type === "activity-group"
          ? [entry.activities.map((activity) => activity.projectedItem.item.id)]
          : [],
      ),
    ).toEqual([["a"], ["b"]]);
  });

  it("groups only adjacent subagents in the same run, keeping their child links", () => {
    const agent = (id: string, index: number, agentRunId = runId) =>
      projected(
        {
          ...base(id, `2026-06-20T00:00:0${index}.000Z`, index),
          type: "subagent",
          runId: agentRunId,
          subagentId: NodeId.make(id),
          origin: "app_owned",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          childThreadId: ThreadId.make(`child-${id}`),
          prompt: "Solve the puzzle",
          result: "Done",
        },
        index,
      );
    const feed = buildThreadFeed([
      agent("a", 1),
      agent("b", 2),
      projected(command("2026-06-20T00:00:03.000Z"), 3),
      agent("c", 4),
      agent("d", 5, RunId.make("other-run")),
    ]);
    expect(
      feed.flatMap((entry) =>
        entry.type === "activity-group"
          ? [entry.activities.map((activity) => activity.projectedItem.item.id)]
          : [],
      ),
    ).toEqual([["a", "b"], ["item-command"], ["c"], ["d"]]);
    const presented = deriveThreadFeedPresentation(
      feed,
      null,
      new Set([runId, RunId.make("other-run")]),
    );
    const groups = presented.flatMap((entry) =>
      entry.type === "activity-group" && entry.activities[0]?.projectedItem.item.type === "subagent"
        ? [entry]
        : [],
    );
    expect(groups.map((entry) => entry.activities.length)).toEqual([2, 1, 1]);
    expect(groups[0]?.activities.map((activity) => activity.projectedItem.item)).toMatchObject([
      { childThreadId: "child-a" },
      { childThreadId: "child-b" },
    ]);
  });

  it("shows an idle native subagent without claiming completion", () => {
    const rows = buildThreadFeed([
      projected(
        {
          ...base("native-agent", "2026-06-20T00:00:02.000Z", 1),
          type: "subagent",
          status: "idle",
          subagentId: NodeId.make("native-agent"),
          origin: "provider_native",
          driver: ProviderDriverKind.make("antigravity"),
          providerInstanceId: ProviderInstanceId.make("antigravity"),
          childThreadId: null,
          title: "Search",
          prompt: "Find relevant files",
          result: null,
        },
        0,
      ),
    ]);
    expect(rows[0]).toMatchObject({
      type: "activity-group",
      activities: [{ status: "neutral", lifecycleStatus: "idle", prominent: false }],
    });
    expect(deriveThreadFeedPresentation(rows, null, new Set([runId]))).toMatchObject([
      { type: "run-fold", expanded: true },
      { type: "activity-group", activities: [{ lifecycleStatus: "idle" }] },
    ]);
  });
});

const singleSelectQuestion = {
  id: "runtime",
  header: "Runtime",
  question: "Which runtime should be used?",
  options: [
    { label: "Go", description: "One binary" },
    { label: "Node.js", description: "Reuse TypeScript" },
  ],
  multiSelect: false,
} as const;

const multiSelectQuestion = {
  id: "scope",
  header: "Scope",
  question: "Which data should be collected?",
  options: [
    { label: "Orders", description: "Receipts" },
    { label: "Listings", description: "Inventory" },
  ],
  multiSelect: true,
} as const;

describe("subagent continued by a later turn", () => {
  // Stored shape from #15891: resuming a subagent moves its item to the
  // resuming run, but the item keeps the ordinal from the turn that started it.
  const run2 = RunId.make("run-2");
  const at = (second: number) => `2026-10-09T10:00:${String(second).padStart(2, "0")}.000Z`;
  const item = (id: string, itemRunId: RunId, ordinal: number, second: number) => ({
    ...base(id, at(second), ordinal),
    runId: itemRunId,
  });
  const user = (id: string, itemRunId: RunId, ordinal: number, second: number) => ({
    ...item(id, itemRunId, ordinal, second),
    type: "user_message" as const,
    messageId: MessageId.make(id),
    createdBy: "user" as const,
    creationSource: "mobile" as const,
    inputIntent: "turn_start" as const,
    text: `Prompt ${id}`,
    attachments: [],
  });
  const assistant = (id: string, itemRunId: RunId, ordinal: number, second: number) => ({
    ...item(id, itemRunId, ordinal, second),
    type: "assistant_message" as const,
    messageId: MessageId.make(id),
    text: `Answer ${id}`,
    streaming: false,
  });
  const work = (id: string, itemRunId: RunId, ordinal: number, second: number) => ({
    ...item(id, itemRunId, ordinal, second),
    type: "command_execution" as const,
    input: "git status",
    output: "clean",
    exitCode: 0,
  });
  const items: OrchestrationV2TurnItem[] = [
    user("prompt-1", runId, 1_000_001, 0),
    work("work-1", runId, 1_000_002, 1),
    {
      ...item("subagent", run2, 1_000_003, 2),
      type: "subagent",
      subagentId: NodeId.make("subagent"),
      origin: "provider_native",
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      childThreadId: null,
      prompt: "Research the bug",
      result: "Found it",
    },
    assistant("answer-1", runId, 1_000_004, 3),
    user("prompt-2", run2, 2_000_001, 30),
    work("work-2", run2, 2_000_002, 31),
    assistant("answer-2", run2, 2_000_003, 32),
    {
      ...item("send-message", run2, 2_000_004, 33),
      type: "dynamic_tool",
      toolName: "SendMessage",
      input: { to: "subagent" },
      output: "Sent",
    },
    assistant("closing-2", run2, 2_000_005, 41),
  ];

  it("keeps subagent work with its prompt and preserves interleaved prose", () => {
    const presented = deriveThreadFeedPresentation(
      buildThreadFeed(items.map((entry, index) => projected(entry, index))),
      { runId: run2, status: "completed", startedAt: at(30), completedAt: at(41) },
      new Set(),
    );
    expect(presented.map((entry) => entry.id)).toEqual([
      "prompt-1",
      `run-fold:${runId}`,
      "answer-1",
      "prompt-2",
      "work-toggle:work-group:local:thread-1:work-2",
      "answer-2",
      "work-toggle:work-group:local:thread-1:send-message",
      "closing-2",
    ]);
  });

  it("keeps a wake run's work open when the user steers it", () => {
    const wakeRun = RunId.make("wake-run");
    const wakeItems: OrchestrationV2TurnItem[] = [
      user("prompt-1", runId, 1_000_001, 0),
      work("work-1", runId, 1_000_002, 1),
      assistant("answer-1", runId, 1_000_003, 3),
      {
        ...item("wake", wakeRun, 2_000_001, 30),
        type: "notification",
        source: { kind: "background_task" },
        outcome: "completed",
        summary: "Background task finished",
      },
      {
        ...item("wake-command", wakeRun, 2_000_002, 31),
        type: "command_execution",
        input: "vp test",
        output: "ok",
        exitCode: 0,
      },
      { ...user("steer", wakeRun, 2_000_003, 32), inputIntent: "steer" },
    ];
    const presented = deriveThreadFeedPresentation(
      buildThreadFeed(wakeItems.map((entry, index) => projected(entry, index))),
      { runId: wakeRun, status: "running", startedAt: at(30), completedAt: null },
      new Set(),
      new Set(),
      at(30),
    );
    expect(presented.map((entry) => entry.id)).toEqual([
      "prompt-1",
      `run-fold:${runId}`,
      "answer-1",
      "local:thread-1:wake",
      "work-toggle:work-group:local:thread-1:wake-command",
      "steer",
      "live-activity-row",
    ]);
  });
});

describe("pending user input answers", () => {
  it("sends an answer to a question with the id __proto__", () => {
    const answers = buildPendingUserInputAnswers(
      [
        { ...singleSelectQuestion, id: "__proto__" },
        { ...singleSelectQuestion, id: "name" },
      ],
      {
        ["__proto__"]: { selectedOptionValues: ["Go"] },
        name: { selectedOptionValues: ["Node.js"] },
      },
    );

    expect(JSON.stringify(answers)).toBe('{"__proto__":"Go","name":"Node.js"}');
  });

  it("preserves exact editor text, including a deliberately cleared answer", () => {
    const question = { ...singleSelectQuestion, initialAnswer: "  Proposed message\n" };
    expect(
      buildPendingUserInputAnswers([question], {
        runtime: { customAnswer: question.initialAnswer },
      }),
    ).toEqual({ runtime: question.initialAnswer });
    expect(
      buildPendingUserInputAnswers([question], {
        runtime: { customAnswer: "  Edited message\n\n" },
      }),
    ).toEqual({ runtime: "  Edited message\n\n" });
    expect(buildPendingUserInputAnswers([question], { runtime: { customAnswer: "" } })).toEqual({
      runtime: "",
    });
    expect(buildPendingUserInputAnswers([question], { runtime: { customAnswer: " \n" } })).toEqual({
      runtime: " \n",
    });
    expect(setPendingUserInputCustomAnswer(question, { selectedOptionValues: ["Go"] }, "")).toEqual(
      { customAnswer: "" },
    );
  });

  it("replaces single-select options and toggles multi-select options", () => {
    expect(
      togglePendingUserInputOptionSelection(
        singleSelectQuestion,
        { selectedOptionValues: ["Go"] },
        "Node.js",
      ),
    ).toEqual({ customAnswer: "", selectedOptionValues: ["Node.js"] });

    const orders = togglePendingUserInputOptionSelection(multiSelectQuestion, undefined, "Orders");
    const ordersAndListings = togglePendingUserInputOptionSelection(
      multiSelectQuestion,
      orders,
      "Listings",
    );
    expect(ordersAndListings).toEqual({
      customAnswer: "",
      selectedOptionValues: ["Orders", "Listings"],
    });
    expect(
      togglePendingUserInputOptionSelection(multiSelectQuestion, ordersAndListings, "Orders"),
    ).toEqual({ customAnswer: "", selectedOptionValues: ["Listings"] });

    const paddedOrders = togglePendingUserInputOptionSelection(
      multiSelectQuestion,
      undefined,
      "  Orders  ",
    );
    expect(paddedOrders).toEqual({ customAnswer: "", selectedOptionValues: ["Orders"] });
    expect(
      togglePendingUserInputOptionSelection(multiSelectQuestion, paddedOrders, "  Orders  "),
    ).toEqual({ customAnswer: "" });
  });

  it("sends the selected options and the user's own words together for multi-select questions", () => {
    const selected = togglePendingUserInputOptionSelection(
      multiSelectQuestion,
      undefined,
      "Orders",
    );
    const typed = setPendingUserInputCustomAnswer(multiSelectQuestion, selected, "and refunds");
    // Typing keeps the selection, and selecting keeps the typed text.
    expect(typed).toEqual({ customAnswer: "and refunds", selectedOptionValues: ["Orders"] });
    expect(isPendingUserInputOptionSelected(multiSelectQuestion, typed, "Orders")).toBe(true);
    const both = togglePendingUserInputOptionSelection(multiSelectQuestion, typed, "Listings");
    expect(both).toEqual({
      customAnswer: "and refunds",
      selectedOptionValues: ["Orders", "Listings"],
    });
    expect(buildPendingUserInputAnswers([multiSelectQuestion], { scope: both })).toEqual({
      scope: ["Orders", "Listings", "and refunds"],
    });
    // With nothing selected the words alone are the answer.
    expect(
      buildPendingUserInputAnswers([multiSelectQuestion], { scope: { customAnswer: "refunds" } }),
    ).toEqual({ scope: "refunds" });
    // A single-choice question still takes one or the other.
    const single = setPendingUserInputCustomAnswer(
      singleSelectQuestion,
      { selectedOptionValues: ["Go"] },
      "Rust",
    );
    expect(single).toEqual({ customAnswer: "Rust" });
    expect(isPendingUserInputOptionSelected(singleSelectQuestion, single, "Go")).toBe(false);
  });

  it("builds array answers for multi-select questions", () => {
    expect(
      buildPendingUserInputAnswers([singleSelectQuestion, multiSelectQuestion], {
        runtime: { selectedOptionValues: ["Go"] },
        scope: { selectedOptionValues: ["Orders", "Listings"] },
      }),
    ).toEqual({
      runtime: "Go",
      scope: ["Orders", "Listings"],
    });
  });

  it("clears the selected option of a single-choice question while a custom answer is active", () => {
    expect(
      setPendingUserInputCustomAnswer(
        singleSelectQuestion,
        { selectedOptionValues: ["Go"] },
        "Rust first",
      ),
    ).toEqual({ customAnswer: "Rust first" });
  });

  it("matches selected chips against normalized option labels", () => {
    expect(
      isPendingUserInputOptionSelected(
        multiSelectQuestion,
        { selectedOptionValues: ["Orders"] },
        "  Orders  ",
      ),
    ).toBe(true);
    // Typed words replace a single choice and add to a multiple one.
    expect(
      isPendingUserInputOptionSelected(
        multiSelectQuestion,
        { selectedOptionValues: ["Orders"], customAnswer: "Orders first" },
        "  Orders  ",
      ),
    ).toBe(true);
    expect(
      isPendingUserInputOptionSelected(
        singleSelectQuestion,
        { selectedOptionValues: ["Go"], customAnswer: "Rust first" },
        "Go",
      ),
    ).toBe(false);
  });
});

describe("provider question values", () => {
  const question = {
    ...singleSelectQuestion,
    allowCustomAnswer: false,
    options: [
      { label: "Same label", value: "  exact first  ", description: "First" },
      { label: "Same label", value: "second", description: "Second" },
    ],
  } as const;

  it("submits raw option values and distinguishes duplicate labels", () => {
    const first = togglePendingUserInputOptionSelection(question, undefined, "  exact first  ");
    expect(isPendingUserInputOptionSelected(question, first, "  exact first  ")).toBe(true);
    expect(isPendingUserInputOptionSelected(question, first, "second")).toBe(false);
    expect(buildPendingUserInputAnswers([question], { runtime: first })).toEqual({
      runtime: "  exact first  ",
    });
    expect(togglePendingUserInputOptionSelection(question, first, "Same label")).toBe(first);
  });

  it("rejects arbitrary text when the provider only accepts offered options", () => {
    expect(setPendingUserInputCustomAnswer(question, undefined, "Other")).toEqual({});
    expect(
      buildPendingUserInputAnswers([question], { runtime: { customAnswer: "Other" } }),
    ).toBeNull();
    expect(
      buildPendingUserInputAnswers([question], { runtime: { selectedOptionValues: ["unknown"] } }),
    ).toBeNull();
    expect(
      buildPendingUserInputAnswers([question], {
        runtime: { selectedOptionValues: ["second"], customAnswer: "stale draft" },
      }),
    ).toEqual({ runtime: "second" });
  });
});

it("accepts ready attachment-only answers while preserving selected options", () => {
  const question = {
    id: "q",
    header: "Spec",
    question: "Provide a specification",
    options: [{ label: "Yes", description: "Approve" }],
    multiSelect: false,
  };
  expect(buildPendingUserInputAnswers([question], { q: { attachmentCount: 1 } })).toEqual({
    q: "",
  });
  expect(
    buildPendingUserInputAnswers([question], {
      q: { attachmentCount: 1, selectedOptionValues: ["Yes"] },
    }),
  ).toEqual({ q: "Yes" });
  expect(
    buildPendingUserInputAnswers([question], {
      q: { attachmentCount: 1, attachmentsBlocked: true },
    }),
  ).toBeNull();
  expect(
    buildPendingUserInputAnswers([{ ...question, allowCustomAnswer: false }], {
      q: { attachmentCount: 1 },
    }),
  ).toBeNull();
});

it("makes attachment-only question answers expandable in the mobile feed", () => {
  const answer = {
    requestId: RuntimeRequestId.make("question-request"),
    answers: { q: "" },
    questionTextById: { q: "Attach the specification" },
    attachmentsByQuestionId: {
      q: [
        {
          type: "file" as const,
          id: "question-file",
          name: "spec.txt",
          mimeType: "text/plain",
          sizeBytes: 4,
        },
      ],
    },
  };
  const [group] = buildThreadFeed([
    projected(
      {
        ...base("answer-history", "2026-09-08T00:00:00.000Z", 0),
        type: "user_input_request",
        requestId: answer.requestId,
        questions: [],
        questionAnswer: answer,
      },
      0,
    ),
  ]);
  expect(group?.type).toBe("activity-group");
  if (group?.type !== "activity-group") return;
  expect(group.activities[0]).toMatchObject({
    canExpand: true,
    workEntry: { questionAnswer: answer },
  });
  expect(group.activities[0]?.getFullDetail()).toContain("spec.txt");
});

it("folds a monitor's back-to-back output reports into one activity and keeps its exit apart", () => {
  const description = "RL rollouts it1a-method: B5 on 59 tasks x2";
  const report = (
    id: string,
    second: number,
    event: string,
    outcome: "updated" | "failed",
    detail: string,
  ) => ({
    ...base(id, `2026-06-20T00:00:0${second}.000Z`, second),
    type: "notification" as const,
    source: { kind: "monitor" as const },
    outcome,
    summary: `${description}: ${event}`,
    detail,
  });
  const rows = [
    projected(report("update-1", 1, "output", "updated", "worker espocrm-020 failed"), 0),
    projected(report("update-2", 2, "output", "updated", "worker erpnext-007 failed"), 1),
    projected(report("update-3", 3, "output", "updated", "worker erpnext-018 failed"), 2),
    projected(report("exit", 4, "exited with code 1", "failed", "Log: /tmp/output.log"), 3),
  ];
  const feed = buildThreadFeed(rows);
  const activities = feed.flatMap((entry) =>
    entry.type === "activity-group" ? entry.activities : [],
  );
  expect(activities.map((activity) => activity.summary)).toEqual([
    `3 updates · ${description}`,
    `Exited with code 1 · ${description}`,
  ]);
  expect(activities[0]!.getFullDetail()).toBe(
    "worker espocrm-020 failed\nworker erpnext-007 failed\nworker erpnext-018 failed",
  );
  expect(activities[0]!.id).toBe(
    buildThreadFeed(rows.slice(0, 1)).flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    )[0]!.id,
  );
});

it("renders automatic completion as a neutral activity while retaining its details", () => {
  const item = {
    ...base("notification", "2026-06-20T00:00:01.000Z", 0),
    type: "notification" as const,
    source: { kind: "monitor" as const },
    outcome: "updated" as const,
    summary: "Monitor reported an update",
    detail: "Build checks changed",
  };
  const feed = buildThreadFeed([
    projected(item, 0),
    projected(command(), 1),
    projected(assistantMessage(), 2),
  ]);
  expect(feed[0]?.type).toBe("activity-group");
  if (feed[0]?.type !== "activity-group") throw new Error("Expected notification activity");
  const activity = feed[0].activities[0]!;
  expect(activity.summary).toBe("Monitor reported an update");
  expect(activity.detail).toBeNull();
  expect(activity.status).toBeNull();
  expect(activity.getFullDetail()).toContain(item.detail);
  const presented = deriveThreadFeedPresentation(
    feed,
    {
      runId,
      status: "completed",
      startedAt: "2026-06-20T00:00:01.000Z",
      completedAt: "2026-06-20T00:00:03.000Z",
    },
    new Set(),
  );
  expect(
    presented.some(
      (entry) =>
        entry.type === "activity-group" &&
        entry.activities.some((activity) => activity.summary === "Monitor reported an update"),
    ),
  ).toBe(true);
  expect(buildThreadFeed([projected(userMessage(), 0)])[0]?.type).toBe("message");
});

it("uses a compact reasoning preview and a short expanded heading", () => {
  const entry = {
    id: "thought",
    label: "Thinking",
    createdAt: "2026-09-17T12:00:00Z",
    itemType: "reasoning" as const,
    tone: "thinking" as const,
    detail: "Check **ordering**.\nThen run the test.",
    toolLifecycleStatus: "inProgress" as const,
  };
  expect(workEntryRowLabel(entry)).toBe("Check **ordering**. Then run the test.");
  expect(workEntryRowLabel(entry, true)).toBe("Thinking");
  expect(workEntryRowLabel({ ...entry, toolLifecycleStatus: "completed" }, true)).toBe("Thought");
});

it("keeps search output in expanded details rather than the compact label", () => {
  const entry = {
    id: "search",
    label: "Grep",
    toolTitle: "Grep",
    createdAt: "2026-09-17T12:00:00Z",
    itemType: "dynamic_tool" as const,
    tone: "tool" as const,
    detail: "---\nfile body",
    toolData: {},
  };
  expect(workEntryRowLabel(entry)).toBe("Grep");
  expect(workEntryRowLabel(entry, true)).toBe("---\nfile body");
});

it.each([false, true])(
  "keeps the live slot after a steer with hidden reasoning (Discord: %s)",
  (discord) => {
    const at = "2026-06-20T00:00:03.000Z";
    const steer: OrchestrationV2TurnItem = {
      ...userMessage(at),
      id: TurnItemId.make("steer"),
      ordinal: 2,
      messageId: MessageId.make("steer"),
      inputIntent: "steer",
      text: "Also check speed",
    };
    const thought: OrchestrationV2TurnItem = {
      ...base("hidden-thought", at, 4),
      type: "reasoning",
      status: "running",
      completedAt: null,
      streaming: true,
      text: "PRIVATE_STREAMING_THOUGHT",
    };
    const items = [userMessage(), command(), steer, thought];
    const present = (running: boolean, toolRunning = false) => {
      const feed = buildThreadFeed(
        [
          ...items,
          ...(toolRunning
            ? [
                {
                  ...command(),
                  id: TurnItemId.make("new-tool"),
                  status: "running" as const,
                  completedAt: null,
                  exitCode: undefined,
                },
              ]
            : []),
        ].map((item, index) => projected(item, index)),
      );
      const rows = deriveThreadFeedPresentation(
        feed,
        {
          runId,
          status: running ? "running" : "completed",
          startedAt: at,
          completedAt: running ? null : at,
        },
        new Set(),
        new Set(),
        running ? at : null,
      );
      return discord ? filterDiscordThreadFeed(rows) : rows;
    };
    const waiting = present(true);
    expect(waiting.at(-1)).toMatchObject({ type: "thinking", id: "live-activity-row" });
    expect(waiting.at(-2)).toMatchObject({ type: "message", message: { id: steer.messageId } });
    expect(JSON.stringify(waiting)).not.toContain("PRIVATE_STREAMING_THOUGHT");
    const toolRunning = present(true, true);
    expect(toolRunning.some((row) => row.type === "thinking")).toBe(false);
    expect(toolRunning.at(-1)).toMatchObject({ type: "work-toggle", live: true, shimmer: true });
    expect(present(false).some((row) => row.type === "thinking")).toBe(false);
  },
);

it("shows thinking while a thought streams and a finished thought as one collapsed row", () => {
  const at = "2026-06-20T00:00:02.000Z";
  const thought: OrchestrationV2TurnItem = {
    ...base("live-thought", at, 1),
    type: "reasoning",
    status: "running",
    completedAt: null,
    streaming: true,
    text: "First paragraph.\n\nSecond paragraph.",
  };
  const working = deriveThreadFeedPresentation(
    buildThreadFeed([projected(userMessage(), 0), projected(thought, 1)]),
    { runId, status: "running", startedAt: at, completedAt: null },
    new Set(),
    new Set(),
    at,
  );
  expect(working.map((row) => row.type)).toEqual(["message", "thinking"]);

  const settled = deriveThreadFeedPresentation(
    buildThreadFeed([
      projected(userMessage(), 0),
      projected({ ...thought, status: "completed", streaming: false }, 1),
      projected(assistantMessage(), 2),
    ]),
    { runId, status: "completed", startedAt: at, completedAt: "2026-06-20T00:00:03.000Z" },
    new Set([runId]),
  );
  expect(settled.map((row) => row.type)).toEqual([
    "message",
    "run-fold",
    "activity-group",
    "message",
  ]);
  // The thought is one row of its own, never wrapped in a group that repeats it.
  const thoughtRow = settled.find((row) => row.type === "activity-group");
  expect(
    thoughtRow?.type === "activity-group" &&
      thoughtRow.activities.map((activity) => [
        activity.projectedItem.item.id,
        activity.groupedToolDetail,
      ]),
  ).toEqual([["live-thought", undefined]]);

  // A chat that shows thoughts live keeps the streaming one as that same single row.
  const live = deriveThreadFeedPresentation(
    buildThreadFeed([projected(userMessage(), 0), projected(thought, 1)], { liveThoughts: true }),
    { runId, status: "running", startedAt: at, completedAt: null },
    new Set(),
    new Set(),
    at,
  );
  expect(live.filter((row) => row.type === "work-toggle")).toEqual([]);
  expect(live.flatMap((row) => (row.type === "activity-group" ? row.activities : []))).toHaveLength(
    1,
  );
});

it("folds a working stretch of tools and thoughts into one row that opens and closes", () => {
  const at = "2026-06-20T00:00:02.000Z";
  const thought = (id: string, ordinal: number): OrchestrationV2TurnItem => ({
    ...base(id, at, ordinal),
    type: "reasoning",
    text: `Thinking about ${id}.`,
    streaming: false,
  });
  const run = { runId, status: "running" as const, startedAt: at, completedAt: null };
  const feed = buildThreadFeed(
    [
      userMessage(),
      command(),
      thought("thought-a", 3),
      { ...command(), id: TurnItemId.make("tool-2") },
      thought("thought-b", 5),
      { ...command(), id: TurnItemId.make("tool-3") },
    ].map((item, index) => projected(item, index)),
    { liveThoughts: true },
  );
  const show = (expandedGroups: ReadonlySet<string>) =>
    deriveThreadFeedPresentation(feed, run, new Set(), expandedGroups, at);

  // Closed: one row for the whole stretch, like the Mac, not a row per call.
  const closed = show(new Set());
  const toggles = closed.filter((row) => row.type === "work-toggle");
  expect(toggles).toHaveLength(1);
  expect(toggles[0]).toMatchObject({ hiddenCount: 3, expanded: false });
  expect(closed.some((row) => row.type === "activity-group")).toBe(false);

  // Open: the same row stays on top to close it, and the thoughts show inside.
  const groupId = toggles[0]!.type === "work-toggle" ? toggles[0]!.groupId : "";
  const opened = show(new Set([groupId]));
  expect(opened.filter((row) => row.type === "work-toggle")).toMatchObject([{ expanded: true }]);
  const details = opened.flatMap((row) => (row.type === "activity-group" ? row.activities : []));
  expect(details.map((activity) => activity.workEntry.itemType)).toEqual(
    expect.arrayContaining(["reasoning", "reasoning"]),
  );
  expect(details).toHaveLength(5);
});

it.each(["provider_error", "usage_limit"] as const)(
  "keeps a historical %s failure and preceding work visible without disclosures",
  (failureClass) => {
    const at = "2026-06-20T00:00:03.000Z";
    const error: OrchestrationV2TurnItem = {
      ...base("failure", at, 2),
      type: "error",
      status: "failed",
      failure: {
        class: failureClass,
        message: "The provider stopped this turn.\nRetry later.",
        code: null,
        retryable: true,
      },
    };
    const command: OrchestrationV2TurnItem = {
      ...base("command", "2026-06-20T00:00:02.000Z", 1),
      type: "command_execution",
      input: "pwd",
      output: "",
      exitCode: 0,
    };
    const sourceFeed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(command, 1),
      projected(error, 2),
    ]);
    const feed = deriveThreadFeedPresentation(
      sourceFeed,
      { runId: RunId.make("newer-run"), status: "completed", startedAt: at, completedAt: at },
      new Set(),
    );
    const whileWorking = deriveThreadFeedPresentation(
      sourceFeed,
      { runId: RunId.make("newer-run"), status: "running", startedAt: at, completedAt: null },
      new Set(),
    );
    for (const entry of feed) {
      expect(whileWorking.find((row) => row.id === entry.id)).toBe(entry);
    }
    expect(feed.some((entry) => entry.type === "run-fold" || entry.type === "work-toggle")).toBe(
      false,
    );
    const activities = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    );
    expect(activities.map((activity) => activity.projectedItem.item.id)).toEqual([
      "command",
      "failure",
    ]);
    expect(activities.at(-1)).toMatchObject({
      detail: error.failure.message,
      createdAt: at,
      canExpand: false,
      prominent: true,
    });
  },
);

describe("html renders", () => {
  const page = { attachmentId: "attachment-page", title: "Revenue", height: 320 };
  const renderCall = (
    overrides: Partial<Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>> = {},
  ): OrchestrationV2TurnItem => ({
    ...base("item-render", "2026-06-20T00:00:02.500Z", 2),
    type: "dynamic_tool",
    toolName: "mcp__t3-code__html_render",
    input: { title: page.title },
    output: { htmlRender: page },
    ...overrides,
  });
  const laterCommand = {
    ...command("2026-06-20T00:00:02.800Z"),
    id: TurnItemId.make("item-command-later"),
    ordinal: 3,
  };
  const feed = () =>
    buildThreadFeed([
      projected(userMessage(), 0),
      projected(command(), 1),
      projected(renderCall(), 2),
      projected(laterCommand, 3),
      projected(assistantMessage("2026-06-20T00:00:04.000Z"), 4),
    ]);
  const latestRun = {
    runId,
    status: "completed" as const,
    startedAt: "2026-06-20T00:00:01.000Z",
    completedAt: "2026-06-20T00:00:04.000Z",
  };

  it("shows a completed render in place, outside the work log", () => {
    const expanded = deriveThreadFeedPresentation(feed(), latestRun, new Set([runId]));
    expect(expanded.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "work-toggle",
      "html-render",
      "work-toggle",
      "message",
    ]);
    expect(expanded[3]).toMatchObject({ type: "html-render", render: page, runId });
    expect(expanded[2]?.continuesWorkLog).toBeUndefined();
  });

  it("keeps a render visible and in order when its run folds", () => {
    const collapsed = deriveThreadFeedPresentation(feed(), latestRun, new Set());
    expect(collapsed.map((entry) => entry.type)).toEqual([
      "message",
      "run-fold",
      "html-render",
      "message",
    ]);
  });

  it("leaves running, failed and errored renders in the work log", () => {
    for (const call of [
      renderCall({ status: "running", output: null }),
      renderCall({ status: "failed" }),
      renderCall({ output: { isError: true, htmlRender: page } }),
    ]) {
      const entries = buildThreadFeed([projected(call, 0)]);
      expect(entries.map((entry) => entry.type)).toEqual(["activity-group"]);
    }
  });
});

describe("MCP apps", () => {
  const app = {
    attachmentId: "attachment-app",
    server: "weather",
    tool: "get_weather",
    resourceUri: "ui://weather/dashboard",
  };
  const appCall = (status: OrchestrationV2TurnItem["status"]): OrchestrationV2TurnItem => ({
    ...base("item-app", "2026-06-20T00:00:02.500Z", 2),
    status,
    type: "dynamic_tool",
    toolName: "weather.get_weather",
    input: { city: "Oslo" },
    output: { t3McpApp: app, result: { content: [] } },
  });
  const feed = (status: OrchestrationV2TurnItem["status"]) =>
    buildThreadFeed([
      projected(userMessage(), 0),
      projected(appCall(status), 1),
      projected(assistantMessage("2026-06-20T00:00:04.000Z"), 2),
    ]);

  it("hosts a completed app in place of its tool row, owned by its source item", () => {
    const entry = feed("completed").find((candidate) => candidate.type === "mcp-app");
    expect(entry).toMatchObject({ type: "mcp-app", app, itemId: "item-app", runId });
  });

  it("keeps a running app call an ordinary work row", () => {
    expect(feed("running").some((candidate) => candidate.type === "mcp-app")).toBe(false);
  });
});

it("adds no image strip for an image the user attached; the message already shows it", () => {
  const viewed = (id: string, path: string, ordinal: number): OrchestrationV2TurnItem => ({
    ...base(id, "2026-06-20T00:00:02.000Z", ordinal),
    type: "dynamic_tool",
    toolName: "Read",
    viewedImagePath: path,
    input: { file_path: path },
    output: null,
  });
  const feed = buildThreadFeed([
    projected(userMessage(), 0),
    projected(
      viewed(
        "read-attachment",
        "/Users/me/.t3/userdata/attachments/thread-1-34e2a8c1-bbc2-4774-8ba1-74624b45019f.png",
        1,
      ),
      1,
    ),
    projected(assistantMessage(), 2),
  ]);
  const latest = {
    runId,
    status: "completed" as const,
    startedAt: "2026-06-20T00:00:01.000Z",
    completedAt: "2026-06-20T00:00:03.000Z",
  };
  expect(
    deriveThreadFeedPresentation(feed, latest, new Set()).some(
      (entry) => entry.type === "viewed-images",
    ),
  ).toBe(false);
});

it("keeps agent-opened images visible once when a completed turn folds", () => {
  const viewed = (id: string, path: string, ordinal: number): OrchestrationV2TurnItem => ({
    ...base(id, "2026-06-20T00:00:02.000Z", ordinal),
    type: "dynamic_tool",
    toolName: "view_image",
    viewedImagePath: path,
    input: { path },
    output: null,
  });
  const feed = buildThreadFeed([
    projected(userMessage(), 0),
    projected(viewed("view-1", "/repo/screen.png", 1), 1),
    projected(viewed("view-again", "/repo/screen.png", 2), 2),
    projected(viewed("view-2", "/repo/other.png", 3), 3),
    projected(viewed("not-an-image", "/repo/notes.txt", 4), 4),
    projected({ ...viewed("failed-view", "/repo/failed.png", 5), status: "failed" }, 5),
    projected(assistantMessage(), 6),
  ]);
  const latest = {
    runId,
    status: "completed" as const,
    startedAt: "2026-06-20T00:00:01.000Z",
    completedAt: "2026-06-20T00:00:03.000Z",
  };
  const collapsed = deriveThreadFeedPresentation(feed, latest, new Set());
  expect(collapsed.map((entry) => entry.type)).toEqual([
    "message",
    "run-fold",
    "viewed-images",
    "message",
  ]);
  const images = collapsed.find((entry) => entry.type === "viewed-images");
  expect(images).toMatchObject({
    runId,
    activities: [
      { workEntry: { viewedImagePath: "/repo/screen.png" } },
      { workEntry: { viewedImagePath: "/repo/other.png" } },
    ],
  });
  expect(
    deriveThreadFeedPresentation(feed, latest, new Set()).find(
      (entry) => entry.type === "viewed-images",
    ),
  ).toBe(images);

  // Expanded and live work already show their images in the existing work toggle.
  const expanded = deriveThreadFeedPresentation(feed, latest, new Set([runId]));
  expect(expanded.some((entry) => entry.type === "viewed-images")).toBe(false);
  expect(expanded.some((entry) => entry.type === "work-toggle")).toBe(true);
  const running = deriveThreadFeedPresentation(
    feed,
    { ...latest, status: "running", completedAt: null },
    new Set(),
  );
  expect(running.some((entry) => entry.type === "viewed-images")).toBe(false);
});

it("unwraps shell wrappers for a single completed command toggle and recognizes Antigravity computer MCP calls", () => {
  const command: OrchestrationV2TurnItem = {
    ...base("cmd-1", "2026-06-20T00:00:02.000Z", 1),
    type: "command_execution",
    title: "Ran command",
    input: "/bin/zsh -lc 'git status'",
    output: "clean",
    exitCode: 0,
  };
  const computerCall: OrchestrationV2TurnItem = {
    ...base("comp-1", "2026-06-20T00:00:02.000Z", 1),
    type: "dynamic_tool",
    toolName: "Run mcp_t3-code_computer_status",
    title: "Run mcp_t3-code_computer_status",
    input: { includeApps: true },
    output: null,
  };
  const latest = {
    runId,
    status: "completed" as const,
    startedAt: "2026-06-20T00:00:01.000Z",
    completedAt: "2026-06-20T00:00:03.000Z",
  };
  const cmdFeed = deriveThreadFeedPresentation(
    buildThreadFeed([
      projected(userMessage(), 0),
      projected(command, 1),
      projected(assistantMessage(), 2),
    ]),
    latest,
    new Set([runId]),
  );
  expect(cmdFeed.find((entry) => entry.type === "work-toggle")).toMatchObject({
    summary: "git status",
  });

  const computerFeed = deriveThreadFeedPresentation(
    buildThreadFeed([
      projected(userMessage(), 0),
      projected(computerCall, 1),
      projected(assistantMessage(), 2),
    ]),
    latest,
    new Set([runId]),
  );
  expect(computerFeed.find((entry) => entry.type === "work-toggle")).toMatchObject({
    summary: "Checked computer access",
    summaryToolIcon: "computer",
  });
});

describe("commandless commands", () => {
  it("labels a running command without command text by its status", () => {
    const item: OrchestrationV2TurnItem = {
      ...base("commandless", "2026-06-20T00:00:02.000Z", 1),
      type: "command_execution",
      title: "Ran command",
      status: "running",
      completedAt: null,
      input: "",
    };
    const feed = buildThreadFeed([
      projected(userMessage(), 0),
      projected(item, 1),
      projected(assistantMessage("2026-06-20T00:00:04.000Z"), 2),
    ]);
    const activity = feed.flatMap((entry) =>
      entry.type === "activity-group" ? entry.activities : [],
    )[0]!;
    expect(workEntryRowLabel(activity.workEntry)).toBe("Running command");
    const presented = deriveThreadFeedPresentation(
      feed,
      { runId, status: "running", startedAt: "2026-06-20T00:00:01.000Z", completedAt: null },
      new Set(),
      new Set(),
      "2026-06-20T00:00:01.000Z",
    );
    expect(presented.find((entry) => entry.type === "work-toggle")).toMatchObject({
      summary: "Running command",
    });
  });
});
