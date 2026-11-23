import { agentMessagePreview } from "@t3tools/client-runtime/user-message";
import {
  getQuestionAnswerPreview,
  hasQuestionAnswer,
} from "@t3tools/client-runtime/work-log/user-input";
import type {
  OrchestrationV2TurnItemStatus,
  OrchestrationV2UserMessageInputIntent,
  UserInputAttachmentAnswerPayload,
} from "@t3tools/contracts";
import { replaceComposerContextReferences } from "@t3tools/shared/composerContextReferences";

export function resolveAgentMessagePresentation(props: {
  readonly text: string;
  readonly senderTitle?: string | null;
  readonly inputIntent?: OrchestrationV2UserMessageInputIntent;
  readonly status?: OrchestrationV2TurnItemStatus;
}) {
  const sender = props.senderTitle?.trim() || "another agent";
  const steer = props.inputIntent === "steer" || props.inputIntent === "promoted_queued_to_steer";
  const label = `${steer ? "Steer" : "Message"} from ${sender}`;
  const preview = agentMessagePreview(
    replaceComposerContextReferences(props.text, (reference) => reference.label),
  );
  const status =
    props.status &&
    props.status !== "completed" &&
    props.status !== "pending" &&
    props.status !== "waiting"
      ? props.status
      : null;
  return {
    label,
    preview,
    status,
    accessibilityLabel: [label, preview, status].filter(Boolean).join(": "),
  };
}

/**
 * The folded row for an `ask_user` answer. Without the question's card loaded,
 * the answer message's own text ("question\nanswer" blocks) gives the preview.
 */
export function resolveAnsweredQuestionPresentation(props: {
  readonly answer: UserInputAttachmentAnswerPayload | undefined;
  readonly text: string;
}) {
  const blocks = props.text.split(/\n{2,}/).filter((block) => block.trim());
  const questionCount =
    props.answer === undefined
      ? blocks.length
      : Object.keys(props.answer.questionTextById ?? props.answer.answers).length;
  const label = questionCount > 1 ? `Answered ${questionCount} questions` : "Answered question";
  const preview =
    props.answer !== undefined && hasQuestionAnswer(props.answer)
      ? getQuestionAnswerPreview(props.answer)
      : blocks
          .map((block) => block.split("\n").slice(1).join(" ").trim())
          .filter(Boolean)
          .join(" · ")
          .replace(/\s+/g, " ");
  return {
    label,
    preview,
    accessibilityLabel: [label, preview].filter(Boolean).join(": "),
  };
}
