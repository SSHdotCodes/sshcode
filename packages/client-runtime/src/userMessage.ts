import {
  type OrchestrationV2Actor,
  type OrchestrationV2CreationSource,
  ScheduledTaskId,
} from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";

const LEGACY_AUTOMATION_PREFIX = /^\[Triggered by schedule task: [^\r\n]+\]\r?\n\r?\n/;
const LEGACY_AUTOMATION_MESSAGE_ID = /^scheduled-task-message:(.+):\d+:(?:scheduled|manual)$/;

/**
 * Text and sender label for a user-role message. Older scheduled messages
 * stored their attribution in the prompt itself. Attachment-only bootstrap
 * prompts stay on the wire but have no user-facing body.
 */
export function resolveUserMessagePresentation(message: {
  readonly id?: string;
  readonly role: string;
  readonly text: string;
  readonly attachments?: ReadonlyArray<unknown> | undefined;
  readonly createdBy?: OrchestrationV2Actor;
  readonly creationSource?: OrchestrationV2CreationSource;
  readonly scheduledTaskId?: ScheduledTaskId;
}): {
  readonly text: string;
  /** Who sent a user-role message the user did not type. */
  readonly attribution: "automation" | "agent" | "t3code" | null;
  readonly scheduledTaskId: ScheduledTaskId | undefined;
} {
  if (message.role !== "user") {
    return { text: message.text, attribution: null, scheduledTaskId: undefined };
  }
  const text =
    (message.attachments?.length ?? 0) > 0 &&
    message.text.trim() === ATTACHMENT_ONLY_BOOTSTRAP_PROMPT
      ? ""
      : message.text;
  if (message.scheduledTaskId !== undefined) {
    return {
      text,
      attribution: "automation",
      scheduledTaskId: message.scheduledTaskId,
    };
  }
  const legacyPrefix = LEGACY_AUTOMATION_PREFIX.exec(text);
  const legacyTaskId = legacyPrefix
    ? LEGACY_AUTOMATION_MESSAGE_ID.exec(message.id ?? "")?.[1]
    : undefined;
  if (legacyPrefix !== null && (legacyTaskId !== undefined || message.createdBy === "agent")) {
    return {
      text: text.slice(legacyPrefix[0].length),
      attribution: "automation",
      scheduledTaskId: legacyTaskId === undefined ? undefined : ScheduledTaskId.make(legacyTaskId),
    };
  }
  return {
    text,
    // Restart continuations were sent as the agent before they became notices.
    attribution:
      message.createdBy !== "agent"
        ? null
        : message.creationSource === "server"
          ? "t3code"
          : "agent",
    scheduledTaskId: undefined,
  };
}

// Delegated tasks open with this role line (OrchestratorMcpService); the task follows it.
const DELEGATED_ROLE_PREAMBLE = /^Act as the [a-z]+ sub-agent for this task\.\s*/;
const AGENT_MESSAGE_PREVIEW_LENGTH = 240;

/** One line saying what an agent-sent message is about, for its collapsed row. */
export function agentMessagePreview(text: string): string {
  // The row shows one line, so a long message only needs its opening scanned.
  return (
    text
      .slice(0, AGENT_MESSAGE_PREVIEW_LENGTH * 8)
      .replace(DELEGATED_ROLE_PREAMBLE, "")
      // A heading runs into the line after it once flattened, so it ends with a colon.
      .replace(/^[ \t]*#{1,6}[ \t]+(.+)$/gm, (_, line: string) => {
        const heading = line.trimEnd();
        return /[.:!?]$/.test(heading) ? heading : `${heading}:`;
      })
      .replace(/^[ \t]*(?:>|[-*+]|\d+\.)[ \t]+/gm, "")
      .replace(/\*\*|`/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, AGENT_MESSAGE_PREVIEW_LENGTH)
  );
}
