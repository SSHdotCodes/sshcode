import type {
  ModelManagerReply,
  OrchestrationV2ThreadProjection,
  ProviderApprovalOption,
} from "@t3tools/contracts";

import { deriveLatestThreadRun } from "./state/threadExecution.ts";
import {
  derivePendingThreadRequests,
  type ThreadPendingUserInput,
} from "./state/threadRequests.ts";

export const MODEL_MANAGER_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "decline", label: "Decline" },
  { decision: "accept", label: "Approve" },
];

/** Keep the harness instructions in the provider context, outside the little transcript. */
export function modelManagerUserText(text: string): string {
  return text.replace(
    /\n\nHarness: [^\n]+\nRead [^\n]+ first and follow it; SSHCode rewrites it for every request\.$/,
    "",
  );
}

export function modelManagerBoxView(
  projection: OrchestrationV2ThreadProjection | null,
  reply: ModelManagerReply,
) {
  const latest = projection ? deriveLatestThreadRun(projection) : null;
  const requested = reply.runId ? projection?.runs.find((run) => run.id === reply.runId) : null;
  const activeRequested =
    requested && !["completed", "failed", "interrupted", "cancelled"].includes(requested.status)
      ? requested
      : null;
  const fallbackStatus = reply.delivery === "queued" ? "queued" : "running";
  const awaitingRun = reply.runId !== null && requested == null;
  const status =
    activeRequested?.status ?? (awaitingRun ? fallbackStatus : (latest?.status ?? fallbackStatus));
  const finished = ["completed", "failed", "interrupted", "cancelled"].includes(status);
  const pending = projection
    ? derivePendingThreadRequests(projection)
    : { approvals: [], userInputs: [] };
  const secrets =
    projection?.visibleTurnItems.filter(
      (row) =>
        row.item.type === "secret_request" &&
        row.item.secretStatus === "pending" &&
        row.visibility === "local",
    ) ?? [];
  const conversation = (projection?.messages ?? []).filter(
    (message) => (message.role === "user" || message.role === "assistant") && !message.notification,
  );
  const requestIndex = conversation.findLastIndex((message) => message.role === "user");
  const request = conversation[requestIndex];
  const answer = conversation.findLast(
    (message, index) => index > requestIndex && message.role === "assistant",
  );
  const messages = [request, answer].flatMap((message) =>
    message
      ? [
          {
            id: message.id,
            role: message.role,
            text: message.role === "user" ? modelManagerUserText(message.text) : message.text,
          },
        ]
      : [],
  );
  const step = projection?.turnItems.findLast(
    (item) =>
      !awaitingRun &&
      (item.status === "running" || item.status === "pending" || item.status === "waiting") &&
      item.runId === (activeRequested?.id ?? latest?.runId) &&
      (item.type === "command_execution" ||
        item.type === "file_change" ||
        item.type === "dynamic_tool"),
  );
  const activity =
    step?.type === "command_execution"
      ? `Running ${step.input}`
      : step?.type === "file_change"
        ? `Editing ${step.fileName}`
        : step?.type === "dynamic_tool"
          ? (step.title ?? step.toolName ?? "Working…")
          : "Working…";
  const needsInput =
    pending.approvals.length > 0 || pending.userInputs.length > 0 || secrets.length > 0;
  return {
    status,
    finished,
    messages,
    pending,
    secrets,
    activity: needsInput || finished ? null : activity.replace(/\s+/g, " ").slice(0, 240),
    label: needsInput
      ? "Needs your answer"
      : status === "completed"
        ? "Done. Models refresh in a moment."
        : finished
          ? "Stopped before finishing. You can try again."
          : status === "queued"
            ? "Queued"
            : "Updating models…",
  };
}

/** Resolve the small question form without choosing an option on the user's behalf. */
export function modelManagerQuestionAnswers(
  request: ThreadPendingUserInput,
  selected: Readonly<Record<string, ReadonlyArray<string>>>,
  custom: Readonly<Record<string, string>>,
) {
  const answers: Record<string, string | string[]> = {};
  for (const question of request.questions) {
    const typed = custom[question.id] ?? question.initialAnswer;
    const values = (selected[question.id] ?? []).filter((value) =>
      question.options.some((option) => (option.value ?? option.label) === value),
    );
    const customAnswer =
      question.allowCustomAnswer !== false &&
      typed !== undefined &&
      (typed.trim() || question.initialAnswer !== undefined)
        ? typed
        : null;
    const answer =
      customAnswer !== null && customAnswer.length > 0
        ? customAnswer
        : question.multiSelect
          ? values.length > 0
            ? [...values]
            : customAnswer
          : (values[0] ?? customAnswer);
    if (answer === null && question.required !== false) return null;
    if (answer !== null) answers[question.id] = answer;
  }
  return answers;
}

export function toggleModelManagerOption(
  values: ReadonlyArray<string>,
  value: string,
  multiSelect: boolean,
) {
  return multiSelect
    ? values.includes(value)
      ? values.filter((entry) => entry !== value)
      : [...values, value]
    : [value];
}
