import type { ChatAttachment } from "@t3tools/contracts";
import { assistantCitationsToPlainText } from "@t3tools/shared/assistantCitations";

export type ThreadTitleMessage = {
  readonly role: "user" | "assistant" | "system" | "reasoning";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
};

const MAX_CONTEXT = 8_000;
const MAX_MESSAGE = 2_000;
const MAX_EXCERPT = 300;
const MAX_ASSISTANT_CONTEXT = 1_000;
const OMITTED = "[Earlier content truncated]\n\n";
const TRUNCATED = "\n[Content truncated]\n";

/** Keep the request and its final constraints when a message is too long. */
export function limitTitleMessage(text: string, budget: number): string {
  if (text.length <= budget) return text;
  if (budget <= TRUNCATED.length) return "";
  const available = budget - TRUNCATED.length;
  const head = Math.ceil(available / 2);
  const tail = available - head;
  return `${text.slice(0, head)}${TRUNCATED}${tail > 0 ? text.slice(-tail) : ""}`;
}

/** Reserve space for user intent before adding assistant findings, in conversation order. */
export function formatThreadTitleContext(messages: ReadonlyArray<ThreadTitleMessage>) {
  const sections = messages.flatMap((message, index) => {
    // Thinking traces are working notes, not what the thread is about, and they
    // dwarf the answer they precede. Titling on them would be worse and costlier.
    if (
      message.role === "system" ||
      message.role === "reasoning" ||
      (!message.text.trim() && !message.attachments?.length)
    )
      return [];
    return [{ index, message, prefix: `${message.role.toUpperCase()}:\n` }];
  });
  const formatted = new Map<number, string>();
  const contentsFor = (section: (typeof sections)[number]) => {
    const cached = formatted.get(section.index);
    if (cached !== undefined) return cached;
    const text = assistantCitationsToPlainText(section.message.text).trim();
    const names = section.message.attachments?.map((attachment) => attachment.name).join(", ");
    const contents = [text, ...(names ? [`[Attachments: ${names}]`] : [])]
      .filter(Boolean)
      .join("\n");
    formatted.set(section.index, contents);
    return contents;
  };
  const users = sections.filter((section) => section.message.role === "user");
  const samplingNotice = (shown: number) =>
    `[This thread has ${users.length} user messages; ${shown} are shown, picked across its whole history.]\n\n`;
  // Preserve the existing allocation when the full conversation already fits.
  let fullLength = -2;
  const longThread = sections.some((section) => {
    fullLength += section.prefix.length + contentsFor(section).length + 2;
    return fullLength > MAX_CONTEXT - OMITTED.length;
  });
  const selected = new Map<number, string>();
  let remaining = MAX_CONTEXT - OMITTED.length;
  const add = (section: (typeof sections)[number], budget: number) => {
    if (selected.has(section.index)) return;
    const limit = Math.min(budget, remaining) - section.prefix.length - 2;
    if (limit <= (longThread ? 0 : TRUNCATED.length)) return;
    const contents = limitTitleMessage(contentsFor(section), limit);
    if (!contents) return;
    const text = section.prefix + contents;
    selected.set(section.index, text);
    remaining -= text.length + 2;
  };

  const firstUser = users[0];
  if (longThread) {
    remaining = MAX_CONTEXT - samplingNotice(users.length).length - MAX_ASSISTANT_CONTEXT;
    const userLength = users.reduce(
      (length, section) => length + section.prefix.length + contentsFor(section).length + 2,
      0,
    );
    if (userLength <= remaining) {
      for (const section of users) add(section, remaining);
    } else {
      if (firstUser) add(firstUser, MAX_MESSAGE / 2);
      for (const section of users.slice(-2).toReversed()) add(section, MAX_MESSAGE / 2);

      // Fill evenly spaced slots, then spend any space left by shorter excerpts
      // on another pass across the remaining history.
      let candidates = users.filter(
        (section) => !selected.has(section.index) && contentsFor(section).length > 0,
      );
      while (candidates.length > 0) {
        const excerptSize = candidates.reduce(
          (size, section) =>
            Math.max(
              size,
              Math.min(MAX_EXCERPT, section.prefix.length + contentsFor(section).length + 2),
            ),
          0,
        );
        const count = Math.min(candidates.length, Math.floor(remaining / excerptSize));
        if (count === 0) break;
        for (let index = 0; index < count; index++) {
          add(candidates[Math.floor(((index + 0.5) * candidates.length) / count)]!, MAX_EXCERPT);
        }
        candidates = candidates.filter((section) => !selected.has(section.index));
      }
    }
    remaining += MAX_ASSISTANT_CONTEXT;
    for (const section of sections
      .filter((section) => section.message.role === "assistant")
      .slice(-2)
      .toReversed()) {
      add(section, MAX_ASSISTANT_CONTEXT / 2);
    }
  } else {
    if (firstUser) add(firstUser, MAX_MESSAGE);
    // Up to 6,000 characters go to user messages. Assistant output cannot evict them.
    for (const section of sections.toReversed()) {
      if (section.message.role === "user") {
        add(section, Math.min(MAX_MESSAGE, remaining - 2_000));
      }
    }
    for (const section of sections.toReversed()) {
      if (section.message.role === "assistant") add(section, MAX_MESSAGE);
    }
    // Use spare space when the conversation has only a few messages.
    for (const role of ["user", "assistant"] as const) {
      for (const section of sections.toReversed()) {
        const previous = selected.get(section.index);
        if (section.message.role !== role || previous === undefined) continue;
        const expanded =
          section.prefix +
          limitTitleMessage(
            contentsFor(section),
            previous.length + remaining - section.prefix.length,
          );
        remaining -= expanded.length - previous.length;
        selected.set(section.index, expanded);
      }
    }
  }
  const retained = sections.filter((section) => selected.has(section.index));
  const truncated = retained.some(
    (section) => selected.get(section.index) !== section.prefix + contentsFor(section),
  );
  const attachments = retained.flatMap((section) => section.message.attachments ?? []);
  const firstAttachment = firstUser?.message.attachments?.[0];
  const recentAttachments = attachments.filter(
    (attachment) => attachment.id !== firstAttachment?.id,
  );
  const marker =
    longThread && retained.length < sections.length
      ? samplingNotice(retained.filter((section) => section.message.role === "user").length)
      : truncated || retained.length < sections.length
        ? OMITTED
        : "";
  return {
    message: `${marker}${retained.map((section) => selected.get(section.index)).join("\n\n")}`,
    attachments: [
      ...(firstAttachment ? [firstAttachment] : []),
      ...recentAttachments.slice(firstAttachment ? -3 : -4),
    ],
  };
}
