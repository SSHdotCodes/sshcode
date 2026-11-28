import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import {
  isTeamBoardNoteMessageId,
  isTeamBoardNoteText,
  noticeSummary,
} from "@t3tools/shared/teamBoardNote";

/**
 * A chat's last message for the sidebar and hover cards. A team board note is never the
 * person's: it reads "Team board" whether its id survived (shells, turn items) or only its text
 * did (previews stored before this rule).
 */
export function threadMessagePreview(
  message:
    | (Pick<NonNullable<OrchestrationV2ThreadShell["latestVisibleMessage"]>, "role" | "text"> & {
        readonly id?: string;
      })
    | null,
): { readonly label: string; readonly text: string } | null {
  const text = message?.text.trim().replace(/\s+/g, " ");
  if (!message || !text) return null;
  if (
    message.role === "user" &&
    (isTeamBoardNoteMessageId(message.id ?? "") || isTeamBoardNoteText(text))
  )
    return { label: "Team board", text: noticeSummary(text).replace(/^Team board: /u, "") };
  return {
    label: message.role === "user" ? "You" : message.role === "assistant" ? "Agent" : "System",
    text: text.length > 480 ? `${text.slice(0, 480).trimEnd()}…` : text,
  };
}
