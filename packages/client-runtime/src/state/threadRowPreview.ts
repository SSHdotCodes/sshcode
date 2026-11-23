/**
 * The second line of a chat row. While the agent works it is the agent's own latest words
 * in that run (cut to one plain line by the server), or the kind of step it is on when it
 * has said nothing yet. Otherwise it is how the chat's latest finished reply opens.
 */
export interface ThreadRowPreview {
  readonly text: string;
  /**
   * `step`: the kind of step the agent is on, or what it asks of the user. `note`: what a
   * working agent last said. `reply`: the opening of its latest finished reply.
   */
  readonly kind: "step" | "note" | "reply";
}

export function threadRowPreview(input: {
  /**
   * The chat's state in a few words ("Running tests", "Approve?"); null when it is neither
   * working nor asking.
   */
  readonly stepText: string | null;
  /** True when `stepText` asks something of the user: that outranks the agent's words. */
  readonly asking?: boolean;
  /**
   * How the agent's latest message opens: in the run it is working on, else in its latest
   * finished run. Servers that predate the first send nothing while the agent works.
   */
  readonly replyPreview: string | null | undefined;
}): ThreadRowPreview | null {
  const step = input.stepText?.trim();
  const reply = input.replyPreview?.trim();
  if (step && (input.asking || !reply)) return { text: step, kind: "step" };
  return reply ? { text: reply, kind: step ? "note" : "reply" } : null;
}
