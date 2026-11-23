import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import type {
  DesktopNotificationResponse,
  EnvironmentId,
  OrchestrationV2ThreadProjection,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import { useCallback } from "react";

import { resolvePendingUserInputAnswer } from "../pendingUserInput";
import { randomUUID } from "../lib/utils";
import { notificationThreadProjection } from "../state/notificationRequests";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { getClientSettings } from "./useSettings";
import { hasDesktopNotifications } from "../threadNotifications";

export interface ThreadNotificationHandle {
  readonly tag: string;
  readonly close: () => void;
}

function notificationRequest(
  projection: OrchestrationV2ThreadProjection,
  requestId: RuntimeRequestId,
) {
  const pending = derivePendingThreadRequests(projection);
  const approval = pending.approvals.find((request) => request.requestId === requestId);
  if (approval?.responseCapability === "live") {
    return {
      type: "approval" as const,
      body: approval.detail,
      actions: [
        { label: "Approve", decision: "accept" as const },
        { label: "Decline", decision: "decline" as const },
      ].filter(
        (action) =>
          approval.options === undefined ||
          approval.options.some((option) => option.decision === action.decision),
      ),
      hasReply: false,
    };
  }
  const input = pending.userInputs.find((request) => request.requestId === requestId);
  const question = input?.questions[0];
  if (!input || input.responseCapability === "not_resumable" || !question) return null;
  const canAnswer = input.questions.length === 1 && !question.multiSelect;
  return {
    type: "question" as const,
    body: input.questions.map((question) => question.question).join("\n\n"),
    question,
    actions: canAnswer
      ? question.options.toSorted(
          (a, b) =>
            Number(b.label.endsWith("(Recommended)")) - Number(a.label.endsWith("(Recommended)")),
        )
      : [],
    hasReply: canAnswer && question.allowCustomAnswer !== false,
  };
}

/** A native alert retains its request identity; each response checks a fresh projection. */
export function useThreadNativeNotification() {
  const loadProjection = useAtomCommand(notificationThreadProjection, { reportFailure: false });
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const respondToUserInput = useOrchestrationCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });

  return useCallback(
    ({
      environmentId,
      threadId,
      requestId,
      title,
      body,
      onNotification,
      openChat,
    }: {
      environmentId: EnvironmentId;
      threadId: ThreadId;
      requestId: RuntimeRequestId | undefined;
      title: string;
      body: string;
      onNotification: (
        environmentId: EnvironmentId,
        notification: ThreadNotificationHandle,
      ) => () => void;
      openChat: () => void;
    }) => {
      const bridge = window.desktopBridge;
      if (
        bridge?.getClientPlatform?.() !== "darwin" ||
        !bridge.showNotification ||
        !bridge.closeNotification ||
        !bridge.onNotificationResponse
      )
        return false;

      const id = randomUUID();
      const tag = `${environmentId}:${threadId}`;
      let closed = false;
      let fallback: Notification | undefined;
      let unsubscribe: (() => void) | undefined;
      let remove: (() => void) | undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe?.();
        fallback?.close();
        void bridge.closeNotification!(id).catch(() => undefined);
        remove?.();
      };
      remove = onNotification(environmentId, { tag, close });

      const fetchRequest = async () => {
        if (!requestId) return null;
        const result = await loadProjection({ environmentId, input: { threadId } });
        return result._tag === "Success" ? notificationRequest(result.value, requestId) : null;
      };
      const respond = async (
        response: DesktopNotificationResponse,
        original: ReturnType<typeof notificationRequest>,
      ) => {
        if (response.type === "click") {
          openChat();
          return;
        }
        const open = () => {
          void bridge.focusNotificationWindow?.().catch(() => undefined);
          openChat();
        };
        try {
          const current = await fetchRequest();
          if (!current || !original || !requestId || current.type !== original.type) {
            open();
            return;
          }
          if (
            current.type === "approval" &&
            original.type === "approval" &&
            response.type === "action"
          ) {
            const decision = original.actions[response.actionIndex]?.decision;
            if (!decision || !current.actions.some((action) => action.decision === decision)) {
              open();
              return;
            }
            const result = await respondToApproval({
              environmentId,
              input: { threadId, requestId, decision },
            });
            if (result._tag !== "Success") open();
            return;
          }
          if (
            current.type === "question" &&
            original.type === "question" &&
            current.question.id === original.question.id
          ) {
            const option =
              response.type === "action" ? original.actions[response.actionIndex] : undefined;
            if (
              (response.type === "reply" && !current.hasReply) ||
              (response.type === "action" && (!option || current.actions.length === 0))
            ) {
              open();
              return;
            }
            const answer = resolvePendingUserInputAnswer(
              current.question,
              response.type === "reply"
                ? { customAnswer: response.reply }
                : { selectedOptionValues: option ? [option.value ?? option.label] : [] },
            );
            if (answer === null) {
              open();
              return;
            }
            const result = await respondToUserInput({
              environmentId,
              input: { threadId, requestId, answers: { [current.question.id]: answer } },
            });
            if (result._tag !== "Success") open();
            return;
          }
          open();
        } catch {
          open();
        }
      };
      const show = async () => {
        let request: ReturnType<typeof notificationRequest> = null;
        try {
          request = await fetchRequest();
        } catch {
          // A plain alert can still open the chat when its details cannot be loaded.
        }
        if (closed) return;
        unsubscribe = bridge.onNotificationResponse!((response) => {
          if (response.id !== id || closed) return;
          close();
          void respond(response, request);
        });
        let shown = false;
        try {
          shown = await bridge.showNotification!({
            id,
            tag,
            title,
            body: request?.body ?? body,
            actions: request?.actions.map((action) => action.label) ?? [],
            hasReply: request?.hasReply ?? false,
          });
        } catch {
          // Older or unsupported desktop builds keep the web notification path.
        }
        if (closed || shown) return;
        unsubscribe();
        unsubscribe = undefined;
        if (
          !hasDesktopNotifications(getClientSettings().notificationMode) ||
          (document.visibilityState === "visible" && document.hasFocus()) ||
          typeof Notification === "undefined" ||
          Notification.permission !== "granted"
        ) {
          close();
          return;
        }
        try {
          fallback = new Notification(title, { body, tag, silent: true });
          fallback.addEventListener("click", () => {
            close();
            openChat();
          });
        } catch {
          close();
        }
      };
      void show();
      return true;
    },
    [loadProjection, respondToApproval, respondToUserInput],
  );
}
