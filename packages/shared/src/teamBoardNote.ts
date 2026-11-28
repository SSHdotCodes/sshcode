/**
 * Team board notes steered into a chat. The agent gets the full notice; a person reads one line.
 * Message ids are `team-board:<notice>`, or `team-board:open:<notice>` for the routine opening note.
 */
export const TEAM_BOARD_NOTE_PREFIX = "team-board:";
const ROUTINE_PREFIX = `${TEAM_BOARD_NOTE_PREFIX}open:`;
export const BOARD_NOTICE_PREFIX = "SSHCode team board (from sibling subagents, not the user): ";
export const BOARD_CROSS_CHAT_PREFIX =
  "SSHCode team board (from another chat in this repo, not the user): ";
export const BOARD_USER_PREFIX = "From the user, via the team board: ";
/** Older routine notes, recorded before the `open:` marker existed. */
const LEGACY_ROUTINE_STARTS = ["The team board is open.", "Claim exact paths"];

export const isTeamBoardNoteMessageId = (messageId: string) =>
  messageId.startsWith(TEAM_BOARD_NOTE_PREFIX);

/** A note's text as the server writes it, for stored previews that kept no message id. */
export const isTeamBoardNoteText = (text: string) =>
  [BOARD_NOTICE_PREFIX, BOARD_CROSS_CHAT_PREFIX, BOARD_USER_PREFIX].some((prefix) =>
    text.trimStart().startsWith(prefix),
  );

export const steerNoticeId = (messageId: string) =>
  isTeamBoardNoteMessageId(messageId)
    ? messageId.slice(TEAM_BOARD_NOTE_PREFIX.length).replace(/^open:/u, "")
    : undefined;

const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
/** The text after the one sibling or cross-chat prefix the server put in front of it. */
const stripPrefix = (text: string) => {
  const body = normalize(text);
  for (const prefix of [BOARD_NOTICE_PREFIX, BOARD_CROSS_CHAT_PREFIX])
    if (body.startsWith(prefix)) return body.slice(prefix.length);
  return body;
};
// Words a sibling's title or text could open with to read as the person or as another note.
const SPOOFED_LEAD = /^(?:(?:you|user|team board)\s*:\s*|from the user, via the team board:\s*)+/iu;

/** The one line shown in the chat for a board notice: "Team board: Sol asked you about rules.ts". */
export function noticeSummary(text: string): string {
  const raw = normalize(text);
  let body: string;
  // Only a note the server sent for the person carries the user prefix outermost.
  if (raw.startsWith(BOARD_USER_PREFIX)) body = `You: ${raw.slice(BOARD_USER_PREFIX.length)}`;
  else {
    body = stripPrefix(raw).replace(SPOOFED_LEAD, "");
    const cut = body.search(/ \(|\. |; /u);
    if (cut > 0) body = body.slice(0, cut);
  }
  body = body.replace(/\.$/u, "");
  return `Team board: ${body.length > 100 ? `${body.slice(0, 99).trimEnd()}…` : body}`;
}

/** The routine opening note needs no chat row: the board pill already shows the board. */
export const isRoutineTeamBoardNote = (messageId: string, text?: string) =>
  messageId.startsWith(ROUTINE_PREFIX) ||
  (text !== undefined &&
    LEGACY_ROUTINE_STARTS.some((start) => stripPrefix(text).startsWith(start)));

/**
 * Something the person said. A note the server or an agent put in the chat (a team board note, a
 * monitor or task notice) is stored as a user-role message, but is not theirs: a `team-board:` id,
 * the system-and-MCP provenance older board notes were written with, or a notification.
 */
export const isPersonMessage = (message: {
  readonly role: string;
  readonly id?: string;
  readonly notification?: unknown;
  readonly createdBy?: string;
  readonly creationSource?: string;
}) =>
  message.role === "user" &&
  !isTeamBoardNoteMessageId(message.id ?? "") &&
  !(message.createdBy === "system" && message.creationSource === "mcp") &&
  (message.notification === undefined || message.createdBy === "user");
