import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2UserInputQuestion,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeRequestId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  isSingleRowReplacement,
  replaceVisibleTurnItem,
  visibleTurnItemsRevision,
} from "./orchestrationV2Projection.ts";

export interface ThreadPendingApproval {
  readonly requestId: RuntimeRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  /** App requesting access for mcp-elicitation approvals (#8058). */
  readonly appName?: string;
  /** Approval choices advertised by the provider (#8058); defaults apply when absent. */
  readonly options?: ReadonlyArray<ProviderApprovalOption>;
  readonly responseCapability: "live" | "not_resumable";
}

export interface ThreadUserInputQuestion extends Omit<
  OrchestrationV2UserInputQuestion,
  "multiSelect"
> {
  readonly multiSelect: boolean;
}

export interface ThreadPendingUserInput {
  readonly requestId: RuntimeRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<ThreadUserInputQuestion>;
  readonly responseCapability: OrchestrationV2RuntimeRequest["responseCapability"]["type"];
  readonly responseMode?: "message";
  readonly dismissible: boolean;
}

export interface PendingThreadRequests {
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
  readonly userInputs: ReadonlyArray<ThreadPendingUserInput>;
}

/** Seed each question once. Existing edits, cleared answers, and option selections win. */
export function seedUserInputDraftAnswers<Draft extends { readonly customAnswer?: string }>(
  questions: ReadonlyArray<
    Pick<OrchestrationV2UserInputQuestion, "id" | "allowCustomAnswer" | "initialAnswer">
  >,
  drafts: Record<string, Draft>,
): Record<string, Draft | { customAnswer: string }> {
  // Entries, not assignment, so an id such as `__proto__` becomes an own draft.
  const seeds = questions.flatMap((question) =>
    question.initialAnswer === undefined ||
    question.allowCustomAnswer === false ||
    Object.hasOwn(drafts, question.id)
      ? []
      : [[question.id, { customAnswer: question.initialAnswer }] as const],
  );
  return seeds.length === 0 ? drafts : { ...drafts, ...Object.fromEntries(seeds) };
}

/** Joins pending request entities to the request items that carry display data. */
/**
 * A pending question renders from its `user_input_request` item. A saved copy
 * of the thread can hold the request without that item (older servers left it
 * out of bounded snapshots), and resuming from the copy never delivers it.
 */
export function hasPendingUserInputWithoutItem(
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): boolean {
  const missing = new Set<string>();
  for (const request of projection.runtimeRequests) {
    if (request.status === "pending" && request.kind === "user_input") {
      missing.add(String(request.id));
    }
  }
  if (missing.size === 0) return false;
  for (const item of projection.turnItems) {
    if (item.type === "user_input_request") missing.delete(String(item.requestId));
  }
  return missing.size > 0;
}

export function derivePendingThreadRequests(
  projection: Pick<OrchestrationV2ThreadProjection, "runtimeRequests" | "turnItems">,
): PendingThreadRequests {
  const approvals: ThreadPendingApproval[] = [];
  const userInputs: ThreadPendingUserInput[] = [];

  for (const request of projection.runtimeRequests) {
    if (request.status !== "pending") continue;
    const responseCapability = request.responseCapability.type;
    if (request.kind === "user_input") {
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item === undefined || item.type !== "user_input_request") continue;
      userInputs.push({
        requestId: request.id,
        createdAt: DateTime.formatIso(request.createdAt),
        questions: item.questions.map((question) => ({
          ...question,
          multiSelect: question.multiSelect ?? false,
        })),
        responseCapability,
        dismissible: item.responseMode === "message" || responseCapability === "message",
        ...(item.responseMode === "message" || responseCapability === "message"
          ? { responseMode: "message" as const }
          : {}),
      });
      continue;
    }

    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    approvals.push({
      requestId: request.id,
      requestKind: request.kind,
      createdAt: DateTime.formatIso(request.createdAt),
      ...(item?.type === "approval_request" && item.prompt ? { detail: item.prompt } : {}),
      ...(item?.type === "approval_request" && item.appName ? { appName: item.appName } : {}),
      ...(item?.type === "approval_request" && item.options !== undefined
        ? { options: item.options }
        : {}),
      responseCapability: responseCapability === "live" ? "live" : "not_resumable",
    });
  }

  return { approvals, userInputs };
}

/** Older V2 answers were saved on requests without updating their timeline items. */
export function createQuestionHistoryProjector() {
  type Rows = OrchestrationV2ThreadProjection["visibleTurnItems"];
  type Requests = OrchestrationV2ThreadProjection["runtimeRequests"];
  let previousRows: Rows | undefined;
  let previousRevision: ReturnType<typeof visibleTurnItemsRevision> | undefined;
  let previousRequests: Requests | undefined;
  let previousResult: Rows | undefined;
  let byId = new Map<Requests[number]["id"], Requests[number]>();
  const cache = new WeakMap<Rows[number], { request: Requests[number]; row: Rows[number] }>();
  const projectRow = (row: Rows[number]): Rows[number] => {
    const item = row.item;
    const request =
      item.type === "user_input_request" && !item.questionAnswer
        ? byId.get(item.requestId)
        : undefined;
    if (
      item.type !== "user_input_request" ||
      request?.status !== "resolved" ||
      request.answers === undefined
    )
      return row;
    const cached = cache.get(row);
    const next =
      cached?.request === request
        ? cached.row
        : {
            ...row,
            item: {
              ...item,
              questionAnswer: {
                requestId: request.id,
                answers: request.answers,
                attachmentsByQuestionId: {},
                questionTextById: Object.fromEntries(
                  item.questions.map((question) => [question.id, question.question]),
                ),
              },
            },
          };
    cache.set(row, { request, row: next });
    return next;
  };
  return (
    projection: Pick<OrchestrationV2ThreadProjection, "visibleTurnItems" | "runtimeRequests">,
  ): Rows => {
    const { visibleTurnItems: rows, runtimeRequests: requests } = projection;
    if (rows === previousRows && requests === previousRequests && previousResult)
      return previousResult;
    const update = visibleTurnItemsRevision(rows);
    let result: Rows;
    if (
      previousResult &&
      previousRevision &&
      requests === previousRequests &&
      isSingleRowReplacement(previousRevision, update) &&
      update.index !== null
    ) {
      const row = rows[update.index]!;
      const next = projectRow(row);
      result =
        previousResult === previousRows && next === row
          ? rows
          : replaceVisibleTurnItem(previousResult, update.index, next);
    } else {
      byId = new Map(requests.map((request) => [request.id, request]));
      let projected: Rows[number][] | undefined;
      for (const [index, row] of rows.entries()) {
        const next = projectRow(row);
        if (next !== row) projected ??= rows.slice(0, index);
        projected?.push(next);
      }
      result = projected ?? rows;
    }
    previousRows = rows;
    previousRevision = update;
    previousRequests = requests;
    previousResult = result;
    return result;
  };
}
